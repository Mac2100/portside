// ─── Insights (v3) — an action list, not a dashboard ─────────────────────────
// Rules:
//   • Only things that PERSIST and that you can DO something about get in here.
//     Live metrics (CPU spikes, network/disk hogs, trends) live on the Dashboard —
//     they popped in and out of this list and were pure noise.
//   • Every item is a stable, durable condition: broken container, available
//     update, or reclaimable junk. Nothing auto-appears and auto-vanishes.
//   • Three sections: Needs attention / Updates / Housekeeping.
//   • Nothing to do → one quiet "All clear" panel.

const INS_SECTIONS = [
  ['attention', '⚠️ Needs attention'],
  ['updates', '⬆️ Updates'],
  ['housekeeping', '🧹 Housekeeping']
];

function computeInsights(per) {
  const items = [];
  const name1 = c => sanitizeName(c.Names && c.Names[0]);
  const add = (o) => items.push(o);

  // — Needs attention — durable, broken states only. No live CPU/mem/IO items:
  //   those flapped in and out on every poll. Live load lives on the Dashboard.
  const inspects = Object.entries(state.inspectCache);

  state.containers.filter(c => /unhealthy/i.test(c.Status || '')).forEach(c =>
    add({ key: 'unhealthy-' + c.Id, section: 'attention', sev: 'crit', icon: '⚠️', cid: c.Id,
      title: `Unhealthy — ${name1(c)}`, sub: `Its own HEALTHCHECK is failing · ${c.Status || ''}`, value: '',
      actions: `<button class="btn" data-act="logs" data-cid="${c.Id}">Logs</button>` }));

  state.containers.filter(c => /restarting/i.test(c.State || '')).forEach(c =>
    add({ key: 'restarting-' + c.Id, section: 'attention', sev: 'crit', icon: '♻️', cid: c.Id,
      title: `Restart loop — ${name1(c)}`, sub: `${c.Status || ''} · it keeps dying and Docker keeps bringing it back`, value: '',
      actions: `<button class="btn" data-act="logs" data-cid="${c.Id}">Logs</button>` }));

  state.containers.forEach(c => {
    const m = /Exited \((\d+)\)/.exec(c.Status || '');
    if (!m || m[1] === '0') return;
    // If we snapshotted the logs when it died, offer them — the container's own
    // logs may already be gone (recreated), but ours aren't.
    const snap = typeof crashLogFor === 'function' ? crashLogFor(name1(c)) : null;
    add({ key: 'crashed-' + c.Id, section: 'attention', sev: 'warn', icon: '💥', cid: c.Id,
      title: `Crashed — ${name1(c)}`,
      sub: `${c.Status} · exited with a non-zero code${snap ? ` · logs captured ${new Date(snap.time).toLocaleTimeString()}` : ''}`,
      value: 'exit ' + m[1],
      actions:
        (snap ? `<button class="btn btn-warn" data-act="crashlog" data-file="${escHtml(snap.file)}">💥 Crash log</button>` : '') +
        `<button class="btn" data-act="logs" data-cid="${c.Id}">Logs</button>` +
        `<button class="btn btn-success" data-act="start" data-cid="${c.Id}">▶ Start</button>` });
  });

  // Restart counts — only worth flagging when it's actually flapping (≥3),
  // and only for containers that aren't already listed above.
  inspects.forEach(([id, x]) => {
    const n = x.RestartCount || 0;
    if (n < 3) return;
    const c = state.containers.find(k => k.Id === id);
    if (!c || /restarting/i.test(c.State || '')) return;
    add({ key: 'restarts-' + id, section: 'attention', sev: 'warn', icon: '🔁', cid: id,
      title: `${name1(c)} has restarted ${n}×`, sub: 'Docker has had to bring it back repeatedly — check its logs', value: '',
      actions: `<button class="btn" data-act="logs" data-cid="${id}">Logs</button>` });
  });

  // — Updates —
  if (state.appUpdate && state.appUpdate.newer)
    add({ key: 'app-update', section: 'updates', sev: 'info', icon: '🎁',
      title: `Portside v${state.appUpdate.latest} is out`, sub: `You're on v${state.appUpdate.current}`, value: '',
      actions: `<button class="btn btn-primary" data-act="app-upd">Get update</button>` });

  ((state.updates && state.updates.results) || []).filter(u => u.updateAvailable).forEach(u => {
    const stuck = u.remoteDigest && (state.config.updAutoApplied || {})[u.image] === u.remoteDigest;
    add({ key: 'img-' + u.image, section: 'updates', sev: 'warn', icon: stuck ? '⚠️' : '⬆️',
      title: stuck ? `${u.shortName} — updated, but the registry still reports a difference` : `Image update — ${u.shortName}`,
      sub: stuck
        ? `${u.image} · Auto-update already pulled this version. The digest still doesn't match the registry, so auto-update is paused for it. Update manually to retry, or ignore if the container works.`
        : `${u.image} · Update pulls the new image and recreates these containers (config kept, auto-rollback on failure):`,
      value: '',
      chips: u.containers.map(c => ({ label: c.name, cls: '', cid: c.id })),
      actions: `<button class="btn btn-warn" data-act="upd" data-img="${escHtml(u.image)}">Update</button>` });
  });

  (state.ghNew || []).forEach(g => {
    const cfg = ghCfgFor(g.repo);
    const mode = ghModeFor(g.repo);
    const base = g.kind === 'commit' ? `latest: ${(g.msg || '').slice(0, 70)}` : `${g.tag}${g.name && g.name !== g.tag ? ' · ' + g.name : ''}`;
    const tail = !cfg.container ? ''
      : mode === 'scheduled' ? ` · 🌙 queued — ${cfg.container} deploys at ${ghDeployTime()} (or Deploy now)`
      : ` · Deploy pulls it onto the NAS and restarts ${cfg.container}`;
    add({ key: 'gh-' + g.repo, section: 'updates', sev: 'warn', icon: mode === 'scheduled' ? '🌙' : '🐙',
      title: `${g.kind === 'commit' ? 'New commits' : 'New release'} — ${g.repo}`,
      sub: base + tail,
      value: '',
      chips: cfg.container ? [{ label: cfg.container, cls: '', cid: (state.containers.find(x => sanitizeName(x.Names && x.Names[0]) === cfg.container) || {}).Id }] : [],
      actions: (cfg.container ? `<button class="btn btn-warn" data-act="gh-deploy" data-repo="${escHtml(g.repo)}">⬆ Deploy</button>` : '') +
        `<button class="btn" data-act="gh-view" data-url="${escHtml(g.url)}">View</button><button class="btn" data-act="gh-seen" data-repo="${escHtml(g.repo)}" title="Mark as seen">✓</button>` });
  });

  // — Housekeeping —
  const exited = state.containers.filter(c => (c.State || '').toLowerCase() === 'exited');
  if (exited.length)
    add({ key: 'stopped', section: 'housekeeping', sev: 'info', icon: '💤',
      title: `${exited.length} stopped container${exited.length > 1 ? 's' : ''}`,
      sub: 'Click a name to open it · "Remove all" deletes every stopped container (data in volumes/bind mounts is kept)', value: '',
      chips: exited.map(c => ({ label: name1(c), cls: '', cid: c.Id })),
      actions: `<button class="btn btn-warn" data-act="prune-stopped">Remove all</button>` });

  if (state.df) {
    const dangling = (state.df.Images || []).filter(i => !(i.RepoTags || []).length || i.RepoTags[0] === '<none>:<none>');
    if (dangling.length) {
      const reclaim = dangling.reduce((a, i) => a + (i.Size || 0), 0);
      add({ key: 'dangling', section: 'housekeeping', sev: 'warn', icon: '🧹',
        title: `${dangling.length} dangling image${dangling.length > 1 ? 's' : ''} — ~${fmt(reclaim)} reclaimable`,
        sub: 'Untagged leftover layers from old image versions. Nothing uses them — safe to prune.', value: '',
        actions: `<button class="btn" data-act="view-dangling">View</button><button class="btn btn-warn" data-act="clean-imgs">Clean up…</button>` });
    }
    const volsArr = state.df.Volumes || [];
    const unusedVols = volsArr.filter(v => (v.UsageData && v.UsageData.RefCount === 0));
    if (unusedVols.length) {
      const sz = unusedVols.reduce((a, v) => a + ((v.UsageData && v.UsageData.Size > 0) ? v.UsageData.Size : 0), 0);
      add({ key: 'unusedvols', section: 'housekeeping', sev: 'info', icon: '🗃️',
        title: `${unusedVols.length} unused volume${unusedVols.length > 1 ? 's' : ''}`,
        sub: `Not attached to any container${sz > 0 ? ' · ~' + fmt(sz) : ''} · ⚠ pruning deletes their data`, value: '',
        actions: `<button class="btn" data-act="view-unusedvols">View</button><button class="btn btn-warn" data-act="prune-vols">Prune</button>` });
    }
  }

  return items;
}

