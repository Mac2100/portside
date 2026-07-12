// ─── Logs (live stream with ANSI colors, pause, search) ───────────────────────
let logTerm = null, logFit = null, logSearchAddon = null;
let logSessionId = null, logPaused = false, logBuffer = [];
let logContainerId = null;   // whose logs are on screen — used by the export button

function initLogTerm() {
  if (logTerm) return;
  const XTerm = window.Terminal.Terminal || window.Terminal;
  const Fit = window.FitAddon.FitAddon || window.FitAddon;
  const Search = window.SearchAddon.SearchAddon || window.SearchAddon;
  logTerm = new XTerm({
    convertEol: true, disableStdin: true,
    fontSize: 11.5, lineHeight: 1.25,
    fontFamily: "'SF Mono', Menlo, Monaco, monospace",
    scrollback: 10000, cursorStyle: 'bar',
    theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#0d1117',
      selectionBackground: 'rgba(88,166,255,0.3)' }
  });
  logFit = new Fit();
  logSearchAddon = new Search();
  logTerm.loadAddon(logFit);
  logTerm.loadAddon(logSearchAddon);
  logTerm.open($('log-output-term'));
  logFit.fit();

  api.logs.onData(({ sessionId, text }) => {
    if (sessionId !== logSessionId || !logTerm) return;
    if (logPaused) logBuffer.push(text);
    else logTerm.write(text);
  });
  api.logs.onEnd(({ sessionId }) => {
    if (sessionId === logSessionId && logTerm) {
      logTerm.write('\r\n\x1b[33m── log stream ended ──\x1b[0m\r\n');
      logSessionId = null;
      $('log-live-dot').classList.add('paused');
    }
  });
}

async function openLogs(id, name) {
  initLogTerm();
  logContainerId = id;
  $('log-title').textContent = name;
  $('log-panel').classList.add('open');
  await stopLogStream();
  logTerm.clear();
  logPaused = false;
  logBuffer = [];
  updateLogPauseUI();
  setTimeout(() => logFit.fit(), 120);
  const r = await api.logs.start({ ...state.config, id });
  if (r.ok) {
    logSessionId = r.sessionId;
    $('log-live-dot').classList.remove('paused');
  } else {
    logTerm.writeln('\x1b[31mError: ' + r.error + '\x1b[0m');
    $('log-live-dot').classList.add('paused');
  }
}

async function stopLogStream() {
  if (logSessionId) {
    await api.logs.stop({ sessionId: logSessionId });
    logSessionId = null;
  }
}

function updateLogPauseUI() {
  $('log-pause-btn').textContent = logPaused ? '▶' : '⏸';
  $('log-pause-btn').title = logPaused ? 'Resume stream' : 'Pause stream';
  $('log-live-dot').classList.toggle('paused', logPaused || !logSessionId);
}

$('log-pause-btn').addEventListener('click', () => {
  logPaused = !logPaused;
  if (!logPaused && logBuffer.length) {
    logTerm.write(logBuffer.join(''));
    logBuffer = [];
  }
  updateLogPauseUI();
});

$('log-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value;
  if (!q || !logSearchAddon) return;
  const opts = { caseSensitive: false, decorations: { matchOverviewRuler: '#d29922', activeMatchColorOverviewRuler: '#f85149' } };
  if (e.shiftKey) logSearchAddon.findPrevious(q, opts);
  else logSearchAddon.findNext(q, opts);
});

$('log-close-btn').addEventListener('click', () => {
  $('log-panel').classList.remove('open');
  stopLogStream();
});

// Export what's on screen. Docker keeps logs with the container — recreate it and
// they're gone — so being able to get them OUT matters.
$('log-save-btn').addEventListener('click', async () => {
  const name = ($('log-title').textContent || 'container').trim();
  const text = await api.docker.logs({ ...state.config, id: logContainerId });
  if (!text.ok) return toast(text.error || 'Could not read logs', 'error');
  const r = await api.exportSave({
    name: `${name}-${new Date().toISOString().slice(0, 10)}.log`,
    content: text.data || ''
  });
  if (r.canceled) return;
  if (!r.ok) return toast(r.error || 'Save failed', 'error');
  toast(`Saved to ${r.path}`, 'success', 6000);
});

// ─── Crash log snapshots ──────────────────────────────────────────────────────
// Captured the moment a crash is detected (see 09-dashboard.js), so the evidence
// survives the container being recreated.
state.crashLogs = [];

async function refreshCrashLogs() {
  state.crashLogs = await api.crashlog.list();
}

function crashLogFor(name) {
  return (state.crashLogs || []).find(c => c.name === name);
}

async function captureCrashLog(c, exitCode) {
  const name = sanitizeName(c.Names && c.Names[0]);
  try {
    const r = await api.docker.logs({ ...state.config, id: c.Id });
    await api.crashlog.save({
      name,
      containerId: c.Id,
      exitCode,
      status: c.Status || '',
      text: (r.ok && r.data) ? r.data : `(couldn't read logs: ${r.error || 'unknown error'})`
    });
    await refreshCrashLogs();
    renderInsights(state.lastPer || []);
  } catch {
    /* a failed capture must never break the refresh loop */
  }
}

let crashLogFile = null;

async function openCrashLog(file) {
  const meta = (state.crashLogs || []).find(c => c.file === file);
  const r = await api.crashlog.get({ file });
  if (!r.ok) return toast(r.error || 'Could not read the crash log', 'error');
  crashLogFile = file;
  $('crashlog-title').textContent = meta
    ? `${meta.name} — crashed ${new Date(meta.time).toLocaleString()}`
    : 'Crash log';
  $('crashlog-body').textContent = r.text;
  $('crashlog-modal').classList.add('open');
}

function closeCrashLog() { $('crashlog-modal').classList.remove('open'); crashLogFile = null; }

$('crashlog-close-btn').addEventListener('click', closeCrashLog);
$('crashlog-cancel-btn').addEventListener('click', closeCrashLog);
$('crashlog-modal').addEventListener('click', (e) => { if (e.target === $('crashlog-modal')) closeCrashLog(); });

$('crashlog-save-btn').addEventListener('click', async () => {
  const meta = (state.crashLogs || []).find(c => c.file === crashLogFile);
  const r = await api.exportSave({
    name: meta ? meta.file : 'crash.log',
    content: $('crashlog-body').textContent
  });
  if (r.canceled) return;
  if (!r.ok) return toast(r.error || 'Save failed', 'error');
  toast(`Saved to ${r.path}`, 'success', 6000);
});

$('crashlog-delete-btn').addEventListener('click', async () => {
  if (!crashLogFile) return;
  await api.crashlog.remove({ file: crashLogFile });
  await refreshCrashLogs();
  closeCrashLog();
  renderInsights(state.lastPer || []);
  toast('Crash log deleted', 'info');
});

