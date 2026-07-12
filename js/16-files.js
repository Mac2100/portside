// ─── Files (container file browser) ───────────────────────────────────────────
let filesPath = '/';

function filesContainerId() { return $('files-container-select').value; }

function setupFilesPage() {
  const sel = $('files-container-select');
  const current = sel.value;
  const running = state.containers.filter(c => (c.State || '').toLowerCase() === 'running');
  sel.innerHTML = running.length
    ? running.map(c => `<option value="${c.Id}">${sanitizeName(c.Names && c.Names[0])}</option>`).join('')
    : '<option value="">No running containers</option>';
  const kept = current && running.some(c => c.Id === current);
  if (kept) sel.value = current;
  if (sel.value) refreshMounts(!kept || !filesMounts.length);
}

// Mapped volumes → quick-jump chips (default view)
let filesMounts = [];

async function refreshMounts(navigate) {
  const id = filesContainerId();
  if (!id) return;
  filesMounts = [];
  const r = await api.docker.inspect({ ...state.config, id });
  if (r.ok && r.data && r.data.Mounts) {
    filesMounts = r.data.Mounts
      .filter(m => m.Destination)
      .map(m => ({ dest: m.Destination, src: m.Source || m.Name || '' }))
      .sort((a, b) => a.dest.localeCompare(b.dest));
  }
  renderMountChips();
  if (navigate) loadFiles(filesMounts.length ? filesMounts[0].dest + '/' : '/');
  else renderMountChips();
}

function renderMountChips() {
  const el = $('files-mounts');
  if (!filesMounts.length) { el.innerHTML = ''; return; }
  el.innerHTML = filesMounts.map(m =>
    `<span class="mount-chip" data-dest="${m.dest}/" title="mapped from ${m.src}">⛁ ${m.dest}</span>`).join('') +
    `<span class="mount-chip" data-dest="/" title="Browse the container's entire filesystem">/ full fs</span>`;
  el.querySelectorAll('.mount-chip').forEach(c =>
    c.addEventListener('click', () => loadFiles(c.dataset.dest)));
  highlightMountChip();
}

function highlightMountChip() {
  let best = null;
  document.querySelectorAll('#files-mounts .mount-chip').forEach(c => {
    c.classList.remove('active');
    const d = c.dataset.dest;
    if (filesPath.startsWith(d) && (!best || d.length > best.dataset.dest.length)) best = c;
  });
  if (best) best.classList.add('active');
}

function renderCrumbs() {
  const segs = filesPath.split('/').filter(Boolean);
  let html = `<span class="crumb" data-path="/">/</span>`;
  let acc = '';
  for (const s of segs) {
    acc += '/' + s;
    html += `<span class="crumb-sep">›</span><span class="crumb" data-path="${acc}/">${s}</span>`;
  }
  $('files-crumbs').innerHTML = html;
  document.querySelectorAll('#files-crumbs .crumb').forEach(c =>
    c.addEventListener('click', () => loadFiles(c.dataset.path)));
}

