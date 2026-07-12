// ─── Deploy wizard ────────────────────────────────────────────────────────────
function kvRow(kind) {
  const ph = {
    ports: ['host port e.g. 8080', 'container port e.g. 80'],
    vols: ['host path e.g. /share/Container/app', 'container path e.g. /config'],
    envs: ['KEY=value e.g. TZ=America/New_York', null]
  }[kind];
  const div = document.createElement('div');
  div.className = 'kv-row';
  div.innerHTML = ph[1]
    ? `<input class="form-input small" data-k placeholder="${ph[0]}" spellcheck="false"><span class="crumb-sep">→</span><input class="form-input" data-v placeholder="${ph[1]}" spellcheck="false"><button class="kv-remove">✕</button>`
    : `<input class="form-input" data-k placeholder="${ph[0]}" spellcheck="false"><button class="kv-remove">✕</button>`;
  div.querySelector('.kv-remove').addEventListener('click', () => div.remove());
  return div;
}

function openDeploy() {
  ['dep-ports', 'dep-vols', 'dep-envs'].forEach(id => { $(id).innerHTML = ''; });
  $('dep-ports').appendChild(kvRow('ports'));
  $('dep-vols').appendChild(kvRow('vols'));
  $('dep-envs').appendChild(kvRow('envs'));
  $('dep-image').value = ''; $('dep-name').value = '';
  $('dep-memory').value = ''; $('dep-cpus').value = '';
  $('dep-restart').value = 'unless-stopped';
  const net = $('dep-network');
  net.innerHTML = '<option value="">default (bridge)</option>' +
    state.networks.filter(n => !['bridge', 'host', 'none'].includes(n.Name)).map(n => `<option value="${n.Name}">${n.Name}</option>`).join('');
  $('deploy-status').textContent = '';
  $('deploy-modal').classList.add('open');
  $('dep-image').focus();
}
function closeDeploy() { $('deploy-modal').classList.remove('open'); }

// ─── Git Deploy (pull the app folder from GitHub & restart, from within Portside) ─
let gdKey = null, gdRestartId = null, gdHasToken = false;

async function openGitDeploy(id, name) {
  gdKey = name; gdRestartId = id;
  $('gd-title').textContent = 'Git Deploy — ' + name;
  const out = $('gd-output'); out.style.display = 'none'; out.textContent = '';
  $('gd-versions').style.display = 'none'; $('gd-rollback-btn').style.display = 'none';
  $('gd-status').textContent = '';

  const saved = await api.gitdeploy.get({ key: name });
  $('gd-repo').value = (saved && saved.repoUrl) || '';
  $('gd-branch').value = (saved && saved.branch) || 'main';
  $('gd-folder').value = (saved && saved.folder) || '';
  gdHasToken = !!(saved && saved.hasToken);
  $('gd-token-note').innerHTML = gdHasToken
    ? 'GitHub token: <span style="color:#3fb950">saved ✓</span> — manage it in Settings → Git Deploy.'
    : '⚠ No GitHub token yet — add one in <b>Settings → Git Deploy</b> before deploying.';

  if (!$('gd-folder').value) {
    try {
      const ins = await api.docker.inspect({ ...state.config, id });
      const binds = ((ins.data && ins.data.Mounts) || []).filter(m => m.Type === 'bind');
      const appBind = binds.find(m => m.Destination === '/app') || binds.find(m => /\/app$/.test(m.Destination || '')) || binds[0];
      if (appBind) $('gd-folder').value = appBind.Source;
    } catch {}
  }
  $('gitdeploy-modal').classList.add('open');
}
// Closing always persists whatever is filled in — no silent data loss.
async function closeGitDeploy() {
  if (gdKey && ($('gd-repo').value.trim() || $('gd-folder').value.trim())) {
    try { await gdSave(true); } catch {}
  }
  $('gitdeploy-modal').classList.remove('open'); gdKey = null; gdRestartId = null;
}