// Storage line shown next to the Housekeeping heading (was its own "Status" card)
function housekeepingMeta() {
  if (!state.df) return '';
  const volsArr = state.df.Volumes || [];
  const layers = state.df.LayersSize || 0;
  const vols = volsArr.reduce((a, v) => a + ((v.UsageData && v.UsageData.Size > 0) ? v.UsageData.Size : 0), 0);
  return `${fmt(layers)} images · ${fmt(vols)} volumes · ${(state.df.Containers || []).length} containers`;
}

function renderInsights(per) {
  const items = computeInsights(per || []);

  // Alert badge — only real, durable problems count
  const alerts = items.filter(i => i.sev === 'crit' || i.sev === 'warn').length;
  const shown = state.config.alertBadge !== false ? alerts : 0;
  const badge = $('nav-alerts-count');
  badge.style.display = shown ? '' : 'none';
  badge.textContent = shown;
  state.alertCount = shown;
  api.dockBadge(shown);

  const updLbl = $('insights-updated');
  if (updLbl) updLbl.textContent = 'updated ' + new Date().toLocaleTimeString();

  // ── Reconcile DOM in place ──
  const root = $('insights-list');
  if (!root.dataset.init) {
    root.dataset.init = '1';
    root.innerHTML =
      `<div class="ins-allclear" id="ins-allclear" style="display:none">
         <div class="ins-allclear-icon">✓</div>
         <div class="ins-allclear-title">All clear</div>
         <div class="ins-allclear-sub">Nothing needs your attention — no broken containers, no updates waiting, nothing to clean up.</div>
         <div class="ins-allclear-meta" id="ins-allclear-meta"></div>
       </div>` +
      INS_SECTIONS.map(([id, label]) =>
        `<div class="ins-sec" data-sec="${id}" style="display:none">
           <div class="ins-sec-title">${label}<span class="ins-sec-count"></span><span class="ins-sec-meta"></span></div>
           <div class="ins-sec-body"></div>
         </div>`).join('');
  }

  // Nothing to do at all → one quiet panel, no cards
  const allClear = $('ins-allclear');
  allClear.style.display = items.length ? 'none' : '';
  if (!items.length) {
    const meta = housekeepingMeta();
    $('ins-allclear-meta').textContent =
      (meta ? meta + ' · ' : '') + 'checked ' + new Date().toLocaleTimeString();
  }

  const sevRank = { crit: 0, warn: 1, info: 2, none: 3, good: 4 };
  for (const [secId] of INS_SECTIONS) {
    const secEl = root.querySelector(`.ins-sec[data-sec="${secId}"]`);
    const body = secEl.querySelector('.ins-sec-body');
    const secItems = items.filter(i => i.section === secId)
      .sort((a, b) => (sevRank[a.sev] ?? 3) - (sevRank[b.sev] ?? 3) || a.title.localeCompare(b.title));

    secEl.style.display = secItems.length ? '' : 'none';
    secEl.querySelector('.ins-sec-count').textContent = secItems.length || '';
    secEl.querySelector('.ins-sec-meta').textContent = secId === 'housekeeping' ? housekeepingMeta() : '';

    const wanted = new Set(secItems.map(i => i.key));
    [...body.children].forEach(n => { if (!wanted.has(n.dataset.key)) n.remove(); });

    secItems.forEach(i => {
      let node = body.querySelector(`[data-key="${CSS.escape(i.key)}"]`);
      if (!node) {
        node = document.createElement('div');
        node.dataset.key = i.key;
        node.innerHTML = `<div class="ins-icon"></div>
          <div class="ins-body"><div class="ins-title"></div><div class="ins-sub"></div><div class="ins-chips"></div></div>
          <div class="ins-value"></div><div class="ins-act"></div>`;
        body.appendChild(node);
      }
      const cls = `ins-item sev-${i.sev}${i.cid ? ' clickable' : ''}`;
      if (node.className !== cls) node.className = cls;
      if (i.cid) node.dataset.cid = i.cid; else delete node.dataset.cid;
      const set = (sel, txt) => { const el2 = node.querySelector(sel); if (el2.textContent !== txt) el2.textContent = txt; };
      set('.ins-icon', i.icon);
      set('.ins-title', i.title);
      set('.ins-sub', i.sub || '');
      set('.ins-value', i.value || '');
      const chipsEl = node.querySelector('.ins-chips');
      const ch = (i.chips || []).map(c =>
        `<span class="chip ${c.cls || ''}${c.cid ? ' clk' : ''}"${c.cid ? ` data-cid="${c.cid}"` : ''}>${escHtml(c.label)}</span>`).join('');
      if (chipsEl.dataset.h !== ch) { chipsEl.dataset.h = ch; chipsEl.innerHTML = ch; chipsEl.style.display = ch ? '' : 'none'; }
      const act = node.querySelector('.ins-act');
      const ah = i.actions || '';
      if (act.dataset.h !== ah) { act.dataset.h = ah; act.innerHTML = ah; }
    });

    // Fix ordering without destroying nodes (appendChild moves in place)
    const order = secItems.map(i => i.key);
    const current = [...body.children].map(n => n.dataset.key);
    if (order.join('\n') !== current.join('\n'))
      order.forEach(k => body.appendChild(body.querySelector(`[data-key="${CSS.escape(k)}"]`)));
  }
}