async function loadFiles(p) {
  const id = filesContainerId();
  if (!id) return;
  filesPath = p.endsWith('/') ? p : p + '/';
  renderCrumbs();
  highlightMountChip();
  $('files-list').innerHTML = '<div class="empty-state"><div class="spinner"></div></div>';
  const r = await api.files.list({ ...state.config, id, dirPath: filesPath });
  if (!r.ok) {
    $('files-list').innerHTML = `<div class="empty-state"><div class="empty-icon">⚠</div><div class="empty-title">Can't open folder</div><div class="empty-sub">${r.error}</div></div>`;
    return;
  }
  const entries = r.entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
  const up = filesPath !== '/' ? `<tr class="file-row"><td colspan="4"><div class="file-name dir" data-nav="${filesPath.replace(/[^/]+\/$/, '')}"><span class="file-icon">↩</span>..</div></td></tr>` : '';
  const rows = entries.map(en => {
    const icon = en.type === 'dir' ? '📁' : en.type === 'link' ? '🔗' : '📄';
    const nameHtml = en.type === 'dir'
      ? `<div class="file-name dir" data-nav="${filesPath + en.name}/"><span class="file-icon">${icon}</span>${en.name}</div>`
      : `<div class="file-name"><span class="file-icon">${icon}</span>${en.name}${en.link ? `<span class="text-muted" style="font-size:10px"> → ${en.link}</span>` : ''}</div>`;
    const acts = en.type === 'file'
      ? `<div class="file-acts">
           ${en.size <= 1024 * 1024 ? `<button class="btn btn-icon" data-edit="${en.name}" title="View / Edit">✏️</button>` : ''}
           <button class="btn btn-icon" data-dl="${en.name}" title="Download">⤓</button>
         </div>`
      : '';
    return `<tr class="file-row">
      <td>${nameHtml}</td>
      <td class="text-muted font-mono" style="font-size:11px">${en.type === 'file' ? fmt(en.size) : '—'}</td>
      <td class="text-muted font-mono" style="font-size:11px">${en.date}</td>
      <td style="width:90px">${acts}</td>
    </tr>`;
  }).join('');
  $('files-list').innerHTML = `<table class="container-table">
    <thead><tr><th>Name</th><th style="width:90px">Size</th><th style="width:130px">Modified</th><th></th></tr></thead>
    <tbody>${up}${rows || ''}</tbody></table>`;

  document.querySelectorAll('#files-list [data-nav]').forEach(el =>
    el.addEventListener('click', () => loadFiles(el.dataset.nav)));
  document.querySelectorAll('#files-list [data-dl]').forEach(b =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r2 = await api.files.download({ ...state.config, id: filesContainerId(), filePath: filesPath + b.dataset.dl });
      b.disabled = false;
      if (r2.ok) toast(`Saved to ${r2.savedTo}`, 'success');
      else if (!r2.canceled) toast(r2.error, 'error');
    }));
  document.querySelectorAll('#files-list [data-edit]').forEach(b =>
    b.addEventListener('click', () => openEditor(b.dataset.edit)));
}

// File editor modal
let editorFile = null;
async function openEditor(name) {
  const id = filesContainerId();
  const r = await api.files.read({ ...state.config, id, filePath: filesPath + name });
  if (!r.ok) { toast(r.error, 'error'); return; }
  editorFile = name;
  $('editor-title').textContent = filesPath + name;
  $('editor-textarea').value = r.content;
  $('editor-modal').classList.add('open');
  $('editor-textarea').focus();
}
function closeEditor() { $('editor-modal').classList.remove('open'); editorFile = null; }
$('editor-close-btn').addEventListener('click', closeEditor);
$('editor-cancel-btn').addEventListener('click', closeEditor);
$('editor-save-btn').addEventListener('click', async () => {
  if (!editorFile) return;
  const btn = $('editor-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const r = await api.files.write({ ...state.config, id: filesContainerId(), destDir: filesPath, name: editorFile, content: $('editor-textarea').value });
  btn.disabled = false; btn.textContent = 'Save to container';
  if (r.ok) { toast(`${editorFile} saved — restart the container to apply config changes`, 'success', 5000); closeEditor(); }
  else toast(r.error, 'error');
});

$('files-container-select').addEventListener('change', () => refreshMounts(true));
$('files-refresh-btn').addEventListener('click', () => loadFiles(filesPath));
$('files-upload-btn').addEventListener('click', async () => {
  const id = filesContainerId();
  if (!id) return;
  const r = await api.files.upload({ ...state.config, id, destDir: filesPath });
  if (r.ok) { toast(`Uploaded ${r.name} to ${filesPath}`, 'success'); loadFiles(filesPath); }
  else if (!r.canceled) toast(r.error, 'error');
});

