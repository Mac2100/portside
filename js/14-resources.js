// ─── Usage helpers (which containers reference an image / volume) ─────────────
async function ensureContainers() {
  if (!state.containers.length) {
    const r = await api.docker.containers(state.config);
    if (r.ok) state.containers = r.data || [];
  }
  return state.containers;
}

const cName = c => ((c.Names && c.Names[0]) || c.Id.slice(0, 12)).replace(/^\//, '');

// Containers (running or stopped) using a given image
function containersForImage(img) {
  const tags = (img.RepoTags || []).filter(t => t !== '<none>:<none>');
  return state.containers.filter(c =>
    c.ImageID === img.Id || tags.includes(c.Image) || c.Image === img.Id
  );
}

// Containers with a given named volume mounted
function containersForVolume(v) {
  return state.containers.filter(c =>
    (c.Mounts || []).some(m => m.Type === 'volume' && m.Name === v.Name)
  );
}

// Containers attached to a given network
function containersForNetwork(n) {
  return state.containers.filter(c =>
    Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}).includes(n.Name)
  );
}

function usedByHtml(list) {
  if (!list.length) return '';
  const names = list.map(c => `<b>${cName(c)}</b>`);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3} more` : '';
  return `<div class="used-by">Used by ${shown}${more}</div>`;
}

// Trash button shown on every removable card
const delBtn = (kind, id, label) =>
  `<button class="card-del" data-del="${kind}" data-id="${escHtml(id)}" title="Delete ${escHtml(label)}">🗑</button>`;

// ─── Deleting one image / volume / network ───────────────────────────────────
// Docker answers 409 when the thing is still referenced. For images that's
// recoverable with force (it just untags); for volumes force means "delete the
// data anyway", so we ask again in plain language rather than forcing quietly.
async function removeImage(id) {
  const img = state.images.find(i => i.Id === id);
  const tags = ((img && img.RepoTags) || []).filter(t => t !== '<none>:<none>');
  const users = img ? containersForImage(img) : [];
  const what = tags[0] || id.replace('sha256:', '').slice(0, 12);

  if (users.length && !confirm(
    `${what} is still used by ${users.map(cName).join(', ')}.\n\n` +
    `Deleting it won't stop those containers, but they can't be recreated until the image is pulled again. Delete anyway?`)) return;
  if (!users.length && !confirm(`Delete image ${what}?\n\nIt will be pulled again from the registry if you redeploy something that needs it.`)) return;

  toast(`Deleting ${what}…`, 'info');
  let r = await api.docker.removeImage({ ...state.config, id, force: users.length > 0 });
  if (!r.ok && r.status === 409) {
    if (!confirm(`Docker refused: ${r.error}\n\nForce delete? (this only removes the tag/layers — running containers keep running)`)) return;
    r = await api.docker.removeImage({ ...state.config, id, force: true });
  }
  if (!r.ok) return toast(r.error || 'Delete failed', 'error', 7000);
  toast(`Deleted ${what} ✓`, 'success');
  state.images = []; state.dfFetched = 0;
  await loadImages();
  loadDashboard();
}

async function removeVolume(name) {
  const v = state.volumes.find(x => x.Name === name);
  const users = v ? containersForVolume(v) : [];

  // A deleted volume takes its data with it. No undo, no bin, no re-pull.
  const ok = await confirmDestroy({
    title: `Delete volume "${name}"`,
    warn: `<b>This destroys the data inside the volume</b> — configs, databases, anything a container keeps there. It cannot be recovered.` +
      (users.length
        ? `<br><br>It is currently mounted by ${users.map(c => `<b>${escHtml(cName(c))}</b>`).join(', ')}, which will lose it.`
        : `<br><br>Nothing is using it right now.`),
    items: users.map(cName),
    phrase: name,
    button: 'Destroy volume'
  });
  if (!ok) return;

  toast(`Deleting ${name}…`, 'info');
  let r = await api.docker.removeVolume({ ...state.config, name, force: users.length > 0 });
  if (!r.ok && r.status === 409) {
    if (!confirm(`Docker refused: ${r.error}\n\nForce delete?`)) return;
    r = await api.docker.removeVolume({ ...state.config, name, force: true });
  }
  if (!r.ok) return toast(r.error || 'Delete failed', 'error', 7000);
  toast(`Deleted volume ${name} ✓`, 'success');
  state.volumes = []; state.dfFetched = 0;
  await loadVolumes();
  loadDashboard();
}

async function removeNetwork(id) {
  const n = state.networks.find(x => x.Id === id);
  const nm = n ? n.Name : id.slice(0, 12);
  const users = n ? containersForNetwork(n) : [];
  if (users.length)
    return toast(`${nm} still has ${users.map(cName).join(', ')} attached — disconnect or remove them first`, 'error', 7000);
  if (!confirm(`Delete network "${nm}"?\n\nContainers you later create can't join it until it's recreated.`)) return;

  toast(`Deleting ${nm}…`, 'info');
  const r = await api.docker.removeNetwork({ ...state.config, id });
  if (!r.ok) return toast(r.error || 'Delete failed', 'error', 7000);
  toast(`Deleted network ${nm} ✓`, 'success');
  state.networks = [];
  await loadNetworks();
}

// One delegated listener per resource page — survives re-render
function wireDeletes(el) {
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const { del, id } = b.dataset;
    if (del === 'image') removeImage(id);
    else if (del === 'volume') removeVolume(id);
    else if (del === 'network') removeNetwork(id);
  }));
}

// ─── Images ───────────────────────────────────────────────────────────────────
state.imageFilter = 'all';

async function loadImages() {
  if (!state.images.length) {
    const r = await api.docker.images(state.config);
    if (r.ok) state.images = r.data || [];
  }
  await ensureContainers();

  const el = $('images-list');
  if (!state.images.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">◱</div><div class="empty-title">No images</div></div>`;
    return;
  }

  const rows = state.images.map(img => {
    const tags = (img.RepoTags || []).filter(t => t !== '<none>:<none>');
    const users = containersForImage(img);
    const dangling = !tags.length;
    const status = users.length ? 'inuse' : (dangling ? 'dangling' : 'unused');
    return { img, tags, users, status };
  });

  const counts = {
    all: rows.length,
    inuse: rows.filter(r => r.status === 'inuse').length,
    unused: rows.filter(r => r.status === 'unused').length,
    dangling: rows.filter(r => r.status === 'dangling').length
  };
  const f = state.imageFilter;
  const visible = f === 'all' ? rows : rows.filter(r => r.status === f);

  const chips = [
    ['all', `All ${counts.all}`],
    ['inuse', `In use ${counts.inuse}`],
    ['unused', `Unused ${counts.unused}`],
    ['dangling', `Dangling ${counts.dangling}`]
  ].map(([k, label]) =>
    `<div class="filter-chip ${f === k ? 'active' : ''}" data-img-filter="${k}">${label}</div>`
  ).join('');

  const label = { inuse: 'In use', unused: 'Unused', dangling: 'Dangling' };

  const grid = visible.length
    ? `<div class="resource-grid">${visible.map(({ img, tags, users, status }) => {
        const name = tags[0]
          ? tags[0].slice(0, tags[0].lastIndexOf(':') > tags[0].lastIndexOf('/') ? tags[0].lastIndexOf(':') : undefined).split('/').pop()
          : `&lt;none&gt; ${img.Id.slice(7, 19)}`;
        // tag = text after the last ':' — but only if it comes after the last '/' (registry ports have colons too)
        const ref = tags[0] || '';
        const ci = ref.lastIndexOf(':');
        const tag = ref && ci > ref.lastIndexOf('/') ? ref.slice(ci + 1) : (ref ? 'latest' : 'none');
        return `<div class="resource-card ${status === 'dangling' ? 'is-dangling' : ''}" title="${tags[0] || img.Id}">
          <div class="resource-card-head">
            <div class="resource-card-name">${name}</div>
            <span class="use-badge ${status}">${label[status]}${status === 'inuse' && users.length > 1 ? ` ×${users.length}` : ''}</span>
            ${delBtn('image', img.Id, tags[0] || 'image')}
          </div>
          <div class="resource-card-meta">Tag: <span style="color:var(--cyan)">${tag}</span></div>
          <div class="resource-card-meta">Size: ${fmt(img.Size)}</div>
          <div class="resource-card-meta">Created: ${fmtTime(img.Created)}</div>
          <div class="resource-card-meta" style="font-size:10px">ID: ${img.Id.replace('sha256:', '').slice(0, 12)}</div>
          ${tags.length > 1 ? `<div style="margin-top:6px">${tags.slice(1).map(t => `<span class="resource-tag">${t}</span>`).join('')}</div>` : ''}
          ${status === 'inuse' ? usedByHtml(users)
            : status === 'dangling' ? `<div class="used-by">Untagged leftover layers — safe to prune.</div>`
            : `<div class="used-by">No container uses this image.</div>`}
        </div>`;
      }).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon">◱</div><div class="empty-title">Nothing here</div></div>`;

  el.innerHTML = `<div class="filter-chips">${chips}</div>${grid}`;

  el.querySelectorAll('[data-img-filter]').forEach(c =>
    c.addEventListener('click', () => { state.imageFilter = c.dataset.imgFilter; loadImages(); }));
  wireDeletes(el);
}

