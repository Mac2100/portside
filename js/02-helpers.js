// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const api = window.portside;

// Escape anything that gets interpolated into a template literal we then set as
// innerHTML. Container names, image tags and repo names all come from Docker.
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// Form number → number, where blank/garbage means 0 ("no limit"), never NaN
function numOrZero(v) { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; }

// ─── Destructive confirmation ────────────────────────────────────────────────
// Anything that destroys something asks twice: the first dialog says what will
// happen, the second is the point of no return. Two dialogs is annoying by
// design — muscle memory clicks through one, not two with different wording.
//
// Used for containers, which can be recreated. For data that CANNOT come back
// (volumes) use confirmDestroy() below, which makes you type the name.
function confirmDestructive(what, detail, finalLine) {
  if (!confirm(`${what}\n\n${detail}`)) return false;
  return confirm(`⚠️ Last chance — this cannot be undone.\n\n${finalLine}`);
}

// Type-to-confirm. Returns a promise → true only if the exact phrase was typed.
// Clicking OK twice is a reflex; typing "plexdata" is a decision.
function confirmDestroy({ title, warn, items = [], phrase, button = 'Delete permanently' }) {
  return new Promise(resolve => {
    $('destroy-title').textContent = title;
    $('destroy-warn').innerHTML = warn;
    $('destroy-list').innerHTML = items.length
      ? items.map(i => `<div class="destroy-item">${escHtml(i)}</div>`).join('')
      : '';
    $('destroy-list').style.display = items.length ? '' : 'none';
    $('destroy-phrase-label').textContent = phrase;
    $('destroy-go-btn').textContent = button;

    const input = $('destroy-phrase');
    const go = $('destroy-go-btn');
    input.value = '';
    input.placeholder = phrase;
    go.disabled = true;

    const check = () => { go.disabled = input.value.trim() !== phrase; };
    const done = (ok) => {
      input.removeEventListener('input', check);
      go.removeEventListener('click', onGo);
      $('destroy-cancel-btn').removeEventListener('click', onCancel);
      $('destroy-close-btn').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      $('destroy-modal').classList.remove('open');
      resolve(ok);
    };
    const onGo = () => { if (!go.disabled) done(true); };
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Enter' && !go.disabled) onGo();
      if (e.key === 'Escape') onCancel();
    };

    input.addEventListener('input', check);
    go.addEventListener('click', onGo);
    $('destroy-cancel-btn').addEventListener('click', onCancel);
    $('destroy-close-btn').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);

    $('destroy-modal').classList.add('open');
    setTimeout(() => input.focus(), 30);
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────
// Every desktop notification in the app goes through notify(). One switch per
// event type, configured in Settings → Notifications, so a container that
// restarts by design doesn't have to mean turning notifications off entirely.
const NOTIFY_EVENTS = [
  ['stopped',      'Container stopped',      'A container that was running is no longer running'],
  ['crashed',      'Container crashed',      'Exited with a non-zero code — it failed rather than being told to stop'],
  ['unhealthy',    'Container unhealthy',    'Its own HEALTHCHECK started failing'],
  ['restartLoop',  'Restart loop',           'Docker is repeatedly restarting a container that keeps dying'],
  ['imageUpdate',  'Image update available', 'A newer image was published for something you run (and auto-update results)'],
  ['ghRelease',    'GitHub release/commit',  'A repo you watch has new commits or a new release'],
  ['certExpiring', 'TLS certificate expiring', 'Your Docker certs are close to expiry — after that Portside just goes dark']
];

function notifyEnabled(event) {
  const rules = state.config.notifyRules || {};
  return rules[event] !== false;   // default on
}

function notify(event, body) {
  if (!notifyEnabled(event)) return;
  try { new Notification('Portside', { body }); } catch {}
}

function fmt(bytes) {
  if (!bytes) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
  return bytes.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}
function sanitizeName(name) {
  return (name || '').replace(/^\//, '');
}
function statusClass(s) {
  if (!s) return 'created';
  if (s.startsWith('Up')) return 'running';
  if (s.startsWith('Exited')) return 'exited';
  if (s.startsWith('Paused')) return 'paused';
  if (s.startsWith('Restarting')) return 'restarting';
  return 'created';
}
function toast(msg, type = 'info', dur = 3000) {
  const icons = { success:'✓', error:'✕', info:'ℹ' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), dur);
}

