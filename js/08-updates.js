// ─── Portside self-update ─────────────────────────────────────────────────────
async function checkAppUpdate(announce) {
  const r = await api.appUpdate.check();
  if (!r.ok) { if (announce) toast('Update check failed: ' + r.error, 'error'); return; }
  state.appUpdate = r;
  $('about-version').textContent = 'v' + r.current;
  if (r.newer) {
    const dl = r.dmgUrl
      ? `<button class="btn btn-primary" id="get-update-btn" style="margin-top:6px">⬇ Download &amp; install v${r.latest}</button> <span id="update-progress" style="font-size:11px;color:var(--text-muted)"></span>`
      : `<span class="crumb" id="get-update-link">open the release on GitHub</span>`;
    $('about-update-status').innerHTML = `🎉 v${r.latest} available. ${dl}`;
    if (r.dmgUrl) {
      $('get-update-btn').addEventListener('click', async () => {
        const btn = $('get-update-btn'); btn.disabled = true;
        api.appUpdate.onProgress((p) => { $('update-progress').textContent = 'Downloading… ' + p + '%'; });
        toast('Downloading the installer…', 'info', 6000);
        const d = await api.appUpdate.download({ url: r.dmgUrl, name: r.assetName });
        if (d.ok) { $('update-progress').textContent = 'Installer opened — drag Portside → Applications, then reopen.'; toast('Installer opened — drag Portside into Applications, then reopen', 'success', 9000); }
        else { $('update-progress').textContent = ''; btn.disabled = false; toast('Download failed: ' + d.error, 'error'); }
      });
    } else {
      document.getElementById('get-update-link').addEventListener('click', () => api.openUrl(r.url));
    }
    if (announce) toast(`Portside v${r.latest} is available — see Settings`, 'info', 6000);
    renderInsights(state.lastPer || []);
  } else if (announce) {
    $('about-update-status').textContent = `You're on the latest version ✓`;
    toast('Portside is up to date ✓', 'success');
  }
}

$('check-app-update-btn').addEventListener('click', () => checkAppUpdate(true));
$('open-github-btn').addEventListener('click', () => api.openUrl('https://github.com/Mac2100/portside'));
api.appUpdate.version().then(v => { $('about-version').textContent = 'v' + v; });
setTimeout(() => checkAppUpdate(false), 8000);
setInterval(() => checkAppUpdate(false), 24 * 3600e3);

async function checkUpdates(force, announce) {
  if (state.config.updEnabled === false && !announce) return; // disabled — manual checks still allowed
  const btn = $('updates-btn');
  btn.disabled = true; btn.textContent = '⬆ Checking…';
  const r = await api.updates.check({ ...state.config, force });
  btn.disabled = false; btn.textContent = '⬆ Check updates';
  if (!r.ok) { if (announce) toast('Update check failed: ' + r.error, 'error'); return; }
  state.updates = r;
  const avail = r.results.filter(u => u.updateAvailable);
  if (announce) toast(avail.length ? `${avail.length} image update${avail.length > 1 ? 's' : ''} available` : 'Everything is up to date ✓', avail.length ? 'info' : 'success');

  // Notify once per image (not every 6h re-check)
  const notified = new Set(state.config.updNotified || []);
  const fresh = avail.filter(u => !notified.has(u.image));
  if (fresh.length && !announce)
    notify('imageUpdate', `Image update${fresh.length > 1 ? 's' : ''} available: ${fresh.map(u => u.shortName).join(', ')}`);
  saveCfg({ updNotified: avail.map(u => u.image) });

  renderInsights(state.lastPer || []);
  autoApplyUpdates(avail);
}

$('updates-btn').addEventListener('click', () => checkUpdates(true, true));

// ─── Auto-update: redeploy opted-in containers ONLY when the registry has something new ──
async function autoApplyUpdates(avail) {
  if (state._autoUpdating) return;
  const auto = state.config.autoUpdate || {};
  const alreadyApplied = state.config.updAutoApplied || {};
  const jobs = [];
  for (const u of avail) {
    // Safety net: never auto-apply the SAME remote digest twice. If the check
    // still reports an update after we already updated to this exact digest,
    // something is off (e.g. registry quirk) — surface it, don't loop forever.
    if (u.remoteDigest && alreadyApplied[u.image] === u.remoteDigest) continue;
    for (const c of u.containers) if (auto[c.name]) jobs.push({ u, c });
  }
  if (!jobs.length) return;
  state._autoUpdating = true;
  try {
    let applied = 0;
    const appliedDigests = { ...alreadyApplied };
    for (const { u, c } of jobs) {
      toast(`Auto-updating ${c.name} (${u.shortName})…`, 'info', 7000);
      const r = await api.updates.apply({ ...state.config, id: c.id });
      if (r.ok) {
        applied++;
        if (u.remoteDigest) appliedDigests[u.image] = u.remoteDigest;
        toast(`${c.name} auto-updated ✓`, 'success', 6000);
        notify('imageUpdate', `${c.name} was updated to the latest ${u.shortName} image`);
      } else {
        toast(`${c.name} auto-update failed: ${r.error}`, 'error', 9000);
        notify('imageUpdate', `Auto-update of ${c.name} failed — the old container was restored`);
      }
    }
    if (applied) {
      saveCfg({ updAutoApplied: appliedDigests });
      const rc = await api.updates.check({ ...state.config, force: true });
      if (rc.ok) state.updates = rc;
      loadDashboard();
    }
  } finally { state._autoUpdating = false; }
}

