// ─── Multi-select ─────────────────────────────────────────────────────────────
// A checkbox on every card/row. Selection lives in state (not the DOM) so it
// survives the auto-refresh re-render. Selecting is the only way to act on many
// containers at once without confirming each one.
state.selection = new Set();

const selCheckbox = id =>
  `<input type="checkbox" class="sel-box" data-sel="${id}"${state.selection.has(id) ? ' checked' : ''}
     title="Select for bulk actions" onclick="event.stopPropagation()">`;

function wireSelection(el) {
  el.querySelectorAll('[data-sel]').forEach(cb =>
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.sel;
      if (cb.checked) state.selection.add(id); else state.selection.delete(id);
      cb.closest('.gcard, tr')?.classList.toggle('selected', cb.checked);
      renderSelectionBar();
    }));
}

function renderSelectionBar() {
  const bar = $('bulk-bar');
  const n = state.selection.size;
  bar.style.display = n ? '' : 'none';
  if (!n) return;
  $('bulk-count').textContent = `${n} selected`;
}

function clearSelection() {
  state.selection = new Set();
  document.querySelectorAll('.sel-box').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.gcard.selected, tr.selected').forEach(n => n.classList.remove('selected'));
  renderSelectionBar();
}

// Only act on the containers the action makes sense for — starting a running
// container is a no-op that Docker would happily 304 on, but it muddles the count.
function selectedFor(action) {
  const ids = [...state.selection];
  const cs = ids.map(id => state.containers.find(c => c.Id === id)).filter(Boolean);
  const running = c => (c.State || '').toLowerCase() === 'running';
  if (action === 'start') return cs.filter(c => !running(c)).map(c => c.Id);
  if (action === 'stop') return cs.filter(c => running(c)).map(c => c.Id);
  return cs.map(c => c.Id);
}

['start', 'stop', 'restart', 'remove'].forEach(action =>
  $('bulk-' + action).addEventListener('click', async () => {
    const ids = selectedFor(action);
    if (!ids.length) return toast(`Nothing in the selection to ${action}`, 'info');
    await runBulkAction(ids, action, '');
    clearSelection();
  }));

$('bulk-clear').addEventListener('click', clearSelection);