async function gdSave(silent) {
  if (!gdKey) return;
  await api.gitdeploy.set({
    key: gdKey,
    repoUrl: $('gd-repo').value.trim(),
    branch: $('gd-branch').value.trim() || 'main',
    folder: $('gd-folder').value.trim()
  });
  await syncGhFromGitDeploy(); // configuring Git Deploy is all it takes — the repo is now watched
  if (!silent) toast('Git Deploy settings saved ✓', 'success');
}
function gdValid() {
  if (!$('gd-repo').value.trim()) { toast('Enter the GitHub repo URL', 'error'); return false; }
  if (!$('gd-folder').value.trim()) { toast('Enter the app folder path', 'error'); return false; }
  if (!gdHasToken) { toast('Add a GitHub token in Settings → Git Deploy first', 'error'); return false; }
  return true;
}
async function gdDeploy(ref) {
  if (!gdValid()) return;
  await gdSave(true);
  const out = $('gd-output'); out.style.display = ''; out.textContent = (ref ? 'Rolling back' : 'Pulling latest') + '…';
  $('gd-status').textContent = 'Working…';
  ['gd-deploy-btn','gd-versions-btn','gd-rollback-btn'].forEach(b => $(b).disabled = true);
  const r = await api.gitdeploy.run({ ...state.config, key: gdKey, ref: ref || 'latest', restartId: gdRestartId });
  ['gd-deploy-btn','gd-versions-btn','gd-rollback-btn'].forEach(b => $(b).disabled = false);
  $('gd-status').textContent = '';
  if (!r.ok) { out.textContent = (r.output || r.error || 'Failed').trim(); toast((r.error || 'Deploy failed').split('\n')[0], 'error'); return; }
  out.textContent = (r.output || '').trim();
  if (r.restartError) toast(r.restartError, 'error');
  else toast(`Deployed ${r.deployed || ''}${r.restarted ? ' · restarted' : ''}`.trim(), 'success');
  setTimeout(loadDashboard, 1500);
}
async function gdVersions() {
  if (!gdValid()) return;
  await gdSave(true);
  $('gd-versions-btn').disabled = true; $('gd-status').textContent = 'Fetching versions…';
  const r = await api.gitdeploy.versions({ ...state.config, key: gdKey });
  $('gd-versions-btn').disabled = false; $('gd-status').textContent = '';
  if (!r.ok || !(r.commits && r.commits.length)) { toast(r.error || 'No versions found', 'error'); return; }
  $('gd-versions').innerHTML = r.commits.map((c, i) =>
    `<option value="${c.sha}">${i === 0 ? '● latest · ' : ''}${c.sha.slice(0,7)} · ${(c.msg||'').replace(/"/g,'').slice(0,56)}</option>`).join('');
  $('gd-versions').style.display = ''; $('gd-rollback-btn').style.display = '';
}
$('gd-close-btn').addEventListener('click', closeGitDeploy);
$('gd-close-btn2').addEventListener('click', closeGitDeploy);
$('gd-save-btn').addEventListener('click', async () => {
  if (!$('gd-repo').value.trim()) { toast('Enter the GitHub repo URL', 'error'); return; }
  if (!$('gd-folder').value.trim()) { toast('Enter the app folder path', 'error'); return; }
  $('gd-save-btn').disabled = true;
  try { await gdSave(); } finally { $('gd-save-btn').disabled = false; }
});
$('gd-deploy-btn').addEventListener('click', () => gdDeploy(null));
$('gd-versions-btn').addEventListener('click', gdVersions);
$('gd-rollback-btn').addEventListener('click', () => {
  const sha = $('gd-versions').value;
  if (sha && confirm('Deploy commit ' + sha.slice(0,7) + '? This replaces the live files with that version, then restarts.')) gdDeploy(sha);
});

// ─── Edit container (recreate with modified config) ──────────────────────────
let editId = null;

function edKvRow(kind, k = '', v = '') {
  const row = kvRow(kind);
  const ki = row.querySelector('[data-k]'), vi = row.querySelector('[data-v]');
  if (ki) ki.value = k;
  if (vi) vi.value = v;
  return row;
}