// ─── GitHub watching (releases + commits on the default branch) ───────────────
function ghSeenFor(repo) {
  const s = (state.config.ghSeen || {})[repo];
  if (!s) return {};
  return typeof s === 'string' ? { tag: s } : s; // migrate old string form
}

// Git Deploy is the single source of truth: any repo configured on a container
// is watched + linked automatically. No double entry. Repos you explicitly
// removed from the watch list (ghIgnored) stay removed.
async function syncGhFromGitDeploy() {
  try {
    const deploys = await api.gitdeploy.list();
    const ignored = new Set(state.config.ghIgnored || []);
    let watch = [...(state.config.ghWatch || [])];
    const cfgAll = { ...(state.config.ghWatchCfg || {}) };
    let changed = false;
    for (const [container, d] of Object.entries(deploys || {})) {
      const repo = repoFromUrl(d.repoUrl);
      if (!repo || ignored.has(repo)) continue;
      if (!watch.includes(repo)) { watch.push(repo); changed = true; } // first check baselines it silently
      const cfg = cfgAll[repo] || {};
      if (cfg.container === undefined) { cfgAll[repo] = { ...cfg, container }; changed = true; }
    }
    if (changed) saveCfg({ ghWatch: watch, ghWatchCfg: cfgAll });
  } catch {}
}

async function checkGhReleases(announce) {
  if (state.config.ghEnabled === false && !announce) return; // disabled — manual checks still allowed
  await syncGhFromGitDeploy();
  const watch = state.config.ghWatch || [];
  if (!watch.length) { state.ghNew = []; return; }
  const prevNew = new Set((state.ghNew || []).map(g => g.repo + '@' + g.what));
  const found = [];
  state.ghLatest = state.ghLatest || {};
  for (const repo of watch) {
    const r = await api.github.latestRelease({ repo });
    if (!r.ok) { if (announce) toast(`${repo}: ${r.error}`, 'error', 6000); continue; }
    state.ghLatest[r.repo] = r;
    const seen = ghSeenFor(r.repo);
    const markSeen = { tag: r.tag || seen.tag || '', sha: (r.commit && r.commit.sha) || seen.sha || '' };
    if (r.tag && seen.tag && seen.tag !== r.tag) {
      found.push({ repo: r.repo, kind: 'release', what: r.tag, tag: r.tag, name: r.name, url: r.url, markSeen });
    } else if (r.commit && seen.sha && seen.sha !== r.commit.sha) {
      found.push({ repo: r.repo, kind: 'commit', what: r.commit.shortSha, tag: r.commit.shortSha, name: '', msg: r.commit.msg, url: r.commit.url, markSeen });
    } else if ((r.tag && !seen.tag) || (r.commit && !seen.sha)) {
      // First sighting of this repo (or of a new data type): baseline it silently
      saveCfg({ ghSeen: { ...(state.config.ghSeen || {}), [r.repo]: markSeen } });
    }
  }
  state.ghNew = found;
  const fresh = found.filter(g => !prevNew.has(g.repo + '@' + g.what));
  if (fresh.length) {
    const line = (g) => {
      const base = g.kind === 'commit' ? `New commits on ${g.repo} (${g.what})` : `New release: ${g.repo} ${g.tag}`;
      const mode = ghModeFor(g.repo);
      if (mode === 'scheduled' && ghCfgFor(g.repo).container) return `${base} — deploys tonight at ${ghDeployTime()}`;
      if (mode === 'auto' && ghCfgFor(g.repo).container) return `${base} — deploying now`;
      return base;
    };
    notify('ghRelease', fresh.map(line).join('\n'));
  }
  if (typeof renderGhWatchList === 'function' && $('page-settings').classList.contains('active')) renderGhWatchList();
  renderInsights(state.lastPer || []);
  ghAutoDeploy(found);
}

function markGhSeen(repo) {
  const g = (state.ghNew || []).find(x => x.repo === repo);
  if (!g) return;
  saveCfg({ ghSeen: { ...(state.config.ghSeen || {}), [repo]: g.markSeen } });
  state.ghNew = state.ghNew.filter(x => x.repo !== repo);
  renderInsights(state.lastPer || []);
}

