// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  state.config = await api.config.load();
  migrateHosts();
  migrateNotifyRules();
  await refreshCrashLogs();   // so Insights can offer logs for crashes from earlier sessions

  applyTheme(state.config.theme || 'system');
  applyLogo(state.config.logo || 'teal');
  state.containerView = state.config.containerView || 'grid';
  if (state.config.refreshInterval !== undefined) {
    state.refreshInterval = state.config.refreshInterval;
    $('setting-interval').value = String(state.refreshInterval);
  }

  const deepLink = new URLSearchParams(location.search).get('page');
  if (deepLink) {
    showPage(deepLink);
    if (state.config.host) { await loadDashboard(); startAutoRefresh(); }
    loadPage(deepLink);
  } else if (state.config.host) {
    await loadDashboard();
    startAutoRefresh();
  } else {
    showPage('settings');
    loadSettings();
    toast('Enter your QNAP IP to get started', 'info', 5000);
  }
  if (state.config.host) {
    checkUpdates(false);
    checkGhReleases(false);
    checkCertExpiry();
    scheduleUpdateChecks();
    api.events.start({ host: state.config.host, port: state.config.port });
  }
}

// When the QNAP's Docker certs expire, Portside can't talk to the host at all —
// it just goes quiet. Warn well before that happens, at most once a day.
const CERT_WARN_DAYS = 21;
async function checkCertExpiry() {
  const h = activeHost();
  const info = await api.certs.info({ hostId: h ? h.id : null });
  const certs = [['ca.pem', info.ca], ['cert.pem', info.cert]].filter(([, c]) => c && c.validTo);

  const today = new Date().toDateString();
  if (state.config.certNotifiedOn === today) return;

  for (const [label, c] of certs) {
    const days = Math.floor((new Date(c.validTo) - Date.now()) / 86400000);
    if (c.expired || days <= CERT_WARN_DAYS) {
      notify('certExpiring', c.expired
        ? `Your Docker certificate ${label} has EXPIRED — Portside can't reach the host until you re-import it`
        : `Your Docker certificate ${label} expires in ${days} day${days === 1 ? '' : 's'} — re-import from Container Station before it does`);
      saveCfg({ certNotifiedOn: today });
      break;
    }
  }
}