// ─── Image cleanup ────────────────────────────────────────────────────────────
// One sheet instead of two mystery buttons. Docker's "remove unused" already
// includes dangling images — they're a subset — so presenting them as two
// sequential actions was a lie. Here they're two checkboxes with real sizes,
// and we send a single prune call: the widest one that's ticked.
function cleanupGroups() {
  const dangling = [], unused = [];
  for (const img of state.images) {
    const tags = (img.RepoTags || []).filter(t => t !== '<none>:<none>');
    if (containersForImage(img).length) continue;      // in use — never offered
    (tags.length ? unused : dangling).push(img);
  }
  const size = list => list.reduce((a, i) => a + (i.Size || 0), 0);
  return { dangling, unused, danglingSize: size(dangling), unusedSize: size(unused) };
}

function openCleanup() {
  const g = cleanupGroups();
  const opt = (key, checked, disabled, icon, title, size, count, sub) => `
    <label class="cleanup-opt${disabled ? ' disabled' : ''}">
      <input type="checkbox" data-cl="${key}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="cleanup-body">
        <span class="cleanup-title">${icon} ${title}
          <span class="cleanup-size">${count ? fmt(size) : 'nothing to remove'}</span>
        </span>
        <span class="cleanup-sub">${sub}</span>
      </span>
    </label>`;

  $('cleanup-options').innerHTML =
    opt('dangling', !!g.dangling.length, !g.dangling.length, '🧹',
        `${g.dangling.length} dangling image${g.dangling.length === 1 ? '' : 's'}`,
        g.danglingSize, g.dangling.length,
        'Untagged leftovers from image updates. Nothing can ever use them again — free to delete.') +
    opt('unused', false, !g.unused.length, '🗑',
        `${g.unused.length} unused image${g.unused.length === 1 ? '' : 's'}`,
        g.unusedSize, g.unused.length,
        'Tagged images no container runs. Deleting is safe, but they get pulled from the registry again next time you need them.');

  $('cleanup-status').textContent = '';
  $('cleanup-modal').classList.add('open');
  $('cleanup-options').querySelectorAll('[data-cl]').forEach(cb =>
    cb.addEventListener('change', updateCleanupTotal));
  updateCleanupTotal();
}

