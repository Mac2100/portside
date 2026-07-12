// ─── Settings ─────────────────────────────────────────────────────────────────
function fmtCertDate(d) {
  const t = new Date(d);
  return isNaN(t) ? d : t.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function refreshCertStatus() {
  const h = activeHost();
  const info = await api.certs.info({ hostId: h ? h.id : null });
  const srcLabel = { host: `imported for ${h ? h.name : 'host'}`, custom: 'imported', bundled: 'bundled' }[info.source];
  const srcPill = `<span class="cert-pill ${info.source !== 'bundled' ? 'custom' : ''}">${srcLabel}</span>`;
  const row = (label, c) => {
    if (!c || c.error) return `<div class="cert-row"><span style="color:var(--danger)">✕</span> ${label} — ${c?.error || 'missing'}</div>`;
    return `<div class="cert-row"><span style="color:${c.expired ? 'var(--danger)' : 'var(--running)'}">${c.expired ? '✕' : '✓'}</span>
      ${label} <span class="text-muted">(${c.cn || '—'})</span>
      <span class="cert-pill ${c.expired ? 'expired' : ''}">${c.expired ? 'EXPIRED ' : 'expires '}${fmtCertDate(c.validTo)}</span></div>`;
  };
  $('cert-status').innerHTML = `
    <div style="margin-bottom:8px">${srcPill}</div>
    ${row('ca.pem', info.ca)}
    ${row('cert.pem', info.cert)}
    <div class="cert-row"><span style="color:${info.key ? 'var(--running)' : 'var(--danger)'}">${info.key ? '✓' : '✕'}</span> key.pem — Private key</div>`;
  $('cert-reset-btn').style.display = info.source !== 'bundled' ? '' : 'none';
}

let editingHostId = null;

function renderHostsList() {
  const hosts = state.config.hosts || [];
  $('hosts-list').innerHTML = hosts.map(h => {
    if (h.id === editingHostId) {
      return `<div class="host-row active">
        <input class="form-input" data-e-name value="${h.name}" placeholder="Name" style="flex:0 0 130px" spellcheck="false">
        <input class="form-input" data-e-ip value="${h.host}" placeholder="IP address" style="flex:1" spellcheck="false">
        <input class="form-input" data-e-port type="number" value="${h.port}" style="flex:0 0 80px">
        <button class="btn btn-primary" data-save="${h.id}">Save</button>
        <button class="btn" data-cancel>Cancel</button>
      </div>`;
    }
    return `<div class="host-row${h.id === state.config.activeHostId ? ' active' : ''}">
      <input type="radio" name="active-host" ${h.id === state.config.activeHostId ? 'checked' : ''} data-activate="${h.id}" title="Make active">
      <span class="host-row-name">${h.name}</span>
      <span class="host-row-addr">${h.host}:${h.port}</span>
      <button class="btn btn-icon" data-edit="${h.id}" title="Edit">✎</button>
      <button class="btn" data-test="${h.id}">Test</button>
      <button class="btn" data-certs="${h.id}">Certs…</button>
      <button class="btn btn-icon" data-remove="${h.id}" title="Remove" ${hosts.length < 2 ? 'disabled' : ''}>✕</button>
    </div>`;
  }).join('') || '<div class="form-hint">No hosts yet — add your NAS below.</div>';

  $('hosts-list').querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => { editingHostId = b.dataset.edit; renderHostsList(); }));
  $('hosts-list').querySelectorAll('[data-cancel]').forEach(b =>
    b.addEventListener('click', () => { editingHostId = null; renderHostsList(); }));
  $('hosts-list').querySelectorAll('[data-save]').forEach(b =>
    b.addEventListener('click', async () => {
      const row = b.closest('.host-row');
      const name = row.querySelector('[data-e-name]').value.trim();
      const ip = row.querySelector('[data-e-ip]').value.trim();
      const port = parseInt(row.querySelector('[data-e-port]').value) || 2376;
      if (!ip) { toast('IP address is required', 'error'); return; }
      const hosts2 = state.config.hosts.map(h => h.id === b.dataset.save ? { ...h, name: name || ip, host: ip, port } : h);
      saveCfg({ hosts: hosts2 });
      editingHostId = null;
      renderHostsList();
      renderHostSwitcher();
      if (b.dataset.save === state.config.activeHostId) {
        syncActiveHost();
        api.events.start({ host: state.config.host, port: state.config.port });
        toast('Host updated — reconnecting…', 'success');
        await loadDashboard();
        refreshCertStatus();
      } else {
        toast('Host updated', 'success');
      }
    }));
  $('hosts-list').querySelectorAll('[data-activate]').forEach(r =>
    r.addEventListener('change', () => { switchHost(r.dataset.activate); renderHostsList(); }));
  $('hosts-list').querySelectorAll('[data-test]').forEach(b =>
    b.addEventListener('click', async () => {
      const h = state.config.hosts.find(x => x.id === b.dataset.test);
      b.disabled = true; b.textContent = '…';
      const r = await api.docker.info({ host: h.host, port: h.port });
      b.disabled = false; b.textContent = 'Test';
      toast(r.ok ? `${h.name}: connected (Docker ${r.data.ServerVersion})` : `${h.name}: ${r.error}`, r.ok ? 'success' : 'error', 5000);
    }));
  $('hosts-list').querySelectorAll('[data-certs]').forEach(b =>
    b.addEventListener('click', async () => {
      const h = state.config.hosts.find(x => x.id === b.dataset.certs);
      const r = await api.certs.import({ hostId: h.id });
      if (r.canceled) return;
      if (!r.ok) { toast(r.error || 'Import failed', 'error'); return; }
      toast(r.active ? `Certificates imported for ${h.name}` : `Imported — still need: ${r.missing.join(', ')}`, r.active ? 'success' : 'info', 5000);
      refreshCertStatus();
    }));
  $('hosts-list').querySelectorAll('[data-remove]').forEach(b =>
    b.addEventListener('click', () => {
      const h = state.config.hosts.find(x => x.id === b.dataset.remove);
      if (!confirm(`Remove host "${h.name}"?`)) return;
      const hosts = state.config.hosts.filter(x => x.id !== h.id);
      const patch = { hosts };
      if (state.config.activeHostId === h.id) patch.activeHostId = hosts[0].id;
      saveCfg(patch);
      if (patch.activeHostId) switchHost(patch.activeHostId);
      renderHostsList();
      renderHostSwitcher();
    }));
}

