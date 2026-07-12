// ─── Terminal (container console via docker exec) ────────────────────────────
let term = null, fitAddon = null, termSessionId = null;

function initTerm() {
  if (term) return;
  const XTerm = window.Terminal.Terminal || window.Terminal;
  const Fit = window.FitAddon.FitAddon || window.FitAddon;
  term = new XTerm({
    fontSize: 12.5,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#0d1117', foreground: '#e6edf3',
      cursor: '#58a6ff', selectionBackground: 'rgba(88,166,255,0.3)',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
      blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
      brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd', brightWhite: '#f0f6fc'
    }
  });
  fitAddon = new Fit();
  term.loadAddon(fitAddon);
  term.open($('terminal-wrap'));
  fitAddon.fit();

  term.onData(d => { if (termSessionId) api.term.write({ sessionId: termSessionId, data: d }); });
  term.onResize(({ cols, rows }) => { if (termSessionId) api.term.resize({ sessionId: termSessionId, cols, rows }); });
  window.addEventListener('resize', () => { if (term && $('page-terminal').classList.contains('active')) fitAddon.fit(); });

  api.term.onData(({ sessionId, data }) => {
    if (sessionId === termSessionId && term) term.write(new Uint8Array(data));
  });
  api.term.onExit(({ sessionId }) => {
    if (sessionId === termSessionId && term) {
      term.writeln('\r\n\x1b[31m[session closed]\x1b[0m');
      termSessionId = null;
      setTermStatus(false);
    }
  });
}

function setTermStatus(connected, label) {
  $('term-dot').className = 'status-dot' + (connected ? ' connected' : '');
  $('term-status-label').textContent = label || (connected ? 'Connected' : 'Not connected');
  $('term-connect-btn').style.display = connected ? 'none' : '';
  $('term-disconnect-btn').style.display = connected ? '' : 'none';
}

function setupTerminalPage() {
  const sel = $('term-container-select');
  const current = sel.value;
  const running = state.containers.filter(c => (c.State || '').toLowerCase() === 'running');
  sel.innerHTML = running.length
    ? running.map(c => `<option value="${c.Id}">${sanitizeName(c.Names && c.Names[0])}</option>`).join('')
    : '<option value="">No running containers</option>';
  if (current && running.some(c => c.Id === current)) sel.value = current;
  initTerm();
  setTimeout(() => { if (fitAddon) fitAddon.fit(); if (term) term.focus(); }, 50);
}

async function connectTerm() {
  const id = $('term-container-select').value;
  if (!id) { toast('No running container selected', 'error'); return; }
  await disconnectTerm(true);
  initTerm();
  term.clear();
  setTermStatus(false, 'Connecting…');
  fitAddon.fit();
  const r = await api.term.start({ ...state.config, id, cols: term.cols, rows: term.rows });
  if (!r.ok) {
    setTermStatus(false);
    toast('Console failed: ' + r.error, 'error');
    term.writeln('\x1b[31mFailed to open console: ' + r.error + '\x1b[0m');
    return;
  }
  termSessionId = r.sessionId;
  const name = $('term-container-select').selectedOptions[0]?.textContent || '';
  setTermStatus(true, name);
  term.focus();
}

async function disconnectTerm(silent) {
  if (termSessionId) {
    await api.term.kill({ sessionId: termSessionId });
    termSessionId = null;
  }
  if (!silent) setTermStatus(false);
}

function openTerminalFor(id) {
  showPage('terminal');
  setupTerminalPage();
  const sel = $('term-container-select');
  if ([...sel.options].some(o => o.value === id)) sel.value = id;
  connectTerm();
}

$('term-connect-btn').addEventListener('click', connectTerm);
$('term-disconnect-btn').addEventListener('click', () => disconnectTerm());
$('term-container-select').addEventListener('change', () => { if (termSessionId) connectTerm(); });

