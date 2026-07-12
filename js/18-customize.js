// ─── Customize container card (nickname / tint / icon — saved locally) ────────
const CUST_ICONS = ['📦','🌐','🗄','🗃','⚙️','🚀','✂️','🏷','🪧','🌱','🔒','📈','🧭','🎬','📮','🛠','🐘','🧱','📊','🔔'];
let gcuName = null, gcuTint = null, gcuIcon = null;
function updateCustPreview() {
  const p = $('cust-preview');
  const t = gcuTint || gcTint(gcuName);
  p.style.background = t; p.style.boxShadow = '0 3px 10px -2px ' + t;
  p.textContent = gcuIcon || gcMono(gcuName);
  $('cust-preview-name').textContent = $('cust-nick').value.trim() || gcuName;
}
function openCustomize(name) {
  gcuName = name;
  const cust = (state.config.gcCustom || {})[name] || {};
  gcuTint = cust.tint || null; gcuIcon = cust.icon || null;
  $('cust-title').textContent = 'Customize — ' + name;
  $('cust-nick').value = cust.nickname || '';
  $('cust-group').value = (state.config.gcGroups || {})[name] || '';
  $('group-datalist').innerHTML = [...new Set(Object.values(state.config.gcGroups || {}))]
    .sort().map(g => `<option value="${escHtml(g)}">`).join('');
  $('cust-tints').innerHTML = `<div class="sw auto${gcuTint ? '' : ' sel'}" data-tint="">Auto</div>` +
    GC_TINTS.map(t => `<div class="sw${gcuTint === t ? ' sel' : ''}" data-tint="${t}" style="background:${t}"></div>`).join('');
  $('cust-icons').innerHTML = `<div class="ic-opt${gcuIcon ? '' : ' sel'}" data-icon="">${gcMono(name)}</div>` +
    CUST_ICONS.map(ic => `<div class="ic-opt${gcuIcon === ic ? ' sel' : ''}" data-icon="${ic}">${ic}</div>`).join('');
  $('cust-tints').querySelectorAll('.sw').forEach(s => s.addEventListener('click', () => {
    gcuTint = s.dataset.tint || null;
    $('cust-tints').querySelectorAll('.sw').forEach(x => x.classList.remove('sel')); s.classList.add('sel'); updateCustPreview();
  }));
  $('cust-icons').querySelectorAll('.ic-opt').forEach(s => s.addEventListener('click', () => {
    gcuIcon = s.dataset.icon || null;
    $('cust-icons').querySelectorAll('.ic-opt').forEach(x => x.classList.remove('sel')); s.classList.add('sel'); updateCustPreview();
  }));
  updateCustPreview();
  $('cust-modal').classList.add('open');
  setTimeout(() => $('cust-nick').focus(), 30);
}
function closeCustomize() { $('cust-modal').classList.remove('open'); gcuName = null; }
$('cust-nick').addEventListener('input', updateCustPreview);
$('cust-close-btn').addEventListener('click', closeCustomize);
$('cust-cancel-btn').addEventListener('click', closeCustomize);
$('cust-modal').addEventListener('click', (e) => { if (e.target === $('cust-modal')) closeCustomize(); });
$('cust-save-btn').addEventListener('click', () => {
  const obj = {}; const nick = $('cust-nick').value.trim();
  if (nick) obj.nickname = nick;
  if (gcuTint) obj.tint = gcuTint;
  if (gcuIcon) obj.icon = gcuIcon;
  const all = { ...(state.config.gcCustom || {}) };
  if (Object.keys(obj).length) all[gcuName] = obj; else delete all[gcuName];
  const groups = { ...(state.config.gcGroups || {}) };
  const grp = $('cust-group').value.trim();
  if (grp) groups[gcuName] = grp; else delete groups[gcuName];
  saveCfg({ gcCustom: all, gcGroups: groups });
  closeCustomize(); renderContainersList(); toast('Customization saved', 'success');
});
$('cust-reset-btn').addEventListener('click', () => {
  const all = { ...(state.config.gcCustom || {}) }; delete all[gcuName];
  const groups = { ...(state.config.gcGroups || {}) }; delete groups[gcuName];
  saveCfg({ gcCustom: all, gcGroups: groups });
  closeCustomize(); renderContainersList(); toast('Reset to default', 'info');
});