// One delegated listener — attached once, survives every re-render
$('insights-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) { e.stopPropagation(); await insightsAction(btn); return; }
  const chip = e.target.closest('.chip[data-cid]');
  if (chip) { openDetail(chip.dataset.cid); return; }
  const item = e.target.closest('.ins-item[data-cid]');
  if (item) openDetail(item.dataset.cid);
});

async function insightsAction(btn) {
  const act = btn.dataset.act;

  if (act === 'crashlog') { openCrashLog(btn.dataset.file); return; }

  if (act === 'logs' || act === 'start') {
    const id = btn.dataset.cid;
    const c = state.containers.find(x => x.Id === id);
    const nm = c ? sanitizeName(c.Names && c.Names[0]) : id.slice(0, 12);
    if (act === 'logs') { openLogs(id, nm); return; }
    if (await runContainerAction(id, 'start', nm, btn)) setTimeout(loadDashboard, 1500);
    return;
  }

  if (act === 'view-dangling') { state.imageFilter = 'dangling'; showPage('images'); loadImages(); return; }
  if (act === 'view-unusedvols') { state.volumeFilter = 'unused'; showPage('volumes'); loadVolumes(); return; }

  if (act === 'app-upd') { api.openUrl(state.appUpdate.url); return; }
  if (act === 'gh-view') { api.openUrl(btn.dataset.url); return; }
  if (act === 'gh-seen') { markGhSeen(btn.dataset.repo); return; }
  if (act === 'gh-deploy') { await ghDeploy(btn.dataset.repo, btn); return; }

  if (act === 'upd') {
    const u = (state.updates?.results || []).find(x => x.image === btn.dataset.img);
    if (!u) return;
    if (!confirm(`Update ${u.shortName}?\n\nThis pulls the new image and recreates: ${u.containers.map(c => c.name).join(', ')}.\nConfig, ports and volumes are preserved. If anything fails, the old container is restored.`)) return;
    btn.disabled = true; btn.textContent = 'Updating…';
    toast(`Pulling ${u.image} — this can take a few minutes…`, 'info', 8000);
    let okCount = 0;
    for (const c of u.containers) {
      const r = await api.updates.apply({ ...state.config, id: c.id });
      if (r.ok) { okCount++; toast(`${c.name} updated ✓`, 'success', 5000); }
      else toast(`${c.name}: ${r.error}`, 'error', 8000);
    }
    if (okCount && u.remoteDigest)
      saveCfg({ updAutoApplied: { ...(state.config.updAutoApplied || {}), [u.image]: u.remoteDigest } });
    const rc = await api.updates.check({ ...state.config, force: true });
    if (rc.ok) state.updates = rc;
    loadDashboard();
    return;
  }

  // Image cleanup always goes through the same sheet as the Images page
  if (act === 'clean-imgs') { await ensureContainers(); openCleanup(); return; }

  // Both of these delete things for good. Volumes destroy DATA, so they use the
  // type-the-name modal; stopped containers can be recreated, so a double confirm.
  if (act === 'prune-vols' || act === 'prune-stopped') {
    const conf = {
      'prune-vols': [
        () => confirmVolumePrune(),
        () => api.docker.pruneVolumes(state.config),
        d => `Removed ${(d.VolumesDeleted || []).length} volumes — reclaimed ${fmt(d.SpaceReclaimed || 0)}`],
      'prune-stopped': [
        () => confirmDestructive(
          'Remove ALL stopped containers?',
          'Their config, ports and logs are deleted. Images, volumes and bind-mounted data are untouched — but you\'ll have to recreate the containers themselves.',
          'Delete every stopped container.'),
        () => api.docker.pruneContainers(state.config),
        d => `Removed ${(d.ContainersDeleted || []).length} stopped containers — reclaimed ${fmt(d.SpaceReclaimed || 0)}`]
    }[act];
    if (!(await conf[0]())) return;
    btn.disabled = true; btn.textContent = 'Working…';
    const r = await conf[1]();
    if (r.ok) { toast(conf[2](r.data || {}), 'success', 6000); state.dfFetched = 0; await loadDashboard(); }
    else { toast('Failed: ' + r.error, 'error', 7000); btn.disabled = false; btn.textContent = 'Retry'; }
  }
}

function setConnected(ok) {
  $('conn-dot').className = 'status-dot' + (ok ? ' connected' : '');
  $('conn-label').textContent = ok ? `${state.config.host}:${state.config.port}` : 'Disconnected';
}