function cleanupPicked() {
  const picked = {};
  $('cleanup-options').querySelectorAll('[data-cl]').forEach(cb => { picked[cb.dataset.cl] = cb.checked; });
  return picked;
}

function updateCleanupTotal() {
  const g = cleanupGroups();
  const p = cleanupPicked();
  // "unused" is the superset — ticking it removes the dangling ones too
  const bytes = (p.unused ? g.unusedSize + g.danglingSize : 0) + (p.unused ? 0 : (p.dangling ? g.danglingSize : 0));
  const count = (p.unused ? g.unused.length + g.dangling.length : (p.dangling ? g.dangling.length : 0));
  $('cleanup-total').innerHTML = count
    ? `Reclaims up to <b>${fmt(bytes)}</b> across ${count} image${count === 1 ? '' : 's'}
       <span class="cleanup-note">— shared layers mean the real figure can be lower</span>`
    : `<span class="cleanup-note">Nothing selected</span>`;
  $('cleanup-go-btn').disabled = !count;
}

function closeCleanup() { $('cleanup-modal').classList.remove('open'); }

$('images-cleanup-btn').addEventListener('click', openCleanup);
$('cleanup-close-btn').addEventListener('click', closeCleanup);
$('cleanup-cancel-btn').addEventListener('click', closeCleanup);
$('cleanup-modal').addEventListener('click', (e) => { if (e.target === $('cleanup-modal')) closeCleanup(); });

