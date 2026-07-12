// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const pg = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('page-' + pg).classList.add('active');
    loadPage(pg);
  });
});

function loadPage(pg) {
  if (pg === 'dashboard') loadDashboard();
  if (pg === 'insights') renderInsights(state.lastPer || []);
  if (pg === 'containers') renderContainersList();
  if (pg === 'images') loadImages();
  if (pg === 'volumes') loadVolumes();
  if (pg === 'networks') loadNetworks();
  if (pg === 'terminal') setupTerminalPage();
  if (pg === 'files') setupFilesPage();
  if (pg === 'events') loadEvents();
  if (pg === 'settings') loadSettings();
}

