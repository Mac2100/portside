// ─── Logs (live stream with ANSI colors, pause, search) ───────────────────────
let logTerm = null, logFit = null, logSearchAddon = null;
let logSessionId = null, logPaused = false, logBuffer = [];

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