$('cleanup-go-btn').addEventListener('click', async () => {
  const p = cleanupPicked();
  if (!p.dangling && !p.unused) return;

  // The sheet is the first decision; this is the point of no return.
  const g = cleanupGroups();
  const count = p.unused ? g.unused.length + g.dangling.length : g.dangling.length;
  const what = p.unused
    ? `${count} image${count === 1 ? '' : 's'} — including ${g.unused.length} tagged one${g.unused.length === 1 ? '' : 's'} (${g.unused.map(i => (i.RepoTags || [])[0]).filter(Boolean).slice(0, 6).join(', ')}${g.unused.length > 6 ? '…' : ''}) that must be pulled again if you want them back`
    : `${count} dangling layer${count === 1 ? '' : 's'} — nothing can reference them`;
  if (!confirm(`Remove ${what}?`)) return;

  const btn = $('cleanup-go-btn');
  btn.disabled = true; btn.textContent = 'Removing…';
  $('cleanup-status').textContent = 'Asking Docker to prune…';

  // One call. all=true prunes every unused image (dangling included);
  // without it, Docker prunes dangling only.
  const r = await api.docker.pruneImages({ ...state.config, all: !!p.unused });

  btn.disabled = false; btn.textContent = 'Remove';
  $('cleanup-status').textContent = '';
  if (!r.ok) return toast(`Cleanup failed: ${r.error}`, 'error', 7000);

  const n = ((r.data && r.data.ImagesDeleted) || []).length;
  toast(`Removed ${n} image${n === 1 ? '' : 's'} — reclaimed ${fmt((r.data && r.data.SpaceReclaimed) || 0)}`, 'success', 6000);
  closeCleanup();
  state.images = []; state.dfFetched = 0;
  await loadImages();
  loadDashboard();
});

// ─── Volumes ──────────────────────────────────────────────────────────────────
state.volumeFilter = 'all';

async function loadVolumes() {
  if (!state.volumes.length) {
    const r = await api.docker.volumes(state.config);
    if (r.ok) state.volumes = (r.data && r.data.Volumes) || [];
  }
  await ensureContainers();

  const el = $('volumes-list');
  if (!state.volumes.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">⬡</div><div class="empty-title">No volumes</div></div>`;
    return;
  }

  const rows = state.volumes.map(v => {
    const users = containersForVolume(v);
    return { v, users, status: users.length ? 'inuse' : 'unused' };
  });

  const counts = {
    all: rows.length,
    inuse: rows.filter(r => r.status === 'inuse').length,
    unused: rows.filter(r => r.status === 'unused').length
  };
  const f = state.volumeFilter;
  const visible = f === 'all' ? rows : rows.filter(r => r.status === f);

  const chips = [
    ['all', `All ${counts.all}`],
    ['inuse', `In use ${counts.inuse}`],
    ['unused', `Unused ${counts.unused}`]
  ].map(([k, label]) =>
    `<div class="filter-chip ${f === k ? 'active' : ''}" data-vol-filter="${k}">${label}</div>`
  ).join('');

  const grid = visible.length
    ? `<div class="resource-grid">${visible.map(({ v, users, status }) => `
        <div class="resource-card" title="${v.Name}">
          <div class="resource-card-head">
            <div class="resource-card-name">${v.Name}</div>
            <span class="use-badge ${status}">${status === 'inuse' ? `In use${users.length > 1 ? ` ×${users.length}` : ''}` : 'Unused'}</span>
            ${delBtn('volume', v.Name, v.Name)}
          </div>
          <div class="resource-card-meta">Driver: ${v.Driver}</div>
          <div class="resource-card-meta" style="word-break:break-all;font-size:10px;color:var(--text-muted)">${v.Mountpoint}</div>
          ${status === 'inuse' ? usedByHtml(users)
            : `<div class="used-by">Not attached to any container.</div>`}
        </div>`).join('')}</div>`
    : `<div class="empty-state"><div class="empty-icon">⬡</div><div class="empty-title">Nothing here</div></div>`;

  el.innerHTML = `<div class="filter-chips">${chips}</div>${grid}`;

  el.querySelectorAll('[data-vol-filter]').forEach(c =>
    c.addEventListener('click', () => { state.volumeFilter = c.dataset.volFilter; loadVolumes(); }));
  wireDeletes(el);
}