$('add-host-btn').addEventListener('click', () => {
  const name = $('new-host-name').value.trim();
  const ip = $('new-host-ip').value.trim();
  const port = parseInt($('new-host-port').value) || 2376;
  if (!ip) { toast('Enter the host IP', 'error'); return; }
  const h = { id: 'h' + Date.now().toString(36), name: name || ip, host: ip, port };
  saveCfg({ hosts: [...(state.config.hosts || []), h] });
  if (state.config.hosts.length === 1) { saveCfg({ activeHostId: h.id }); syncActiveHost(); loadDashboard(); }
  $('new-host-name').value = ''; $('new-host-ip').value = '';
  renderHostsList();
  renderHostSwitcher();
  toast(`Added ${h.name} — use Test to verify, and Certs… if it needs its own certificates`, 'success', 5000);
});

async function loadSettings() {
  renderHostsList();
  applyTheme(state.config.theme || 'system');
  document.querySelectorAll('#logo-picker .logo-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.logo === (state.config.logo || 'teal')));
  api.appx.getLoginItem().then(v => { $('setting-autostart').checked = v; });
  $('setting-tray').checked = state.config.trayEnabled !== false;
  $('setting-alertbadge').checked = state.config.alertBadge !== false;
  refreshCertStatus();
  refreshGitTokenState();
  renderNotifyRules();
  renderUpdSettings();
}

// ─── Notification rules ───────────────────────────────────────────────────────
// One switch per event type. Defaults to on; the old blanket "notify me about
// updates" flag migrates into the two update-ish events.
function renderNotifyRules() {
  const rules = state.config.notifyRules || {};
  $('notify-rules').innerHTML = NOTIFY_EVENTS.map(([key, label, hint]) => `
    <label class="notify-row">
      <input type="checkbox" data-nr="${key}"${rules[key] !== false ? ' checked' : ''}>
      <span>
        <span class="notify-label">${label}</span>
        <span class="notify-hint">${hint}</span>
      </span>
    </label>`).join('');

  $('notify-rules').querySelectorAll('[data-nr]').forEach(cb =>
    cb.addEventListener('change', () => {
      const r = { ...(state.config.notifyRules || {}) };
      r[cb.dataset.nr] = cb.checked;
      saveCfg({ notifyRules: r });
    }));
}

// One-time migration from the single updNotify flag
function migrateNotifyRules() {
  if (state.config.notifyRules || state.config.updNotify !== false) return;
  saveCfg({ notifyRules: { imageUpdate: false, ghRelease: false } });
}

// ─── Container Updates settings ───────────────────────────────────────────────
function renderUpdSettings() {
  $('setting-upd-enabled').checked = state.config.updEnabled !== false;
  $('setting-gh-enabled').checked = state.config.ghEnabled !== false;
  $('setting-upd-interval').value = String(state.config.updInterval !== undefined ? state.config.updInterval : 3600000);
  $('setting-gh-interval').value = String(state.config.ghInterval !== undefined ? state.config.ghInterval : 900000);
  $('setting-gh-deploytime').value = ghDeployTime();

  const auto = state.config.autoUpdate || {};
  const names = [...new Set(state.containers.map(c => sanitizeName(c.Names && c.Names[0])))].sort();
  $('upd-auto-list').innerHTML = names.length
    ? names.map(n => `<label class="upd-auto-row"><input type="checkbox" data-au="${escHtml(n)}"${auto[n] ? ' checked' : ''}> ${escHtml(n)}</label>`).join('')
    : '<div class="form-hint">Connect to a host to list containers.</div>';
  $('upd-auto-list').querySelectorAll('[data-au]').forEach(cb =>
    cb.addEventListener('change', () => {
      const a = { ...(state.config.autoUpdate || {}) };
      if (cb.checked) a[cb.dataset.au] = true; else delete a[cb.dataset.au];
      saveCfg({ autoUpdate: a });
    }));

  renderGhWatchList();
  syncGhFromGitDeploy().then(renderGhWatchList); // pick up any Git Deploy configs saved since last check
}

function renderGhWatchList() {
  const watch = state.config.ghWatch || [];
  const latest = state.ghLatest || {};
  const containerNames = [...new Set(state.containers.map(c => sanitizeName(c.Names && c.Names[0])))].sort();
  $('ghwatch-list').innerHTML = watch.length
    ? watch.map(repo => {
        const l = latest[repo];
        const seen = ghSeenFor(repo);
        const cfg = ghCfgFor(repo);
        const tag = (l && l.tag) || seen.tag || '';
        const sha = (l && l.commit && l.commit.shortSha) || (seen.sha || '').slice(0, 7);
        const bits = [tag, sha && '@' + sha].filter(Boolean).join(' ');
        const isNew = (state.ghNew || []).some(g => g.repo === repo);
        const opts = ['<option value="">not linked</option>']
          .concat(containerNames.map(n => `<option value="${escHtml(n)}"${cfg.container === n ? ' selected' : ''}>${escHtml(n)}</option>`))
          .join('');
        return `<div class="ghwatch-row">
          <span class="gw-repo" title="${escHtml(repo)}">${escHtml(repo)}</span>
          ${bits ? `<span class="gw-tag">${isNew ? '🆕 ' : ''}${escHtml(bits)}</span>` : ''}
          <select class="form-input gw-link" data-gw-link="${escHtml(repo)}" title="Container to deploy when this repo changes" style="flex:0 0 150px;padding:4px 8px;font-size:12px">${opts}</select>
          <select class="form-input gw-mode" data-gw-mode="${escHtml(repo)}" title="Notify: alert + one-click Deploy · Auto: deploy immediately · Nightly: deploy at the scheduled time" style="flex:0 0 108px;padding:4px 8px;font-size:12px"${cfg.container ? '' : ' disabled'}>
            <option value="notify"${ghModeFor(repo) === 'notify' ? ' selected' : ''}>🔔 Notify</option>
            <option value="auto"${ghModeFor(repo) === 'auto' ? ' selected' : ''}>⚡ Auto</option>
            <option value="scheduled"${ghModeFor(repo) === 'scheduled' ? ' selected' : ''}>🌙 Nightly</option>
          </select>
          <button class="btn btn-icon" data-gw-remove="${escHtml(repo)}" title="Stop watching">✕</button>
        </div>`;
      }).join('')
    : '<div class="form-hint">Not watching any repos yet — add one below, or import everything you\'ve set up in Git Deploy.</div>';

  $('ghwatch-list').querySelectorAll('[data-gw-link]').forEach(sel =>
    sel.addEventListener('change', () => {
      const repo = sel.dataset.gwLink;
      setGhCfg(repo, { container: sel.value || null, ...(sel.value ? {} : { mode: 'notify', autoDeploy: false }) });
      renderGhWatchList();
      renderInsights(state.lastPer || []);
    }));
  $('ghwatch-list').querySelectorAll('[data-gw-mode]').forEach(sel =>
    sel.addEventListener('change', () => {
      const repo = sel.dataset.gwMode;
      setGhCfg(repo, { mode: sel.value, autoDeploy: sel.value === 'auto' });
      const c = ghCfgFor(repo).container;
      const msg = {
        notify: `Pushes to ${repo}: you'll be notified with a one-click Deploy`,
        auto: `Pushes to ${repo}: ${c} deploys immediately, hands-free`,
        scheduled: `Pushes to ${repo}: queued, ${c} deploys at ${ghDeployTime()} `
      }[sel.value];
      toast(msg, 'info', 6000);
      renderInsights(state.lastPer || []);
    }));
  $('ghwatch-list').querySelectorAll('[data-gw-remove]').forEach(b =>
    b.addEventListener('click', () => {
      const repo = b.dataset.gwRemove;
      const seen2 = { ...(state.config.ghSeen || {}) }; delete seen2[repo];
      const cfg2 = { ...(state.config.ghWatchCfg || {}) }; delete cfg2[repo];
      saveCfg({
        ghWatch: (state.config.ghWatch || []).filter(r => r !== repo),
        ghSeen: seen2, ghWatchCfg: cfg2,
        // remember the removal so auto-sync from Git Deploy doesn't re-add it
        ghIgnored: [...new Set([...(state.config.ghIgnored || []), repo])]
      });
      state.ghNew = (state.ghNew || []).filter(g => g.repo !== repo);
      renderGhWatchList();
      renderInsights(state.lastPer || []);
    }));
}

$('setting-upd-interval').addEventListener('change', (e) => {
  saveCfg({ updInterval: +e.target.value });
  scheduleUpdateChecks();
  toast(+e.target.value ? 'Image update checks scheduled' : 'Automatic image checks off — use Check now', 'info', 4000);
});

$('setting-gh-interval').addEventListener('change', (e) => {
  saveCfg({ ghInterval: +e.target.value });
  scheduleUpdateChecks();
  toast(+e.target.value ? `GitHub repos checked every ${Math.round(+e.target.value / 60000)} min` : 'Automatic GitHub checks off — use Check now', 'info', 4500);
});

$('setting-gh-deploytime').addEventListener('change', (e) => {
  if (!/^\d{2}:\d{2}$/.test(e.target.value)) return;
  saveCfg({ ghDeployTime: e.target.value });
  state._ghNightlyRan = null; // allow tonight's new window
  toast(`Nightly deploys will run at ${e.target.value}`, 'info', 4500);
  renderInsights(state.lastPer || []);
});

// (the old blanket "notify me" switch was replaced by Settings → Notifications)

$('setting-upd-enabled').addEventListener('change', (e) => {
  saveCfg({ updEnabled: e.target.checked });
  if (!e.target.checked) { state.updates = null; renderInsights(state.lastPer || []); }
  else checkUpdates(true);
  toast(e.target.checked ? 'Image update checks on' : 'Image update checks off — "Check now" still works manually', 'info', 4500);
});

$('setting-gh-enabled').addEventListener('change', (e) => {
  saveCfg({ ghEnabled: e.target.checked });
  if (!e.target.checked) { state.ghNew = []; renderInsights(state.lastPer || []); }
  else checkGhReleases(true);
  toast(e.target.checked ? 'GitHub watch on' : 'GitHub watch off — auto-deploy is paused too', 'info', 4500);
});

$('ghwatch-add-btn').addEventListener('click', async () => {
  const raw = $('ghwatch-repo').value.trim();
  if (!raw) { toast('Enter a repo as owner/repo', 'error'); return; }
  const btn = $('ghwatch-add-btn');
  btn.disabled = true; btn.textContent = 'Checking…';
  const r = await api.github.latestRelease({ repo: raw });
  btn.disabled = false; btn.textContent = 'Watch';
  if (!r.ok) { toast(r.error || 'Repo not found', 'error', 6000); return; }
  const watch = state.config.ghWatch || [];
  if (watch.includes(r.repo)) { toast('Already watching ' + r.repo, 'info'); return; }
  // Baseline the current state so only FUTURE commits/releases alert
  saveCfg({
    ghWatch: [...watch, r.repo],
    ghSeen: { ...(state.config.ghSeen || {}), [r.repo]: { tag: r.tag || '', sha: (r.commit && r.commit.sha) || '' } },
    ghIgnored: (state.config.ghIgnored || []).filter(x => x !== r.repo) // manual add overrides an earlier removal
  });
  state.ghLatest = { ...(state.ghLatest || {}), [r.repo]: r };
  $('ghwatch-repo').value = '';
  toast(`Watching ${r.repo} — you'll be alerted on the next commit or release.`, 'success', 6000);
  renderGhWatchList();
});

$('upd-check-now-btn').addEventListener('click', async () => {
  const btn = $('upd-check-now-btn');
  btn.disabled = true; btn.textContent = 'Checking…';
  await checkUpdates(true, true);
  btn.disabled = false; btn.textContent = 'Check now';
});

$('ghwatch-check-btn').addEventListener('click', async () => {
  const btn = $('ghwatch-check-btn');
  const n = (state.config.ghWatch || []).length;
  if (!n) { toast('Add a repo to watch first', 'info'); return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  await checkGhReleases(true);
  btn.disabled = false; btn.textContent = 'Check now';
  renderGhWatchList();
  const found = (state.ghNew || []).length;
  toast(found ? `${found} repo${found > 1 ? 's have' : ' has'} something new — see Insights` : 'Watched repos: nothing new ✓', found ? 'info' : 'success');
});

// Menu bar toggle
$('setting-tray').addEventListener('change', async (e) => {
  const v = e.target.checked;
  saveCfg({ trayEnabled: v });
  await api.setTray(v);
  toast(v ? 'Menu bar companion enabled' : 'Menu bar icon hidden — closing the window now quits', 'info', 4500);
});

// Alert count badge toggle
$('setting-alertbadge').addEventListener('change', (e) => {
  saveCfg({ alertBadge: e.target.checked });
  loadDashboard();
  toast(e.target.checked ? 'Alert count shown' : 'Alert count hidden — alerts still listed on the dashboard', 'info', 4000);
});

// Theme picker
document.querySelectorAll('#theme-picker .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    saveCfg({ theme: b.dataset.themeOpt });
    applyTheme(b.dataset.themeOpt);
  }));