// ─── Container Table ──────────────────────────────────────────────────────────
function renderContainerTable(targetId, containers) {
  const el = $(targetId);
  if (!containers || !containers.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">◫</div><div class="empty-title">No containers</div></div>`;
    return;
  }

  const rows = containers.map(c => {
    const name = sanitizeName(c.Names && c.Names[0]);
    const sc = statusClass(c.Status);
    const ports = (c.Ports || [])
      .filter(p => p.PublicPort)
      .map(p => `${p.PublicPort}→${p.PrivatePort}`)
      .join(', ');
    const image = (c.Image || '').split(':')[0].split('/').pop();
    const statsHtml = sc === 'running'
      ? `<td><div class="mini-bar-container"><div class="mini-bar"><div class="mini-bar-fill" id="bar-cpu-${c.Id.slice(0,12)}" style="width:0%"></div></div><span class="mini-bar-value" id="val-cpu-${c.Id.slice(0,12)}">…</span></div></td>
         <td><div class="mini-bar-container"><div class="mini-bar"><div class="mini-bar-fill" id="bar-mem-${c.Id.slice(0,12)}" style="width:0%"></div></div><span class="mini-bar-value" id="val-mem-${c.Id.slice(0,12)}">…</span></div></td>`
      : `<td><span class="text-muted">—</span></td><td><span class="text-muted">—</span></td>`;

    return `<tr data-id="${c.Id}" data-name="${name}" class="${state.selection.has(c.Id) ? 'selected' : ''}">
      <td class="sel-cell">${selCheckbox(c.Id)}</td>
      <td><div class="container-name">${name}</div><div class="container-image">${image}</div></td>
      <td><span class="status-badge ${sc}">${c.State || sc}</span></td>
      <td class="text-muted font-mono" style="font-size:11px">${fmtTime(c.Created)}</td>
      <td class="container-ports font-mono">${ports || '—'}</td>
      ${statsHtml}
      <td>
        <div class="action-group">
          ${sc === 'running'
            ? `<button class="btn btn-warn btn-icon" data-action="stop" data-id="${c.Id}" title="Stop">■</button>
               <button class="btn btn-icon" data-action="restart" data-id="${c.Id}" title="Restart">↻</button>
               <button class="btn btn-icon font-mono" data-action="console" data-id="${c.Id}" title="Console" style="font-size:10px">&gt;_</button>`
            : `<button class="btn btn-success btn-icon" data-action="start" data-id="${c.Id}" title="Start">▶</button>`}
          <button class="btn btn-icon" data-action="logs" data-id="${c.Id}" title="Logs">≡</button>
          <button class="btn btn-icon" data-action="edit" data-id="${c.Id}" title="Edit container">✎</button>
          <button class="btn btn-icon" data-action="customize" data-id="${c.Id}" title="Customize (nickname, color, group)">🎨</button>
          ${sc === 'running' && (c.Ports || []).some(p => p.PublicPort)
            ? `<button class="btn btn-icon" data-action="web" data-id="${c.Id}" data-wport="${(c.Ports || []).filter(p => p.PublicPort).sort((a, b) => a.PublicPort - b.PublicPort)[0].PublicPort}" title="Open Web UI">🌐</button>`
            : `<span class="btn btn-icon" style="visibility:hidden;pointer-events:none">🌐</span>`}
        </div>
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `<table class="container-table">
    <thead><tr>
      <th class="sel-cell"></th>
      <th>Name / Image</th>
      <th>Status</th>
      <th>Created</th>
      <th>Ports</th>
      <th>CPU</th>
      <th>Memory</th>
      <th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  wireSelection(el);

  // Wire up action buttons
  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'logs') { openLogs(id, btn.closest('tr').dataset.name); return; }
      if (action === 'console') { openTerminalFor(id); return; }
      if (action === 'web') { api.openUrl(`http://${state.config.host}:${btn.dataset.wport}`); return; }
      if (action === 'edit') { openEditContainer(id); return; }
      if (action === 'customize') { openCustomize(btn.closest('tr').dataset.name); return; }
      const rowName = btn.closest('tr') ? btn.closest('tr').dataset.name : id.slice(0, 12);
      const ok = await runContainerAction(id, action, rowName, btn);
      if (ok) setTimeout(() => loadDashboard(), 1500);
    });
  });

  // Row click → detail
  el.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
  });

  // Load stats for running containers
  containers.filter(c => c.State === 'running').forEach(c => {
    loadMiniStats(c.Id);
  });
}

