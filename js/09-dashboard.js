// ─── Dashboard: Metrics & Insights ────────────────────────────────────────────
function computeContainerStats(s, ncpuFallback) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage.total_usage || 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage || []).length || ncpuFallback || 1;
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  const memUsed = (s.memory_stats.usage || 0) - (s.memory_stats.stats?.cache || 0);
  const memPct = s.memory_stats.limit > 0 ? (memUsed / s.memory_stats.limit) * 100 : 0;
  const nets = s.networks || {};
  const rx = Object.values(nets).reduce((a, n) => a + (n.rx_bytes || 0), 0);
  const tx = Object.values(nets).reduce((a, n) => a + (n.tx_bytes || 0), 0);
  return { cpu, memUsed, memPct, rx, tx };
}

async function loadDashboard() {
  if (!state.config.host) return;
  const conn = await api.docker.info(state.config);
  if (conn.ok) {
    setConnected(true);
    const info = state.hostInfo = conn.data;
    $('info-docker-ver').textContent = info.ServerVersion || '—';
    $('info-cpus').textContent = info.NCPU || '—';
    $('info-mem').textContent = fmt(info.MemTotal);
    $('info-os').textContent = info.OperatingSystem || '—';
    $('info-host').textContent = info.Name || '—';
    $('docker-info-strip').style.display = '';
    $('docker-version-label').textContent = `Docker ${info.ServerVersion} • ${info.Name}`;
  } else {
    setConnected(false);
    return;
  }

  const r = await api.docker.containers(state.config);
  if (!r.ok) return;
  state.containers = r.data || [];
  const running = state.containers.filter(c => (c.State || '').toLowerCase() === 'running');
  $('nav-running-count').textContent = running.length;

  const [ir, vr, nr] = await Promise.all([
    api.docker.images(state.config),
    api.docker.volumes(state.config),
    api.docker.networks(state.config)
  ]);
  if (ir.ok) { state.images = ir.data || []; $('nav-images-count').textContent = state.images.length; }
  if (vr.ok) { state.volumes = (vr.data && vr.data.Volumes) || []; $('nav-volumes-count').textContent = state.volumes.length; }
  if (nr.ok) { state.networks = nr.data || []; $('nav-networks-count').textContent = state.networks.length; }

  // Notify if a previously-running container stopped. A non-zero exit code means
  // it fell over rather than being asked to stop — that's a different event, and
  // people want to hear about it separately.
  const runningIds = new Set(running.map(c => c.Id));
  if (state.prevRunningIds) {
    for (const id of state.prevRunningIds) {
      if (runningIds.has(id)) continue;
      const c = state.containers.find(x => x.Id === id);
      if (!c) continue;
      const nm = sanitizeName(c.Names && c.Names[0]);
      const exit = /Exited \((\d+)\)/.exec(c.Status || '');
      if (exit && exit[1] !== '0') {
        notify('crashed', `${nm} crashed — exit code ${exit[1]}`);
        // Grab the logs NOW: if this container gets recreated, they're gone.
        captureCrashLog(c, exit[1]);
      } else {
        notify('stopped', `${nm} stopped — ${c.Status || ''}`);
      }
    }
  }
  state.prevRunningIds = runningIds;

  // Newly unhealthy / newly looping — edge-triggered, so a container that stays
  // unhealthy doesn't notify on every poll.
  const unhealthyNow = new Set(state.containers.filter(c => /\(unhealthy\)/i.test(c.Status || '')).map(c => c.Id));
  const loopingNow = new Set(state.containers.filter(c => /restarting/i.test(c.State || '')).map(c => c.Id));
  const nameOfId = id => {
    const c = state.containers.find(x => x.Id === id);
    return c ? sanitizeName(c.Names && c.Names[0]) : id.slice(0, 12);
  };
  if (state.prevUnhealthy)
    for (const id of unhealthyNow)
      if (!state.prevUnhealthy.has(id)) notify('unhealthy', `${nameOfId(id)} is unhealthy — its health check is failing`);
  if (state.prevLooping)
    for (const id of loopingNow)
      if (!state.prevLooping.has(id)) notify('restartLoop', `${nameOfId(id)} is in a restart loop — it keeps dying and Docker keeps restarting it`);
  state.prevUnhealthy = unhealthyNow;
  state.prevLooping = loopingNow;

  // Per-container stats in parallel → aggregate to host level
  const info = state.hostInfo || {};
  const ncpu = info.NCPU || 1;
  const now = Date.now();
  const statsResults = await Promise.all(running.map(async c => {
    const res = await api.docker.stats({ ...state.config, id: c.Id });
    return { c, s: (res.ok && res.data && res.data.cpu_stats) ? res.data : null };
  }));

  let cpuSum = 0, memSum = 0, rxSum = 0, txSum = 0;
  const per = [];
  for (const { c, s } of statsResults) {
    if (!s) continue;
    const m = computeContainerStats(s, ncpu);
    cpuSum += m.cpu; memSum += m.memUsed; rxSum += m.rx; txSum += m.tx;

    // Per-container net/disk rates from deltas
    const blk = (s.blkio_stats?.io_service_bytes_recursive || []).reduce((a, x) => a + (x.value || 0), 0);
    const prev = state.prevPerIO[c.Id];
    let netRate = 0, blkRate = 0;
    if (prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0.5) {
        netRate = Math.max(0, ((m.rx + m.tx) - prev.net) / dt);
        blkRate = Math.max(0, (blk - prev.blk) / dt);
      }
    }
    state.prevPerIO[c.Id] = { net: m.rx + m.tx, blk, t: now };

    per.push({ id: c.Id, name: sanitizeName(c.Names && c.Names[0]), cpu: m.cpu, mem: m.memUsed, memPct: m.memPct, netRate, blkRate });
  }
  state.lastPer = per;

  // Inspect running containers every 60s (restart counts, health checks)
  if (now - state.inspectFetched > 60000 && running.length) {
    state.inspectFetched = now;
    Promise.all(running.map(c =>
      api.docker.inspect({ ...state.config, id: c.Id }).then(r => [c.Id, r.ok ? r.data : null]).catch(() => [c.Id, null])
    )).then(entries => {
      state.inspectCache = Object.fromEntries(entries.filter(e => e[1]));
      renderInsights(state.lastPer);
    });
  }

  const hostCpu = Math.min(cpuSum / ncpu, 100);
  const memTotal = info.MemTotal || 0;
  const hostMem = memTotal > 0 ? (memSum / memTotal) * 100 : 0;

  // Network rates (delta between refreshes)
  let rxRate = 0, txRate = 0;
  if (state.prevNet) {
    const dt = (now - state.prevNet.time) / 1000;
    if (dt > 0.5) {
      rxRate = Math.max(0, (rxSum - state.prevNet.rx) / dt);
      txRate = Math.max(0, (txSum - state.prevNet.tx) / dt);
    }
  }
  state.prevNet = { rx: rxSum, tx: txSum, time: now };

  // Rolling history (last 120 samples) + persist to disk for 24h/7d views
  const H = state.history;
  H.t.push(now); H.cpu.push(hostCpu); H.mem.push(hostMem); H.rx.push(rxRate); H.tx.push(txRate);
  if (H.t.length > 120) { H.t.shift(); H.cpu.shift(); H.mem.shift(); H.rx.shift(); H.tx.shift(); }
  api.history.append({ t: now, cpu: hostCpu, mem: hostMem, rx: rxRate, tx: txRate, host: state.config.host });

  // Rings + cards
  setRing('ring-cpu', hostCpu);
  $('metric-cpu-val').textContent = hostCpu.toFixed(1) + '%';
  $('metric-cpu-sub').textContent = `${ncpu} cores • ${running.length} active`;
  setRing('ring-mem', hostMem);
  $('metric-mem-val').textContent = fmt(memSum);
  $('metric-mem-sub').textContent = 'of ' + fmt(memTotal);
  const contPct = state.containers.length ? (running.length / state.containers.length) * 100 : 0;
  setRing('ring-cont', contPct, `${running.length}/${state.containers.length}`, true);
  $('metric-cont-val').textContent = `${running.length} of ${state.containers.length}`;
  $('metric-cont-sub').textContent = `${state.containers.length - running.length} stopped`;
  $('metric-net-val').textContent = `↓${fmt(rxRate)}/s ↑${fmt(txRate)}/s`;

  // Charts
  $('chart-cpu-now').textContent = hostCpu.toFixed(1) + '%';
  $('chart-mem-now').textContent = `${hostMem.toFixed(1)}% (${fmt(memSum)})`;
  $('chart-net-now').textContent = `↓${fmt(rxRate)}/s ↑${fmt(txRate)}/s`;
  drawAllCharts();

  // Disk usage via /system/df (refreshed every 60s; can be slow on QNAP)
  if (now - state.dfFetched > 60000) {
    state.dfFetched = now;
    api.docker.df(state.config).then(d => {
      if (d.ok) { state.df = d.data; renderInsights(per); }
    }).catch(() => {});
  }

  renderTopLists(per);
  renderInsights(per);
  $('last-refresh').textContent = '• updated ' + new Date().toLocaleTimeString();

  // Feed the menu bar companion popover
  api.tray.update({
    cfg: { host: state.config.host, port: state.config.port },
    cpu: hostCpu,
    memPct: hostMem,
    memStr: fmt(memSum),
    running: running.length,
    total: state.containers.length,
    alerts: state.alertCount || 0,
    history: H.cpu.slice(-40),
    theme: state.config.theme || 'system',
    logo: state.config.logo || 'teal',
    containers: state.containers.slice(0, 30).map(c => {
      const p = per.find(x => x.id === c.Id);
      return {
        id: c.Id,
        name: sanitizeName(c.Names && c.Names[0]),
        state: (c.State || '').toLowerCase(),
        cpu: p ? p.cpu : null
      };
    })
  });
}