async function openEditContainer(id) {
  const c = state.containers.find(x => x.Id === id);
  if (!c) return;
  const name = sanitizeName(c.Names && c.Names[0]);
  $('edit-title').textContent = 'Edit — ' + name;
  $('edit-status').textContent = 'Loading current config…';
  ['ed-ports', 'ed-vols', 'ed-envs'].forEach(i => { $(i).innerHTML = ''; });
  $('edit-modal').classList.add('open');

  const r = await api.docker.inspect({ ...state.config, id });
  if (!r.ok || !r.data) { toast('Inspect failed: ' + (r.error || ''), 'error'); $('edit-modal').classList.remove('open'); return; }
  const ins = r.data;
  editId = id;

  $('ed-image').value = ins.Config.Image || '';
  $('ed-name').value = name;

  // Ports from HostConfig.PortBindings (falls back to one empty row)
  const pb = (ins.HostConfig && ins.HostConfig.PortBindings) || {};
  const portRows = Object.entries(pb).flatMap(([key, binds]) => {
    const [cont] = key.split('/');
    return (binds || []).map(b => [b.HostPort || cont, cont]);
  });
  portRows.forEach(([h, ct]) => $('ed-ports').appendChild(edKvRow('ports', h, ct)));
  if (!portRows.length) $('ed-ports').appendChild(kvRow('ports'));

  // Volumes from Binds
  const binds = (ins.HostConfig && ins.HostConfig.Binds) || [];
  binds.forEach(b => {
    const i = b.indexOf(':');
    if (i > 0) $('ed-vols').appendChild(edKvRow('vols', b.slice(0, i), b.slice(i + 1)));
  });
  if (!binds.length) $('ed-vols').appendChild(kvRow('vols'));

  // Env
  const envs = (ins.Config && ins.Config.Env) || [];
  envs.forEach(e => $('ed-envs').appendChild(edKvRow('envs', e)));
  if (!envs.length) $('ed-envs').appendChild(kvRow('envs'));

  // Limits — shown in the units people think in (MB, cores), blank = unlimited
  const hc = ins.HostConfig || {};
  $('ed-memory').value = hc.Memory ? Math.round(hc.Memory / 1024 / 1024) : '';
  $('ed-cpus').value = hc.NanoCpus ? +(hc.NanoCpus / 1e9).toFixed(2) : '';

  $('ed-restart').value = (ins.HostConfig && ins.HostConfig.RestartPolicy && ins.HostConfig.RestartPolicy.Name) || 'no';
  const netSel = $('ed-network');
  const curNet = (ins.HostConfig && ins.HostConfig.NetworkMode) || 'bridge';
  const netNames = new Set(['bridge', 'host', ...state.networks.map(n => n.Name)]);
  netNames.add(curNet);
  netSel.innerHTML = [...netNames].filter(n => n !== 'none').map(n =>
    `<option value="${escHtml(n)}"${n === curNet ? ' selected' : ''}>${escHtml(n)}</option>`).join('');

  $('edit-status').textContent = '';
}

function closeEditContainer() { $('edit-modal').classList.remove('open'); editId = null; }
$('edit-close-btn').addEventListener('click', closeEditContainer);
$('edit-cancel-btn').addEventListener('click', closeEditContainer);
document.querySelectorAll('[data-edadd]').forEach(a =>
  a.addEventListener('click', () => $('ed-' + a.dataset.edadd).appendChild(kvRow(a.dataset.edadd))));

$('edit-save-btn').addEventListener('click', async () => {
  if (!editId) return;
  const image = $('ed-image').value.trim();
  if (!image) { toast('Image can\'t be empty', 'error'); return; }
  const rows = (id) => [...document.querySelectorAll(`#${id} .kv-row`)];
  const spec = {
    image,
    name: $('ed-name').value.trim(),
    ports: rows('ed-ports').map(r => ({ host: r.querySelector('[data-k]').value.trim(), cont: r.querySelector('[data-v]')?.value.trim() })).filter(p => p.cont),
    volumes: rows('ed-vols').map(r => ({ host: r.querySelector('[data-k]').value.trim(), cont: r.querySelector('[data-v]')?.value.trim() })).filter(v => v.host && v.cont),
    env: rows('ed-envs').map(r => r.querySelector('[data-k]').value.trim()).filter(Boolean),
    restart: $('ed-restart').value,
    network: $('ed-network').value,
    // '' → 0 → explicitly unlimited (the field was cleared on purpose)
    memory: numOrZero($('ed-memory').value),
    cpus: numOrZero($('ed-cpus').value)
  };
  const c = state.containers.find(x => x.Id === editId);
  const name = c ? sanitizeName(c.Names && c.Names[0]) : editId.slice(0, 12);
  if (!confirm(`Recreate "${name}" with the new settings?\n\nThe container is stopped, recreated and restarted. If anything fails, the original is restored.`)) return;
  const btn = $('edit-save-btn');
  btn.disabled = true; btn.textContent = 'Recreating…';
  $('edit-status').textContent = image !== (c && c.Image) ? 'Pulling image & recreating…' : 'Recreating…';
  const r = await api.docker.recreate({ ...state.config, id: editId, spec });
  btn.disabled = false; btn.textContent = 'Recreate container';
  $('edit-status').textContent = '';
  if (r.ok) {
    toast(`${spec.name || name} recreated ✓`, 'success', 5000);
    closeEditContainer(); closeDetail();
    await loadDashboard();
    renderContainersList();
  } else {
    toast('Edit failed: ' + r.error + ' — original container restored', 'error', 9000);
  }
});

