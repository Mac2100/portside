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

  const warn = users.length
    ? `Volume "${name}" is mounted by ${users.map(cName).join(', ')}.\n\n⚠️ Deleting it DESTROYS THE DATA INSIDE IT — configs, databases, everything those containers keep there.\n\nDelete it anyway?`
    : `Delete volume "${name}"?\n\n⚠️ This permanently destroys the data inside it. Nothing is currently using it, but the data is not recoverable.`;
  if (!confirm(warn)) return;

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