// ─── Top consumer lists ───────────────────────────────────────────────────────
function renderTopLists(per) {
  const mk = (list, valOf, fmtv, max, hotAt) => list.slice(0, 5).map(p => {
    const v = valOf(p);
    const pct = max > 0 ? Math.min((v / max) * 100, 100) : 0;
    return `<div class="top-row" data-cid="${p.id}">
      <span class="top-name truncate">${p.name}</span>
      <div class="top-bar"><div class="top-bar-fill${hotAt && v > hotAt ? ' hot' : ''}" style="width:${pct}%"></div></div>
      <span class="top-val">${fmtv(p)}</span>
    </div>`;
  }).join('') || '<div style="padding:8px 0;color:var(--text-muted);font-size:11px">No running containers</div>';

  const byCpu = [...per].sort((a, b) => b.cpu - a.cpu);
  $('top-cpu-list').innerHTML = mk(byCpu, p => p.cpu, p => p.cpu.toFixed(1) + '%', Math.max(byCpu[0]?.cpu || 1, 10), 80);
  const byMem = [...per].sort((a, b) => b.mem - a.mem);
  $('top-mem-list').innerHTML = mk(byMem, p => p.mem, p => fmt(p.mem), byMem[0]?.mem || 1, Infinity);

  document.querySelectorAll('#top-cpu-list .top-row, #top-mem-list .top-row').forEach(r =>
    r.addEventListener('click', () => openDetail(r.dataset.cid)));
}

