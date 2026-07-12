// ─── Auto-refresh ─────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (!state.refreshInterval || !state.config.host) return;
  state.refreshTimer = setInterval(loadDashboard, state.refreshInterval);
}

// ─── Refresh buttons ──────────────────────────────────────────────────────────
$('refresh-btn').addEventListener('click', loadDashboard);
$('dash-refresh-btn').addEventListener('click', loadDashboard);
$('containers-refresh-btn').addEventListener('click', async () => {
  state.containers = [];
  await loadDashboard();
  renderContainersList();
});
$('containers-show-all-btn').addEventListener('click', () => {
  state.showAllContainers = !state.showAllContainers;
  const btn = $('containers-show-all-btn');
  btn.textContent = state.showAllContainers ? 'Running Only' : 'Show All';
  renderContainersList();
});
$('images-refresh-btn').addEventListener('click', async () => { state.images = []; state.containers = []; await loadImages(); });
$('volumes-refresh-btn').addEventListener('click', async () => { state.volumes = []; state.containers = []; await loadVolumes(); });
$('networks-refresh-btn').addEventListener('click', async () => { state.networks = []; await loadNetworks(); });
$('insights-refresh-btn').addEventListener('click', loadDashboard);

// ─── Prune / remove unused (Portainer-style housekeeping) ─────────────────────
async function runPrune(btn, label, confirmMsg, fn, summarize, after) {
  // confirmMsg === null → volume prune: the data goes with it, so make them type it
  const ok = confirmMsg ? confirm(confirmMsg) : await confirmVolumePrune();
  if (!ok) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Pruning…';
  const r = await fn();
  btn.disabled = false; btn.textContent = orig;
  if (!r.ok) { toast(`${label} failed: ${r.error}`, 'error', 7000); return; }
  toast(summarize(r.data || {}), 'success', 6000);
  state.dfFetched = 0;
  if (after) await after();
}

// Images are cleaned up through the Clean up sheet (js/14-resources.js) — one
// decision with real sizes, instead of a dangling button and an unused button
// where the second silently did the first's job too.

$('volumes-prune-btn').addEventListener('click', () =>
  runPrune($('volumes-prune-btn'), 'Prune',
    null,   // handled by confirmDestructive below — pruning volumes destroys data
    () => api.docker.pruneVolumes(state.config),
    d => `Removed ${(d.VolumesDeleted || []).length} volume${(d.VolumesDeleted || []).length === 1 ? '' : 's'} — reclaimed ${fmt(d.SpaceReclaimed || 0)}`,
    async () => { state.volumes = []; await loadVolumes(); loadDashboard(); }));

// ─── Tray-driven events ───────────────────────────────────────────────────────
api.onRefresh(() => loadDashboard());
api.onOpenContainer((id) => {
  showPage('containers');
  renderContainersList();
  openDetail(id);
});

// ─── Startup splash ───────────────────────────────────────────────────────────
setTimeout(() => {
  const sp = $('splash');
  sp.classList.add('done');
  sp.addEventListener('transitionend', () => sp.remove(), { once: true });
}, 1900);

// ─── Start ────────────────────────────────────────────────────────────────────
init();
