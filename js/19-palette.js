// ─── Command palette (⌘K) ─────────────────────────────────────────────────────
function navTo(pg) { const it = [...document.querySelectorAll('.nav-item')].find(n => n.dataset.page === pg); if (it) it.click(); }
let palItems = [], palSel = 0;
function buildPaletteCommands() {
  const cmds = [];
  [['dashboard','⊞','Dashboard'],['insights','💡','Insights'],['events','☷','Activity'],['containers','◫','Containers'],['images','◱','Images'],['volumes','⬡','Volumes'],['networks','⬡','Networks'],['terminal','›','Terminal'],['files','◳','File Browser'],['settings','⚙','Settings']]
    .forEach(([pg, ic, label]) => cmds.push({ icon: ic, label: 'Go to ' + label, sub: 'page', run: () => navTo(pg) }));
  cmds.push({ icon: '🚀', label: 'Deploy a container', sub: 'action', run: () => { navTo('containers'); openDeploy(); } });
  cmds.push({ icon: '⬇', label: 'Import from YAML', sub: 'action', run: () => { navTo('containers'); openComposeImport(); } });
  cmds.push({ icon: '↻', label: 'Refresh', sub: 'action', run: () => loadDashboard() });
  cmds.push({ icon: '⬆', label: 'Check for updates', sub: 'action', run: () => { navTo('settings'); checkAppUpdate(true); } });
  (state.containers || []).forEach(c => {
    const nm = sanitizeName(c.Names && c.Names[0]);
    const disp = ((state.config.gcCustom || {})[nm] || {}).nickname || nm;
    const st = (c.State || '').toLowerCase();
    cmds.push({ icon: '◫', label: 'Open ' + disp, sub: c.State || 'container', run: () => { navTo('containers'); openDetail(c.Id); } });
    if (st === 'running') cmds.push({ icon: '↻', label: 'Restart ' + disp, sub: 'container', run: async () => { if (await runContainerAction(c.Id, 'restart', disp)) setTimeout(loadDashboard, 1500); } });
    else cmds.push({ icon: '▶', label: 'Start ' + disp, sub: 'container', run: async () => { if (await runContainerAction(c.Id, 'start', disp)) setTimeout(loadDashboard, 1500); } });
  });
  return cmds;
}
function renderPalette() {
  const q = $('palette-input').value.trim().toLowerCase();
  const all = buildPaletteCommands();
  palItems = q ? all.filter(c => (c.label + ' ' + (c.sub || '')).toLowerCase().includes(q)) : all;
  if (palSel >= palItems.length) palSel = 0;
  const list = $('palette-list');
  if (!palItems.length) { list.innerHTML = `<div class="pcmd-empty">No matches</div>`; return; }
  list.innerHTML = palItems.map((c, i) =>
    `<div class="pcmd${i === palSel ? ' sel' : ''}" data-i="${i}"><span class="pi">${c.icon}</span><span>${c.label}</span>${c.sub ? `<span class="psub">${c.sub}</span>` : ''}</div>`).join('');
  list.querySelectorAll('.pcmd').forEach(el => {
    el.addEventListener('mousemove', () => { if (palSel !== +el.dataset.i) { palSel = +el.dataset.i; highlightPalette(); } });
    el.addEventListener('click', () => runPalette(+el.dataset.i));
  });
}
function highlightPalette() { $('palette-list').querySelectorAll('.pcmd').forEach((el, i) => el.classList.toggle('sel', i === palSel)); }
function scrollPalSel() { const el = $('palette-list').querySelector('.pcmd.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
function runPalette(i) { const c = palItems[i]; if (!c) return; closePalette(); c.run(); }
function openPalette() { $('palette-input').value = ''; palSel = 0; renderPalette(); $('palette-modal').classList.add('open'); setTimeout(() => $('palette-input').focus(), 30); }
function closePalette() { $('palette-modal').classList.remove('open'); }
$('palette-open').addEventListener('click', openPalette);
$('palette-input').addEventListener('input', renderPalette);
$('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); highlightPalette(); scrollPalSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); highlightPalette(); scrollPalSel(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palSel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palette-modal').addEventListener('click', (e) => { if (e.target === $('palette-modal')) closePalette(); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    $('palette-modal').classList.contains('open') ? closePalette() : openPalette();
  }
}, true);

$('deploy-go-btn').addEventListener('click', async () => {
  const image = $('dep-image').value.trim();
  if (!image) { toast('Enter an image name', 'error'); return; }
  const rows = (id) => [...document.querySelectorAll(`#${id} .kv-row`)];
  const spec = {
    image,
    name: $('dep-name').value.trim(),
    ports: rows('dep-ports').map(r => ({ host: r.querySelector('[data-k]').value.trim(), cont: r.querySelector('[data-v]')?.value.trim() })).filter(p => p.cont),
    volumes: rows('dep-vols').map(r => ({ host: r.querySelector('[data-k]').value.trim(), cont: r.querySelector('[data-v]')?.value.trim() })).filter(v => v.host && v.cont),
    env: rows('dep-envs').map(r => r.querySelector('[data-k]').value.trim()).filter(Boolean),
    restart: $('dep-restart').value,
    network: $('dep-network').value,
    memory: numOrZero($('dep-memory').value),   // MB, 0 = unlimited
    cpus: numOrZero($('dep-cpus').value)        // cores, 0 = unlimited
  };
  const btn = $('deploy-go-btn');
  btn.disabled = true; btn.textContent = 'Deploying…';
  $('deploy-status').textContent = `Pulling ${image} — can take a few minutes…`;
  const r = await api.deploy.create({ ...state.config, spec });
  btn.disabled = false; btn.textContent = 'Deploy';
  if (r.ok) {
    toast(`${spec.name || image} deployed and running ✓`, 'success', 5000);
    closeDeploy();
    await loadDashboard();
    showPage('containers');
    renderContainersList();
  } else {
    $('deploy-status').textContent = '';
    toast('Deploy failed: ' + r.error, 'error', 8000);
  }
});