// ─── Ring gauges ──────────────────────────────────────────────────────────────
function setRing(id, pct, label, invertColor) {
  const el = $(id);
  pct = Math.max(0, Math.min(pct || 0, 100));
  const R = 28, C = 2 * Math.PI * R;
  if (!el.dataset.init) {
    el.innerHTML = `<svg width="64" height="64" viewBox="0 0 64 64">
      <circle class="ring-track" cx="32" cy="32" r="${R}"/>
      <circle class="ring-fill" cx="32" cy="32" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>
    </svg><div class="ring-label"></div>`;
    el.dataset.init = '1';
  }
  const fill = el.querySelector('.ring-fill');
  fill.style.stroke = invertColor ? '#3fb950' : (pct < 60 ? '#3fb950' : pct < 80 ? '#d29922' : '#f85149');
  fill.style.strokeDashoffset = C * (1 - pct / 100);
  el.querySelector('.ring-label').textContent = label !== undefined ? label : pct.toFixed(0) + '%';
}

// ─── Chart ranges (Live / 24h / 7d) ───────────────────────────────────────────
state.chartRange = 'live';

async function drawAllCharts() {
  let cpu, mem, rx, tx, t;
  if (state.chartRange === 'live') {
    ({ cpu, mem, rx, tx, t } = state.history);
  } else {
    const ms = state.chartRange === '24h' ? 86400e3 : 7 * 86400e3;
    const h = await api.history.get({ ms, host: state.config.host });
    cpu = h.cpu; mem = h.mem; rx = h.rx; tx = h.tx; t = h.t;
  }
  drawChart('chart-cpu', [{ data: cpu, color: '#58a6ff' }], 100, { times: t, kind: 'pct' });
  drawChart('chart-mem', [{ data: mem, color: '#bc8cff' }], 100, { times: t, kind: 'pct' });
  drawChart('chart-net', [{ data: rx, color: '#3fb950' }, { data: tx, color: '#d29922' }], null, { times: t, kind: 'rate' });
}

function timeLabel(t) {
  if (!t) return '';
  const d = new Date(t);
  const hm = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  if (state.chartRange === '7d') return (d.getMonth() + 1) + '/' + d.getDate();
  if (state.chartRange === '24h') return hm;
  return hm + ':' + String(d.getSeconds()).padStart(2, '0');
}