// Logo picker
document.querySelectorAll('#logo-picker .logo-swatch').forEach(s =>
  s.addEventListener('click', () => {
    saveCfg({ logo: s.dataset.logo });
    applyLogo(s.dataset.logo);
    toast('Logo updated', 'success');
  }));

// Autostart
$('setting-autostart').addEventListener('change', async (e) => {
  const v = await api.appx.setLoginItem(e.target.checked);
  toast(v ? 'Portside will launch at login' : 'Autostart disabled', 'info');
});

// Cert import / reset (for the active host)
$('cert-import-btn').addEventListener('click', async () => {
  const h = activeHost();
  const r = await api.certs.import({ hostId: h ? h.id : null });
  if (r.canceled) return;
  if (!r.ok) { toast(r.error || 'Import failed', 'error'); return; }
  if (r.active) {
    toast('Certificates imported — testing connection…', 'success');
    const t = await api.docker.info(state.config);
    toast(t.ok ? `Connected with new certs (Docker ${t.data.ServerVersion})` : 'New certs failed: ' + t.error, t.ok ? 'success' : 'error', 5000);
  } else {
    toast(`Imported ${r.placed.length} file(s) — still need: ${r.missing.join(', ')}`, 'info', 6000);
  }
  refreshCertStatus();
});