async function loadMiniStats(id) {
  const short = id.slice(0, 12);
  const r = await api.docker.stats({ ...state.config, id });
  if (!r.ok || !r.data) return;
  const s = r.data;

  // CPU %
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage.total_usage || 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  // Mem %
  const memUsed = s.memory_stats.usage - (s.memory_stats.stats?.cache || 0);
  const memLimit = s.memory_stats.limit;
  const memPct = memLimit > 0 ? (memUsed / memLimit) * 100 : 0;

  const cpuEl = $(`val-cpu-${short}`);
  const memEl = $(`val-mem-${short}`);
  const cpuBar = $(`bar-cpu-${short}`);
  const memBar = $(`bar-mem-${short}`);

  if (cpuEl) cpuEl.textContent = cpu.toFixed(1) + '%';
  if (memEl) memEl.textContent = memPct.toFixed(1) + '%';
  if (cpuBar) {
    cpuBar.style.width = Math.min(cpu, 100) + '%';
    cpuBar.className = 'mini-bar-fill' + (cpu > 80 ? ' critical' : cpu > 60 ? ' high' : '');
  }
  if (memBar) {
    memBar.style.width = Math.min(memPct, 100) + '%';
    memBar.className = 'mini-bar-fill' + (memPct > 85 ? ' critical' : memPct > 70 ? ' high' : '');
  }

  // ── card grid: live values + rolling CPU sparkline ──
  const gcpu = $(`gval-cpu-${short}`), gmem = $(`gval-mem-${short}`);
  if (gcpu) gcpu.textContent = cpu.toFixed(1) + '%';
  if (gmem) { const mb = memUsed / 1048576; gmem.textContent = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'; }
  state.cpuHist = state.cpuHist || {};
  const hist = (state.cpuHist[short] = state.cpuHist[short] || []);
  hist.push(cpu); if (hist.length > 40) hist.shift();
  drawSparkline(`gspk-${short}`, hist);
}

// ─── Container List page — Liquid Glass card grid (stage 1) ───────────────────
const GC_TINTS = ['#5DCAA5','#85B7EB','#7F77DD','#EF9F27','#97C459','#F0997B','#58A6FF','#BC8CFF'];
function gcTint(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return GC_TINTS[h % GC_TINTS.length]; }
function gcMono(name) { const m = String(name || '').replace(/[^a-z0-9]/ig, ''); return (m.charAt(0) || '#').toUpperCase(); }

function drawSparkline(svgId, values) {
  const svg = document.getElementById(svgId); if (!svg) return;
  const W = 220, H = 42, tint = svg.dataset.tint || '#58a6ff';
  if (!values || values.length < 2) {
    svg.innerHTML = `<line x1="0" y1="${H - 6}" x2="${W}" y2="${H - 6}" stroke="${tint}" stroke-opacity="0.4" stroke-width="2" stroke-dasharray="3 4"/>`;
    return;
  }
  const max = Math.max(5, ...values) * 1.15, n = values.length;
  const X = i => (i / (n - 1)) * W;
  const Y = v => H - 4 - (Math.min(v, max) / max) * (H - 8);
  const pts = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `M0,${H} L` + values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' L') + ` L${W},${H} Z`;
  svg.innerHTML = `<path d="${area}" fill="${tint}" fill-opacity="0.15"/><polyline points="${pts}" fill="none" stroke="${tint}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
}

function visibleContainers() {
  return state.showAllContainers
    ? state.containers
    : state.containers.filter(c => (c.State || '').toLowerCase() === 'running');
}

// ─── Grouping: manual groups, then compose stacks ────────────────────────────
// Docker already labels compose containers with their project. We use that as an
// automatic group so a stack shows up as a stack, and add stack-wide actions.
// A manual group (gcGroups) always wins over the compose label.
const composeProject = c => (c.Labels && c.Labels['com.docker.compose.project']) || '';
const composeService = c => (c.Labels && c.Labels['com.docker.compose.service']) || '';

function containerGroupInfo(c) {
  const nm = sanitizeName(c.Names && c.Names[0]);
  const manual = (state.config.gcGroups || {})[nm];
  if (manual) return { name: manual, stack: false };
  if (state.config.stackGrouping === false) return { name: '', stack: false };
  const p = composeProject(c);
  return p ? { name: p, stack: true } : { name: '', stack: false };
}
function containerGroupName(c) { return containerGroupInfo(c).name; }

// Every container in a stack — including stopped ones the current filter hides,
// because "Stop all" must mean all.
const stackContainers = (proj) => state.containers.filter(c => composeProject(c) === proj);

// ─── Bulk action over many containers: one confirm, then run them ────────────
// Shared by stack actions and by multi-select.
async function runBulkAction(ids, action, what) {
  if (!ids.length) return;
  const v = ACTION_VERB[action] || [action, action + '…', action + 'ed'];
  const n = ids.length;
  const nameOf = id => {
    const c = state.containers.find(x => x.Id === id);
    return c ? sanitizeName(c.Names && c.Names[0]) : id.slice(0, 12);
  };
  const extra = action === 'remove'
    ? '\n\nThe containers are deleted. Data in volumes and bind mounts is kept.' : '';
  if (!confirm(`${v[0]} ${n} container${n > 1 ? 's' : ''}${what ? ` in ${what}` : ''}?\n\n${ids.map(nameOf).join(', ')}${extra}`)) return;

  toast(`${v[1]} ${n} container${n > 1 ? 's' : ''}…`, 'info', 6000);
  const failed = [];
  for (const id of ids) {
    const r = await api.docker.action({ ...state.config, id, action });
    if (!r.ok) failed.push(`${nameOf(id)} (${r.error})`);
  }
  if (failed.length)
    toast(`${n - failed.length}/${n} ${v[2].toLowerCase()} — failed: ${failed.join(', ')}`, 'error', 9000);
  else
    toast(`${v[2]} ${n} container${n > 1 ? 's' : ''} ✓`, 'success');

  state.selection = new Set();
  setTimeout(loadDashboard, 800);
}

function renderContainersList() {
  const el = $('containers-list');
  el.classList.toggle('view-list', state.containerView === 'list');
  document.querySelectorAll('#cview-picker .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.cview === state.containerView));
  const list = visibleContainers();
  const render = state.containerView === 'list' ? renderContainerTable : renderContainerCards;

  const hasGroups = list.some(c => containerGroupName(c));
  if (!hasGroups) { render('containers-list', list); return; }

  const groups = new Map();   // name -> { list, stack }
  for (const c of list) {
    const info = containerGroupInfo(c);
    const g = info.name || 'Ungrouped';
    if (!groups.has(g)) groups.set(g, { list: [], stack: info.stack });
    groups.get(g).list.push(c);
  }
  const names = [...groups.keys()].sort((a, b) =>
    ((a === 'Ungrouped') - (b === 'Ungrouped')) || a.localeCompare(b));

  el.innerHTML = names.map((g, i) => {
    const collapsed = !!state.collapsedGroups[g];
    const { list: members, stack } = groups.get(g);
    const editable = g !== 'Ungrouped' && !stack;
    // A stack's real size includes members the current filter is hiding
    const total = stack ? stackContainers(g).length : members.length;
    const running = stack ? stackContainers(g).filter(c => (c.State || '').toLowerCase() === 'running').length : 0;
    return `<div class="group-section${collapsed ? ' collapsed' : ''}" data-gi="${i}">
      <div class="group-header${collapsed ? ' collapsed' : ''}">
        <span class="gh-arrow">▾</span>${escHtml(g)}
        ${stack ? `<span class="gh-stack" title="Docker Compose project — grouped automatically from its labels">stack</span>` : ''}
        <span class="gh-count">${stack ? `${running}/${total}` : members.length}</span>
        ${stack ? `<span class="gh-actions">
          <button class="gh-btn" data-stack-act="start" data-gi="${i}" title="Start every container in this stack">▶</button>
          <button class="gh-btn" data-stack-act="restart" data-gi="${i}" title="Restart every container in this stack">↻</button>
          <button class="gh-btn" data-stack-act="stop" data-gi="${i}" title="Stop every container in this stack">■</button>
        </span>` : ''}
        ${editable ? `<span class="gh-actions">
          <button class="gh-btn" data-gh-rename="${i}" title="Rename group">✎</button>
          <button class="gh-btn" data-gh-dissolve="${i}" title="Dissolve group (containers keep running, just ungrouped)">✕</button>
        </span>` : ''}
      </div>
      <div class="group-body" id="grp-body-${i}"></div>
    </div>`;
  }).join('');
  names.forEach((g, i) => { if (!state.collapsedGroups[g]) render(`grp-body-${i}`, groups.get(g).list); });
  el.querySelectorAll('.group-header').forEach(h =>
    h.addEventListener('click', (e) => {
      if (e.target.closest('.gh-btn')) return; // header buttons handle themselves
      const g = names[+h.parentElement.dataset.gi];
      state.collapsedGroups[g] = !state.collapsedGroups[g];
      renderContainersList();
    }));
  // Stack actions act on every member, including ones hidden by the running filter
  el.querySelectorAll('[data-stack-act]').forEach(b =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const proj = names[+b.dataset.gi];
      const act = b.dataset.stackAct;
      let members = stackContainers(proj);
      if (act === 'start') members = members.filter(c => (c.State || '').toLowerCase() !== 'running');
      if (act === 'stop') members = members.filter(c => (c.State || '').toLowerCase() === 'running');
      if (!members.length) return toast(`Nothing to ${act} in ${proj}`, 'info');
      await runBulkAction(members.map(c => c.Id), act, `stack "${proj}"`);
    }));
  el.querySelectorAll('[data-gh-rename]').forEach(b =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openGroupModal(names[+b.dataset.ghRename]); // Electron has no prompt() — use the modal
    }));
  el.querySelectorAll('[data-gh-dissolve]').forEach(b =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = names[+b.dataset.ghDissolve];
      if (!confirm(`Dissolve group "${g}"?\n\nIts containers are untouched — they just become ungrouped.`)) return;
      const map = { ...(state.config.gcGroups || {}) };
      for (const k of Object.keys(map)) if (map[k] === g) delete map[k];
      delete state.collapsedGroups[g];
      saveCfg({ gcGroups: map });
      renderContainersList();
      toast(`Group "${g}" dissolved`, 'info');
    }));
}

// Grid / List toggle (persisted)
document.querySelectorAll('#cview-picker .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    state.containerView = b.dataset.cview;
    saveCfg({ containerView: state.containerView });
    renderContainersList();
  }));

// ─── Group create/edit modal ──────────────────────────────────────────────────
let groupOrigName = null;

function openGroupModal(existing) {
  groupOrigName = existing || null;
  $('group-title').textContent = existing ? `Edit group — ${existing}` : 'New group';
  $('group-name').value = existing || '';
  $('group-delete-btn').style.display = existing ? '' : 'none';

  const map = state.config.gcGroups || {};
  const names = [...new Set(state.containers.map(c => sanitizeName(c.Names && c.Names[0])))].sort();
  $('group-members').innerHTML = names.length
    ? names.map(n => {
        const inThis = existing && map[n] === existing;
        const elsewhere = map[n] && map[n] !== existing ? ` <span class="text-muted" style="font-size:11px">— currently in ${escHtml(map[n])}</span>` : '';
        return `<label class="upd-auto-row"><input type="checkbox" data-gm="${escHtml(n)}"${inThis ? ' checked' : ''}> ${escHtml(n)}${elsewhere}</label>`;
      }).join('')
    : '<div class="form-hint">No containers found — connect to a host first.</div>';

  $('group-modal').classList.add('open');
  setTimeout(() => $('group-name').focus(), 30);
}
function closeGroupModal() { $('group-modal').classList.remove('open'); groupOrigName = null; }

$('group-new-btn').addEventListener('click', () => openGroupModal(null));
$('group-close-btn').addEventListener('click', closeGroupModal);
$('group-cancel-btn').addEventListener('click', closeGroupModal);
$('group-modal').addEventListener('click', (e) => { if (e.target === $('group-modal')) closeGroupModal(); });

$('group-save-btn').addEventListener('click', () => {
  const name = $('group-name').value.trim();
  if (!name) { toast('Give the group a name', 'error'); return; }
  if (name === 'Ungrouped') { toast('"Ungrouped" is reserved', 'error'); return; }
  const map = { ...(state.config.gcGroups || {}) };
  $('group-members').querySelectorAll('[data-gm]').forEach(cb => {
    const n = cb.dataset.gm;
    if (cb.checked) map[n] = name;
    else if (map[n] === name || (groupOrigName && map[n] === groupOrigName)) delete map[n];
  });
  if (groupOrigName && groupOrigName !== name && state.collapsedGroups[groupOrigName]) {
    state.collapsedGroups[name] = true; delete state.collapsedGroups[groupOrigName];
  }
  saveCfg({ gcGroups: map });
  closeGroupModal();
  renderContainersList();
  toast(`Group "${name}" saved`, 'success');
});

$('group-delete-btn').addEventListener('click', () => {
  if (!groupOrigName) return;
  if (!confirm(`Dissolve group "${groupOrigName}"?\n\nIts containers are untouched — they just become ungrouped.`)) return;
  const map = { ...(state.config.gcGroups || {}) };
  for (const k of Object.keys(map)) if (map[k] === groupOrigName) delete map[k];
  delete state.collapsedGroups[groupOrigName];
  saveCfg({ gcGroups: map });
  closeGroupModal();
  renderContainersList();
  toast('Group dissolved', 'info');
});

function renderContainerCards(targetId, containers) {
  const el = $(targetId);
  if (!containers || !containers.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">◫</div><div class="empty-title">No containers</div></div>`;
    return;
  }
  const cards = containers.map(c => {
    const name = sanitizeName(c.Names && c.Names[0]);
    const short = c.Id.slice(0, 12);
    const st = (c.State || '').toLowerCase();
    const running = st === 'running';
    const cust = (state.config.gcCustom || {})[name] || {};
    const disp = cust.nickname || name;
    const tint = cust.tint || gcTint(name);
    const icon = cust.icon || gcMono(name);
    const image = (c.Image || '').split('@')[0];
    const hasPorts = (c.Ports || []).some(p => p.PublicPort);
    const wport = hasPorts ? (c.Ports || []).filter(p => p.PublicPort).sort((a, b) => a.PublicPort - b.PublicPort)[0].PublicPort : '';
    // Docker reports HEALTHCHECK results in the Status string — show them here
    // (this replaces the old "Health checks" card on Insights)
    const hs = /\(unhealthy\)/i.test(c.Status || '') ? ['bad', '✕ Unhealthy', 'Its HEALTHCHECK is failing']
      : /\(health: starting\)/i.test(c.Status || '') ? ['warn', '⏳ Starting', 'HEALTHCHECK has not passed yet']
      : /\(healthy\)/i.test(c.Status || '') ? ['run', '✓ Healthy', 'Its own HEALTHCHECK is passing']
      : null;
    const healthBadge = hs && running
      ? `<span class="gc-badge health ${hs[0]}" title="${hs[2]}">${hs[1]}</span>` : '';
    const badge = (running ? `<span class="gc-badge run"><span class="d"></span>Running</span>`
      : (st === 'restarting' || st === 'paused') ? `<span class="gc-badge warn"><span class="d"></span>${st.replace(/^\w/, m => m.toUpperCase())}</span>`
      : `<span class="gc-badge off"><span class="d"></span>${(c.State || 'Stopped').replace(/^\w/, m => m.toUpperCase())}</span>`) + healthBadge;
    const status = (c.Status || '').replace(/\s*\(healthy\)/i, '');
    const actions = running
      ? `<button class="btn btn-warn" data-action="stop" data-id="${c.Id}">■ Stop</button>
         <button class="btn" data-action="restart" data-id="${c.Id}">↻ Restart</button>
         <button class="btn ic" data-action="logs" data-id="${c.Id}" title="Logs">≡</button>
         <button class="btn ic" data-action="edit" data-id="${c.Id}" title="Edit container">✎</button>
         <button class="btn ic" data-action="customize" title="Customize">🎨</button>`
      : `<button class="btn btn-success" data-action="start" data-id="${c.Id}">▶ Start</button>
         <button class="btn ic" data-action="logs" data-id="${c.Id}" title="Logs">≡</button>
         <button class="btn ic" data-action="edit" data-id="${c.Id}" title="Edit container">✎</button>
         <button class="btn ic" data-action="customize" title="Customize">🎨</button>`;
    const svc = composeService(c);
    return `<div class="gcard${state.selection.has(c.Id) ? ' selected' : ''}" data-id="${c.Id}" data-name="${name}" style="--tint:${tint}">
      ${selCheckbox(c.Id)}
      <div class="gc-top">
        <div class="gc-ic">${icon}</div>
        <div style="min-width:0;flex:1">
          <div class="gc-name" title="${name}">${disp}</div>
          <div class="gc-sub">${svc ? `<span class="gc-svc" title="Compose service">${escHtml(svc)}</span> · ` : ''}${image}</div>
        </div>
        ${badge}
      </div>
      <svg class="gc-spark" id="gspk-${short}" data-tint="${tint}" viewBox="0 0 220 42" preserveAspectRatio="none"></svg>
      <div class="gc-stats">
        <div><span class="k">CPU</span><span class="v" id="gval-cpu-${short}">${running ? '…' : '—'}</span></div>
        <div><span class="k">MEM</span><span class="v" id="gval-mem-${short}">${running ? '…' : '—'}</span></div>
        <div style="flex:1"><span class="k">Status</span><span class="v" style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block" title="${status}">${status || '—'}</span></div>
      </div>
      <div class="gc-act">${actions}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="cgrid">${cards}</div>`;

  wireSelection(el);

  el.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action, id = btn.dataset.id;
      const card = btn.closest('.gcard'); const rowName = card ? card.dataset.name : id.slice(0, 12);
      if (action === 'logs') { openLogs(id, rowName); return; }
      if (action === 'console') { openTerminalFor(id); return; }
      if (action === 'web') { api.openUrl(`http://${state.config.host}:${btn.dataset.wport}`); return; }
      if (action === 'customize') { openCustomize(rowName); return; }
      if (action === 'edit') { openEditContainer(id); return; }
      const ok = await runContainerAction(id, action, rowName, btn);
      if (ok) setTimeout(() => loadDashboard(), 1500);
    });
  });
  el.querySelectorAll('.gcard').forEach(card =>
    card.addEventListener('click', () => openDetail(card.dataset.id)));

  containers.filter(c => (c.State || '').toLowerCase() === 'running').forEach(c => {
    const short = c.Id.slice(0, 12);
    drawSparkline(`gspk-${short}`, (state.cpuHist && state.cpuHist[short]) || []);
    loadMiniStats(c.Id);
  });
}