document.querySelectorAll('#range-picker .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    state.chartRange = b.dataset.range;
    document.querySelectorAll('#range-picker .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    drawAllCharts();
  }));

// ─── Canvas charts ────────────────────────────────────────────────────────────
const chartState = {};
function fmtChartVal(v, kind) {
  if (kind === 'rate') return fmt(v) + '/s';
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + '%';
}

function drawChart(id, series, fixedMax, opts = {}) {
  const cv = $(id);
  if (!cv) return;
  chartState[id] = { series, fixedMax, opts };
  renderChart(id);
  if (!cv._hoverWired) {
    cv._hoverWired = true;
    cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); renderChart(id, e.clientX - r.left); });
    cv.addEventListener('mouseleave', () => renderChart(id));
  }
}

function renderChart(id, hoverX) {
  const st = chartState[id]; if (!st) return;
  const { series, fixedMax, opts } = st;
  const kind = opts.kind || 'pct', times = opts.times || [];
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 400, h = cv.clientHeight || 110;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const allVals = series.flatMap(s => s.data);
  if (!allVals.length) return;
  const max = fixedMax || Math.max(...allVals, 1) * 1.25;
  const padL = 40, padR = 10, padT = 6, padB = 16;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const muted = (getComputedStyle(document.body).getPropertyValue('--text-muted') || '#8b949e').trim();
  ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';

  // Gridlines + value axis (left)
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const rows = 4;
  for (let i = 0; i <= rows; i++) {
    const y = padT + (plotH * i) / rows;
    ctx.strokeStyle = 'rgba(140,150,165,0.13)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(fmtChartVal(max * (1 - i / rows), kind), padL - 5, y);
  }

  const primary = series[0].data;
  const n = Math.max(primary.length, 30);
  const step = plotW / (n - 1);
  const x0 = padL + plotW - (primary.length - 1) * step;
  const xOf = i => x0 + i * step;
  const yOf = v => padT + plotH - (Math.min(v, max) / max) * plotH;

  for (const s of series) {
    const data = s.data;
    if (data.length < 2) continue;
    ctx.beginPath();
    data.forEach((v, i) => { const x = xOf(i); i === 0 ? ctx.moveTo(x, yOf(v)) : ctx.lineTo(x, yOf(v)); });
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(xOf(data.length - 1), padT + plotH); ctx.lineTo(xOf(0), padT + plotH); ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    g.addColorStop(0, s.color + '4d'); g.addColorStop(1, s.color + '00');
    ctx.fillStyle = g; ctx.fill();
  }

  // Time axis (bottom)
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const tickN = 4;
  for (let i = 0; i <= tickN; i++) {
    const di = Math.round((primary.length - 1) * i / tickN);
    const lbl = i === tickN ? 'now' : timeLabel(times[di]);
    if (lbl) ctx.fillText(lbl, Math.max(padL + 14, Math.min(xOf(di), padL + plotW - 14)), h - padB + 3);
  }

  // Hover crosshair + tooltip
  if (hoverX != null && hoverX >= padL - 6 && hoverX <= padL + plotW + 6 && primary.length) {
    const idx = Math.max(0, Math.min(primary.length - 1, Math.round((hoverX - x0) / step)));
    const hx = xOf(idx);
    ctx.strokeStyle = 'rgba(140,150,165,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH); ctx.stroke();
    series.forEach(s => { if (s.data[idx] != null) { ctx.beginPath(); ctx.arc(hx, yOf(s.data[idx]), 2.6, 0, 7); ctx.fillStyle = s.color; ctx.fill(); } });
    const lines = series.map((s, si) => (series.length > 1 ? (si === 0 ? '↓ ' : '↑ ') : '') + fmtChartVal(s.data[idx] || 0, kind));
    const tstr = times[idx] ? new Date(times[idx]).toLocaleTimeString() : '';
    const rowsTxt = [tstr, ...lines].filter(Boolean);
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.textBaseline = 'top';
    const bw = Math.max(...rowsTxt.map(l => ctx.measureText(l).width)) + 12;
    const bh = rowsTxt.length * 13 + 7;
    let bx = hx + 9; if (bx + bw > padL + plotW) bx = hx - bw - 9;
    const by = padT + 2;
    ctx.fillStyle = 'rgba(20,24,32,0.92)';
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5); ctx.fill(); } else ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'left';
    rowsTxt.forEach((l, li) => ctx.fillText(l, bx + 6, by + 4 + li * 13));
  }
}

