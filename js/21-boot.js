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
  if (!confirm(confirmMsg)) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Pruning…';
  const r = await fn();
  btn.disabled = false; btn.textContent = orig;
  if (!r.ok) { toast(`${label} failed: ${r.error}`, 'error', 7000); return; }
  toast(summarize(r.data || {}), 'success', 6000);
  state.dfFetched = 0;
  if (after) await after();
}

$('images-prune-btn').addEventListener('click', () =>
  runPrune($('images-prune-btn'), 'Prune',
    'Remove dangling (untagged) image layers?\n\nThese are leftovers from image updates and are safe to delete.',
    () => api.docker.pruneImages(state.config),
    d => `Pruned ${(d.ImagesDeleted || []).length} image${(d.ImagesDeleted || []).length === 1 ? '' : 's'} — reclaimed ${fmt(d.SpaceReclaimed || 0)}`,
    async () => { state.images = []; await loadImages(); loadDashboard(); }));

$('images-prune-all-btn').addEventListener('click', () =>
  runPrune($('images-prune-all-btn'), 'Remove unused',
    'Remove EVERY image not used by a container?\n\nLike Portainer\'s "Remove unused images". Anything you later redeploy will be pulled again from the registry.',
    () => api.docker.pruneImages({ ...state.config, all: true }),
    d => `Removed ${(d.ImagesDeleted || []).length} unused image${(d.ImagesDeleted || []).length === 1 ? '' : 's'} — reclaimed ${fmt(d.SpaceReclaimed || 0)}`,
    async () => { state.images = []; await loadImages(); loadDashboard(); }));

$('volumes-prune-btn').addEventListener('click', () =>
  runPrune($('volumes-prune-btn'), 'Prune',
    'Remove volumes not attached to any container?\n\n⚠ Data in those volumes is permanently deleted. Bind mounts (host folders) are NOT affected.',
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