// ─── Repo ↔ container links (per-repo settings for GitHub Watch) ──────────────
function ghCfgFor(repo) { return (state.config.ghWatchCfg || {})[repo] || {}; }
function setGhCfg(repo, patch) {
  const all = { ...(state.config.ghWatchCfg || {}) };
  all[repo] = { ...(all[repo] || {}), ...patch };
  saveCfg({ ghWatchCfg: all });
}
// Deploy mode: 'notify' (alert + button) · 'auto' (deploy immediately) · 'scheduled' (nightly window)
function ghModeFor(repo) {
  const cfg = ghCfgFor(repo);
  return cfg.mode || (cfg.autoDeploy ? 'auto' : 'notify'); // migrate old autoDeploy flag
}
function ghDeployTime() { return state.config.ghDeployTime || '03:00'; }
function repoFromUrl(url) {
  const m = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/i.exec(String(url || ''));
  return m ? m[1] : null;
}

// Deploy the linked container for a watched repo (runs the existing Git Deploy:
// pull latest into the bind-mounted app folder, then restart the container).
async function ghDeploy(repo, btn) {
  const cfg = ghCfgFor(repo);
  if (!cfg.container) { toast('Link this repo to a container first (Settings → GitHub Watch)', 'error', 6000); return false; }
  const c = state.containers.find(x => sanitizeName(x.Names && x.Names[0]) === cfg.container);
  if (btn) { btn.disabled = true; btn.textContent = 'Deploying…'; }
  toast(`Deploying ${repo} → ${cfg.container}…`, 'info', 7000);
  const r = await api.gitdeploy.run({ ...state.config, key: cfg.container, ref: 'latest', restartId: c ? c.Id : null });
  if (btn) { btn.disabled = false; btn.textContent = '⬆ Deploy'; }
  if (!r.ok) {
    toast(`${cfg.container}: ${(r.error || 'deploy failed').split('\n')[0]}`, 'error', 9000);
    notify('ghRelease', `Deploy of ${cfg.container} failed — open Git Deploy for details`);
    return false;
  }
  toast(`${cfg.container} deployed ${r.deployed || ''}${r.restarted ? ' · restarted' : ''} ✓`.trim(), 'success', 7000);
  notify('ghRelease', `${cfg.container} deployed from ${repo}${r.deployed ? ' (' + r.deployed.split(' ')[0] + ')' : ''}`);
  markGhSeen(repo);
  setTimeout(loadDashboard, 1500);
  return true;
}

// Auto mode: pushes get deployed hands-free, immediately.
// Each new commit/release is attempted ONCE — failures wait for your input
// (or the next push) instead of retrying every check.
async function ghAutoDeploy(found) {
  if (state._ghDeploying) return;
  state._ghAutoTried = state._ghAutoTried || {};
  const jobs = (found || []).filter(g =>
    ghModeFor(g.repo) === 'auto' && ghCfgFor(g.repo).container && state._ghAutoTried[g.repo] !== g.what);
  if (!jobs.length) return;
  state._ghDeploying = true;
  try {
    for (const g of jobs) {
      state._ghAutoTried[g.repo] = g.what;
      toast(`Auto-deploying ${g.repo} (${g.what})…`, 'info', 7000);
      await ghDeploy(g.repo);
    }
  } finally { state._ghDeploying = false; }
}

// Nightly mode: queued pushes deploy at the configured time. A 10-minute grace
// window covers sleep/wake jitter; pushes that land AFTER the window wait for
// the next night. Runs at most once per day.
setInterval(ghScheduledTick, 30000);
async function ghScheduledTick() {
  if (state.config.ghEnabled === false || state._ghDeploying) return;
  const queued = (state.ghNew || []).filter(g => {
    const cfg = ghCfgFor(g.repo);
    return ghModeFor(g.repo) === 'scheduled' && cfg.container &&
      (state._ghAutoTried || {})[g.repo] !== g.what;
  });
  if (!queued.length) return;
  const [hh, mm] = ghDeployTime().split(':').map(Number);
  const now = new Date();
  const target = new Date(now); target.setHours(hh || 0, mm || 0, 0, 0);
  const todayKey = now.toDateString();
  if (state._ghNightlyRan === todayKey) return;
  if (now < target || now - target > 10 * 60e3) return; // outside tonight's window
  state._ghNightlyRan = todayKey;
  state._ghAutoTried = state._ghAutoTried || {};
  state._ghDeploying = true;
  try {
    toast(`Nightly deploy window — deploying ${queued.length} app${queued.length > 1 ? 's' : ''}…`, 'info', 8000);
    for (const g of queued) {
      state._ghAutoTried[g.repo] = g.what;
      await ghDeploy(g.repo);
    }
  } finally { state._ghDeploying = false; }
}

// ─── Update check scheduling — independent clocks for images and GitHub ───────
let updTimer = null, ghTimer = null;
function scheduleUpdateChecks() {
  if (updTimer) clearInterval(updTimer);
  if (ghTimer) clearInterval(ghTimer);
  const imgIv = state.config.updInterval !== undefined ? +state.config.updInterval : 3600e3; // default: hourly
  if (imgIv) updTimer = setInterval(() => checkUpdates(true), imgIv);
  const ghIv = state.config.ghInterval !== undefined ? +state.config.ghInterval : 900e3;     // default: 15 min
  if (ghIv) ghTimer = setInterval(() => checkGhReleases(), ghIv);
}

function showPage(name) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
}