document.querySelectorAll('.kv-add').forEach(a => {
  if (a.dataset.edadd) return; // edit-modal rows handled above
  a.addEventListener('click', () => $('dep-' + a.dataset.add).appendChild(kvRow(a.dataset.add)));
});
$('deploy-btn').addEventListener('click', openDeploy);
$('deploy-close-btn').addEventListener('click', closeDeploy);
$('deploy-cancel-btn').addEventListener('click', closeDeploy);

// ─── Import from YAML (docker-compose) ───────────────────────────────────────
let composeSpecs = null;
function openComposeImport() {
  composeSpecs = null;
  $('compose-yaml').value = '';
  $('compose-preview').innerHTML = '';
  $('compose-status').textContent = '';
  $('compose-create-btn').style.display = 'none';
  $('compose-modal').classList.add('open');
}
function closeComposeImport() { $('compose-modal').classList.remove('open'); composeSpecs = null; }

function composePreview(services, warnings) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = services.map(s => {
    const bits = [];
    if (s.ports && s.ports.length) bits.push(s.ports.map(p => `${p.host}→${p.cont}/${p.proto}`).join(', '));
    if (s.volumes && s.volumes.length) bits.push(`${s.volumes.length} vol`);
    if (s.env && s.env.length) bits.push(`${s.env.length} env`);
    if (s.command) bits.push('command');
    if (s.restart) bits.push('restart: ' + s.restart);
    if (s.network) bits.push('net: ' + s.network);
    return `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
      <div style="font-weight:600">${esc(s.name)}</div>
      <div style="font-size:12px;color:var(--text-muted);font-family:monospace">${esc(s.image)}</div>
      ${bits.length ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${esc(bits.join('  ·  '))}</div>` : ''}
    </div>`;
  }).join('');
  const warn = (warnings && warnings.length)
    ? `<div style="margin-top:8px;font-size:11px;color:#d29922">${warnings.map(w => '⚠ ' + esc(w)).join('<br>')}</div>` : '';
  $('compose-preview').innerHTML =
    `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Will create ${services.length} container${services.length === 1 ? '' : 's'}:</div>${rows}${warn}`;
}

async function composeParse() {
  $('compose-status').textContent = 'Parsing…';
  const r = await api.compose.parse({ yaml: $('compose-yaml').value });
  $('compose-status').textContent = '';
  if (!r.ok) { $('compose-preview').innerHTML = ''; $('compose-create-btn').style.display = 'none'; composeSpecs = null; toast(r.error || 'Parse failed', 'error', 6000); return; }
  composeSpecs = r.services;
  composePreview(r.services, r.warnings);
  $('compose-create-btn').style.display = '';
}

async function composeCreate() {
  if (!composeSpecs || !composeSpecs.length) { toast('Preview a valid compose file first', 'error'); return; }
  const btn = $('compose-create-btn');
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const spec of composeSpecs) {
    $('compose-status').textContent = 'Creating ' + spec.name + '…';
    const r = await api.deploy.create({ ...state.config, spec });
    if (r && r.ok) ok++; else { fail++; toast(`${spec.name}: ${(r && r.error) || 'failed'}`, 'error', 7000); }
  }
  btn.disabled = false;
  $('compose-status').textContent = '';
  toast(`Created ${ok} container${ok === 1 ? '' : 's'}${fail ? ` · ${fail} failed` : ''}`, fail ? 'error' : 'success', 5000);
  if (ok) { closeComposeImport(); await loadDashboard(); showPage('containers'); renderContainersList(); }
}

$('compose-btn').addEventListener('click', openComposeImport);
$('compose-close-btn').addEventListener('click', closeComposeImport);
$('compose-cancel-btn').addEventListener('click', closeComposeImport);
$('compose-parse-btn').addEventListener('click', composeParse);
$('compose-create-btn').addEventListener('click', composeCreate);
$('compose-file-btn').addEventListener('click', () => $('compose-file-input').click());
$('compose-file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { $('compose-yaml').value = reader.result || ''; composeParse(); };
  reader.readAsText(f);
  e.target.value = '';
});

