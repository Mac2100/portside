// ─── Activity feed ────────────────────────────────────────────────────────────
const EVENT_META = {
  start: ['▶', 'good'], unpause: ['▶', 'good'], create: ['＋', 'good'],
  die: ['💀', 'bad'], kill: ['■', 'bad'], stop: ['■', 'bad'], destroy: ['✕', 'bad'], oom: ['🚨', 'bad'],
  restart: ['↻', 'warn'], pause: ['⏸', 'warn'], rename: ['✎', ''],
  pull: ['⬇', 'good'], delete: ['🗑', 'warn'], untag: ['🏷', ''], tag: ['🏷', '']
};

function eventRowHtml(ev) {
  const base = (ev.action || '').split(':')[0].split(' ')[0];
  const [icon, cls] = EVENT_META[base] || (base.startsWith('health_status') ? ['🩺', /unhealthy/.test(ev.action) ? 'bad' : 'good'] : ['•', '']);
  const time = new Date(ev.t).toLocaleTimeString();
  return `<div class="event-row">
    <span class="event-time">${time}</span>
    <span class="event-icon">${icon}</span>
    <span class="event-action ${cls}">${base.replace('health_status', 'health')}</span>
    <span class="event-name">${ev.name}${ev.type !== 'container' ? ` <span class="event-extra">(${ev.type})</span>` : ''}</span>
    <span class="event-extra">${ev.extra || ''}</span>
  </div>`;
}

async function loadEvents() {
  const evs = await api.events.list({ host: state.config.host, port: state.config.port });
  $('events-list').innerHTML = evs.length
    ? evs.slice().reverse().map(eventRowHtml).join('')
    : '<div class="empty-state"><div class="empty-icon">☷</div><div class="empty-title">No events yet</div><div class="empty-sub">Container starts, stops, crashes and image pulls will appear here in real time.</div></div>';
}

api.events.onItem((ev) => {
  if (ev.host !== state.config.host) return;
  if (!$('page-events').classList.contains('active')) return;
  const list = $('events-list');
  if (list.querySelector('.empty-state')) { list.innerHTML = eventRowHtml(ev); return; }
  list.insertAdjacentHTML('afterbegin', eventRowHtml(ev));
  while (list.children.length > 300) list.lastElementChild.remove();
});