$('cert-reset-btn').addEventListener('click', async () => {
  if (!confirm('Remove imported certificates and revert to the bundled ones?')) return;
  const h = activeHost();
  await api.certs.reset({ hostId: h ? h.id : null });
  await api.certs.reset({});
  toast('Reverted to bundled certificates', 'success');
  refreshCertStatus();
});

// Git Deploy token (shared by every app; managed here in Settings)
async function refreshGitTokenState() {
  try {
    const r = await api.gitdeploy.tokenState();
    const has = !!(r && r.hasToken);
    $('gitdeploy-token-state').innerHTML = has
      ? '<span style="color:#3fb950">✓ Token saved</span> — shared by every app.'
      : '<span style="color:var(--text-muted)">No token saved yet.</span> Add one to enable Git Deploy.';
    $('gitdeploy-token-clear').style.display = has ? '' : 'none';
    $('gitdeploy-token').placeholder = has ? 'github_pat_… (leave blank to keep current)' : 'github_pat_…';
  } catch {}
}
$('gitdeploy-token-save').addEventListener('click', async () => {
  const tok = $('gitdeploy-token').value.trim();
  if (!tok) { toast('Paste your github_pat_… token first', 'error'); return; }
  const r = await api.gitdeploy.tokenSet({ token: tok });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not save token', 'error'); return; }
  $('gitdeploy-token').value = '';
  toast('GitHub token saved', 'success');
  refreshGitTokenState();
});
$('gitdeploy-token-clear').addEventListener('click', async () => {
  if (!confirm('Remove the saved GitHub token? Git Deploy will stop working until you add one again.')) return;
  await api.gitdeploy.tokenClear();
  $('gitdeploy-token').value = '';
  toast('GitHub token removed', 'info');
  refreshGitTokenState();
});

$('save-interval-btn').addEventListener('click', () => {
  state.refreshInterval = parseInt($('setting-interval').value);
  saveCfg({ refreshInterval: state.refreshInterval });
  startAutoRefresh();
  toast(state.refreshInterval ? `Auto refresh: every ${state.refreshInterval/1000}s` : 'Auto refresh off', 'info');
});