// Pruning volumes wipes every unused volume's contents at once — the single most
// destructive button in the app. Name the victims, then make them type it.
async function confirmVolumePrune() {
  await ensureContainers();
  if (!state.volumes.length) { const r = await api.docker.volumes(state.config); if (r.ok) state.volumes = (r.data && r.data.Volumes) || []; }
  const doomed = state.volumes.filter(v => !containersForVolume(v).length);
  if (!doomed.length) { toast('No unused volumes — nothing to prune', 'info'); return false; }

  return confirmDestroy({
    title: `Prune ${doomed.length} unused volume${doomed.length === 1 ? '' : 's'}`,
    warn: `<b>The data inside these volumes is destroyed</b> — databases, configs, anything a container left behind. There is no undo.<br><br>Bind mounts (host folders) are not affected.`,
    items: doomed.map(v => v.Name),
    phrase: 'delete volumes',
    button: `Destroy ${doomed.length} volume${doomed.length === 1 ? '' : 's'}`
  });
}

// ─── Networks ─────────────────────────────────────────────────────────────────
// bridge / host / none are built into Docker and can never be removed
const BUILTIN_NETS = ['bridge', 'host', 'none'];

async function loadNetworks() {
  if (!state.networks.length) {
    const r = await api.docker.networks(state.config);
    if (r.ok) state.networks = r.data || [];
  }
  await ensureContainers();

  const el = $('networks-list');
  if (!state.networks.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">⬡</div><div class="empty-title">No networks</div></div>`;
    return;
  }
  el.innerHTML = `<div class="resource-grid">${state.networks.map(n => {
    const subnet = Object.values(n.IPAM?.Config || {})[0]?.Subnet || '—';
    const users = containersForNetwork(n);
    const builtin = BUILTIN_NETS.includes(n.Name);
    const status = users.length ? 'inuse' : 'unused';
    return `<div class="resource-card" title="${n.Name}">
      <div class="resource-card-head">
        <div class="resource-card-name">${n.Name}</div>
        ${builtin ? `<span class="use-badge builtin">Built-in</span>`
          : `<span class="use-badge ${status}">${users.length ? `In use${users.length > 1 ? ` ×${users.length}` : ''}` : 'Unused'}</span>`}
        ${builtin ? '' : delBtn('network', n.Id, n.Name)}
      </div>
      <div class="resource-card-meta">Driver: ${n.Driver}</div>
      <div class="resource-card-meta">Subnet: ${subnet}</div>
      <div class="resource-card-meta">Scope: ${n.Scope}</div>
      ${n.Internal ? '<span class="resource-tag">internal</span>' : ''}
      ${n.Attachable ? '<span class="resource-tag">attachable</span>' : ''}
      ${users.length ? usedByHtml(users) : (builtin ? '' : `<div class="used-by">No container is attached.</div>`)}
    </div>`;
  }).join('')}</div>`;
  wireDeletes(el);
}

