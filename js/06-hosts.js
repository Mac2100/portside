// ─── Multi-host ───────────────────────────────────────────────────────────────
function migrateHosts() {
  const c = state.config;
  if (!c.hosts || !c.hosts.length) {
    c.hosts = c.host ? [{ id: 'h' + Date.now().toString(36), name: 'NAS', host: c.host, port: c.port || 2376 }] : [];
    c.activeHostId = c.hosts[0] ? c.hosts[0].id : null;
    api.config.save(c);
  }
  syncActiveHost();
}

function activeHost() {
  return (state.config.hosts || []).find(h => h.id === state.config.activeHostId) || (state.config.hosts || [])[0];
}

function syncActiveHost() {
  const h = activeHost();
  if (h) { state.config.host = h.host; state.config.port = h.port; }
  renderHostSwitcher();
}

function renderHostSwitcher() {
  const sel = $('host-switcher');
  const hosts = state.config.hosts || [];
  if (hosts.length < 2) { sel.style.display = 'none'; return; }
  sel.style.display = '';
  sel.innerHTML = hosts.map(h => `<option value="${h.id}"${h.id === state.config.activeHostId ? ' selected' : ''}>${h.name}</option>`).join('');
}

async function switchHost(id) {
  const h = (state.config.hosts || []).find(x => x.id === id);
  if (!h) return;
  saveCfg({ activeHostId: id });
  syncActiveHost();
  // Reset per-host state
  state.containers = []; state.images = []; state.volumes = []; state.networks = [];
  state.statsCache = {}; state.prevNet = null; state.prevPerIO = {}; state.prevRunningIds = null;
  state.inspectCache = {}; state.inspectFetched = 0; state.df = null; state.dfFetched = 0;
  state.updates = null; state.lastPer = [];
  state.history = { t: [], cpu: [], mem: [], rx: [], tx: [] };
  toast(`Switched to ${h.name}`, 'info');
  api.events.start({ host: h.host, port: h.port });
  await loadDashboard();
  checkUpdates(false);
}

$('host-switcher').addEventListener('change', (e) => switchHost(e.target.value));

