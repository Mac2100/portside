// ─── Detail Panel ─────────────────────────────────────────────────────────────
const ACTION_VERB = { start:['Start','Starting','Started'], stop:['Stop','Stopping','Stopped'], restart:['Restart','Restarting','Restarted'], remove:['Remove','Removing','Removed'], pause:['Pause','Pausing','Paused'] };
// Run a container action with immediate feedback: confirm (for disruptive ones), a "…ing" toast, busy button, then result.
async function runContainerAction(id, action, name, btn) {
  const v = ACTION_VERB[action] || [action, action + '…', action + 'ed'];

  // Remove is irreversible — two dialogs, different wording, so it can't be
  // clicked through on autopilot.
  if (action === 'remove') {
    const ok = confirmDestructive(
      `Remove container "${name}"?`,
      'The container is deleted — its config, ports and logs go with it. Data in volumes and bind mounts is kept.',
      `Delete "${name}".`
    );
    if (!ok) return false;
  } else if ((action === 'stop' || action === 'restart') && !confirm(`${v[0]} container "${name}"?`)) {
    return false;
  }
  if (btn) btn.disabled = true;
  toast(`${v[1]} ${name}…`, 'info');
  const r = await api.docker.action({ ...state.config, id, action });
  if (r.ok) { toast(`${v[2]} ${name} ✓`, 'success'); return true; }
  toast(r.error || `${v[0]} failed`, 'error');
  if (btn) btn.disabled = false;
  return false;
}

async function openDetail(id) {
  const c = state.containers.find(x => x.Id === id);
  if (!c) return;
  state.selectedContainer = c;

  const name = sanitizeName(c.Names && c.Names[0]);
  const sc = statusClass(c.Status);
  $('detail-title').textContent = name;
  $('detail-status-badge').className = `status-badge ${sc}`;
  $('detail-status-badge').textContent = c.State || sc;

  // Actions
  const acts = $('detail-actions');
  if (sc === 'running') {
    acts.innerHTML = `
      <button class="btn btn-warn" data-action="stop" data-id="${id}">■ Stop</button>
      <button class="btn btn-icon" data-action="restart" data-id="${id}">↻ Restart</button>`;
  } else {
    acts.innerHTML = `<button class="btn btn-success" data-action="start" data-id="${id}">▶ Start</button>`;
  }
  acts.innerHTML += `<button class="btn" id="detail-edit-btn" title="Edit ports, volumes, env, image…">✎ Edit</button>`;
  acts.innerHTML += `<button class="btn" id="detail-customize-btn" title="Nickname, color, icon & group">🎨 Customize</button>`;
  acts.innerHTML += `<button class="btn" id="detail-export-btn" title="Export as compose.yml or docker run — so you can rebuild this container anywhere">📦 Export</button>`;
  acts.innerHTML += `<button class="btn btn-danger" data-action="remove" data-id="${id}">✕ Remove</button>`;
  acts.innerHTML += `<button class="btn" id="detail-gitdeploy-btn" title="Pull latest from GitHub & restart">⬆ Deploy</button>`;

  acts.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const ok = await runContainerAction(id, action, name, btn);
      if (ok) {
        if (action === 'remove') closeDetail();
        setTimeout(loadDashboard, 1500);
      }
    });
  });

  const gd = $('detail-gitdeploy-btn');
  if (gd) gd.onclick = () => openGitDeploy(id, name);
  const eb = $('detail-edit-btn');
  if (eb) eb.onclick = () => openEditContainer(id);
  const cb = $('detail-customize-btn');
  if (cb) cb.onclick = () => openCustomize(name);
  const xb = $('detail-export-btn');
  if (xb) xb.onclick = () => openExport(id);

  // Info section
  const ports = (c.Ports || []).filter(p => p.PublicPort).map(p => `${p.IP || '0.0.0.0'}:${p.PublicPort} → ${p.PrivatePort}/${p.Type || 'tcp'}`);
  $('detail-info').innerHTML = `
    <div class="detail-section-title">Info</div>
    <div class="detail-row"><span class="detail-label">Image</span><span class="detail-value font-mono">${c.Image}</span></div>
    <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value font-mono" style="font-size:10px">${id.slice(0,24)}</span></div>
    <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${fmtTime(c.Created)}</span></div>
    <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">${c.Status}</span></div>
    <div class="detail-row"><span class="detail-label">Compose</span><span class="detail-value">${(c.Labels && c.Labels['com.docker.compose.project']) || '—'}</span></div>
  `;

  if (ports.length) {
    $('detail-ports-section').style.display = '';
    const pubPorts = (c.Ports || []).filter(p => p.PublicPort);
    $('detail-ports').innerHTML = ports.map((p, i) => {
      const pub = pubPorts[i];
      return `<div class="detail-row"><span class="detail-value font-mono crumb" style="font-size:11px" data-wport="${pub ? pub.PublicPort : ''}" title="Open in browser">${p} ↗</span></div>`;
    }).join('');
    $('detail-ports').querySelectorAll('[data-wport]').forEach(el =>
      el.addEventListener('click', () => { if (el.dataset.wport) api.openUrl(`http://${state.config.host}:${el.dataset.wport}`); }));
  } else {
    $('detail-ports-section').style.display = 'none';
  }

  // Logs button
  $('detail-logs-btn').onclick = () => openLogs(id, name);

  $('detail-panel').classList.add('open');

  // Stats
  if (sc === 'running') loadDetailStats(id);
}

async function loadDetailStats(id) {
  const r = await api.docker.stats({ ...state.config, id });
  if (!r.ok || !r.data) return;
  const s = r.data;

  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage.total_usage || 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || 1;
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  const memUsed = s.memory_stats.usage - (s.memory_stats.stats?.cache || 0);
  const memLimit = s.memory_stats.limit;
  const memPct = memLimit > 0 ? (memUsed / memLimit) * 100 : 0;

  $('detail-cpu-val').textContent = cpu.toFixed(2) + '%';
  $('detail-cpu-bar').style.width = Math.min(cpu, 100) + '%';
  $('detail-cpu-bar').className = 'stat-gauge-fill' + (cpu > 80 ? ' warn' : '');

  $('detail-mem-val').textContent = memPct.toFixed(1) + '%';
  $('detail-mem-bar').style.width = Math.min(memPct, 100) + '%';
  $('detail-mem-bar').className = 'stat-gauge-fill' + (memPct > 85 ? ' warn' : '');

  $('detail-mem-used').textContent = `${fmt(memUsed)} / ${fmt(memLimit)}`;
  $('detail-mem-abs').style.width = Math.min(memPct, 100) + '%';

  // Network
  const nets = s.networks || {};
  const netRx = Object.values(nets).reduce((a, n) => a + (n.rx_bytes || 0), 0);
  const netTx = Object.values(nets).reduce((a, n) => a + (n.tx_bytes || 0), 0);
  $('detail-net').textContent = `↓${fmt(netRx)} / ↑${fmt(netTx)}`;

  const blkRead = (s.blkio_stats?.io_service_bytes_recursive || []).filter(x => x.op === 'Read').reduce((a, x) => a + x.value, 0);
  const blkWrite = (s.blkio_stats?.io_service_bytes_recursive || []).filter(x => x.op === 'Write').reduce((a, x) => a + x.value, 0);
  $('detail-block').textContent = `R:${fmt(blkRead)} W:${fmt(blkWrite)}`;

  $('detail-pids').textContent = s.pids_stats?.current || '—';
}

function closeDetail() {
  $('detail-panel').classList.remove('open');
  state.selectedContainer = null;
}
$('detail-close-btn').addEventListener('click', closeDetail);

