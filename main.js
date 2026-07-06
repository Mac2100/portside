const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Tray, Menu, safeStorage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { randomUUID, X509Certificate } = require('crypto');

// ─── TLS Certs (user-imported in userData take priority over bundled) ────────
function userCertsDir() { return path.join(app.getPath('userData'), 'certs'); }
function activeCertsDir() {
  const u = userCertsDir();
  if (['ca.pem', 'cert.pem', 'key.pem'].every(f => fs.existsSync(path.join(u, f)))) return u;
  return path.join(__dirname, 'certs');
}

// Per-host certs: userData/certs/<hostId>/ wins, then userData/certs/, then bundled
function certsComplete(dir) {
  return ['ca.pem', 'cert.pem', 'key.pem'].every(f => fs.existsSync(path.join(dir, f)));
}
function hostCertsDir(hostId) { return path.join(app.getPath('userData'), 'certs', hostId); }
function certsDirForHost(hostIp) {
  try {
    const cfg = loadConfig();
    const h = (cfg.hosts || []).find(x => x.host === hostIp);
    if (h && certsComplete(hostCertsDir(h.id))) return hostCertsDir(h.id);
  } catch {}
  return activeCertsDir();
}

function createAgent(hostIp) {
  const certsDir = hostIp ? certsDirForHost(hostIp) : activeCertsDir();
  try {
    return new https.Agent({
      ca:   fs.readFileSync(path.join(certsDir, 'ca.pem')),
      cert: fs.readFileSync(path.join(certsDir, 'cert.pem')),
      key:  fs.readFileSync(path.join(certsDir, 'key.pem')),
      rejectUnauthorized: false  // QNAP self-signed CA
    });
  } catch (e) {
    console.error('Failed to load certs:', e.message);
    return null;
  }
}

// ─── Config Store (simple JSON file) ──────────────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { host: '', port: 2376 };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

// ─── Docker API helper ────────────────────────────────────────────────────────
function dockerRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(opts.host);
    if (!agent) return reject(new Error('TLS certs not loaded'));

    const options = {
      hostname: opts.host,
      port: opts.port || 2376,
      path: opts.path,
      method: opts.method || 'GET',
      agent,
      headers: { 'Content-Type': 'application/json' }
    };

    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(opts.timeout || 8000, () => { req.destroy(new Error('Request timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Terminal (docker exec with TLS stream hijack) ───────────────────────────
const termSessions = new Map();

ipcMain.handle('term:start', async (e, { host, port, id, cols, rows }) => {
  try {
    const execRes = await dockerRequest({ host, port, path: `/containers/${id}/exec`, method: 'POST' }, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
      Env: ['TERM=xterm-256color'],
      Cmd: ['/bin/sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi']
    });
    if (!execRes.body || !execRes.body.Id) {
      return { ok: false, error: 'Exec create failed (HTTP ' + execRes.status + ')' };
    }
    const execId = execRes.body.Id;
    const agent = createAgent(host);
    if (!agent) return { ok: false, error: 'TLS certs not loaded' };
    const sessionId = randomUUID();
    const sender = e.sender;

    await new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify({ Detach: false, Tty: true });
      const req = https.request({
        hostname: host, port: port || 2376,
        path: `/exec/${execId}/start`, method: 'POST', agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'Connection': 'Upgrade',
          'Upgrade': 'tcp'
        }
      });
      req.on('upgrade', (res, socket, head) => {
        termSessions.set(sessionId, { socket, execId, host, port });
        socket.setNoDelay(true);
        if (head && head.length) sender.send('term:data', { sessionId, data: head });
        socket.on('data', d => { if (!sender.isDestroyed()) sender.send('term:data', { sessionId, data: d }); });
        socket.on('close', () => {
          termSessions.delete(sessionId);
          if (!sender.isDestroyed()) sender.send('term:exit', { sessionId });
        });
        socket.on('error', () => {});
        resolve();
      });
      req.on('response', res => reject(new Error('Exec start failed (HTTP ' + res.statusCode + ')')));
      req.on('error', reject);
      req.end(bodyStr);
    });

    if (cols && rows) {
      dockerRequest({ host, port, path: `/exec/${execId}/resize?h=${rows}&w=${cols}`, method: 'POST' }).catch(() => {});
    }
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('term:write', (_, { sessionId, data }) => {
  const s = termSessions.get(sessionId);
  if (s) s.socket.write(data);
});

ipcMain.handle('term:resize', async (_, { sessionId, cols, rows }) => {
  const s = termSessions.get(sessionId);
  if (!s) return { ok: false };
  try {
    await dockerRequest({ host: s.host, port: s.port, path: `/exec/${s.execId}/resize?h=${rows}&w=${cols}`, method: 'POST' });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('term:kill', (_, { sessionId }) => {
  const s = termSessions.get(sessionId);
  if (s) {
    try { s.socket.end(); s.socket.destroy(); } catch {}
    termSessions.delete(sessionId);
  }
  return { ok: true };
});

// ─── One-shot exec capture (used by file browser) ─────────────────────────────
function execCapture(host, port, id, cmd, timeoutMs = 20000) {
  return new Promise(async (resolve, reject) => {
    try {
      const er = await dockerRequest({ host, port, path: `/containers/${id}/exec`, method: 'POST' }, {
        AttachStdout: true, AttachStderr: true, Tty: false,
        Cmd: ['/bin/sh', '-c', cmd]
      });
      if (!er.body || !er.body.Id) return reject(new Error('Exec create failed (is the container running?)'));
      const agent = createAgent(host);
      if (!agent) return reject(new Error('TLS certs not loaded'));
      const bodyStr = JSON.stringify({ Detach: false, Tty: false });
      const req = https.request({
        hostname: host, port: port || 2376,
        path: `/exec/${er.body.Id}/start`, method: 'POST', agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
      }, (res) => {
        let buf = Buffer.alloc(0), out = '';
        res.on('data', c => {
          buf = Buffer.concat([buf, c]);
          while (buf.length >= 8) {
            const len = buf.readUInt32BE(4);
            if (buf.length < 8 + len) break;
            out += buf.slice(8, 8 + len).toString('utf8');
            buf = buf.slice(8 + len);
          }
        });
        res.on('end', () => resolve(out));
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Exec timeout')));
      req.on('error', reject);
      req.end(bodyStr);
    } catch (e) { reject(e); }
  });
}

// ─── Minimal tar (for the Docker archive API) ─────────────────────────────────
function tarExtractFirst(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.slice(off, off + 512);
    if (h.every(b => b === 0)) break;
    const name = h.slice(0, 100).toString().replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.slice(124, 136).toString().replace(/\0[\s\S]*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(h[156]);
    off += 512;
    if (type === '0' || type === '\0' || type === '') {
      return { name, content: buf.slice(off, off + size) };
    }
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

function tarCreate(name, content, mode = 0o644) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0);
  h.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);            // checksum placeholder
  h[156] = 48;                          // type '0' = regular file
  h.write('ustar', 257); h[262] = 0; h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([h, content, pad, Buffer.alloc(1024)]);
}

function getArchive(host, port, id, filePath, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(host);
    if (!agent) return reject(new Error('TLS certs not loaded'));
    const req = https.request({
      hostname: host, port: port || 2376,
      path: `/containers/${id}/archive?path=${encodeURIComponent(filePath)}`, agent
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + (res.statusCode === 404 ? ' (not found)' : ''))); }
      const chunks = []; let total = 0;
      res.on('data', c => {
        chunks.push(c); total += c.length;
        if (total > maxBytes) req.destroy(new Error(`File too large (>${Math.round(maxBytes / 1048576)}MB)`));
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Download timeout')));
    req.end();
  });
}

function putArchive(host, port, id, destDir, tarBuf) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(host);
    if (!agent) return reject(new Error('TLS certs not loaded'));
    const req = https.request({
      hostname: host, port: port || 2376,
      path: `/containers/${id}/archive?path=${encodeURIComponent(destDir)}`,
      method: 'PUT', agent,
      headers: { 'Content-Type': 'application/x-tar', 'Content-Length': tarBuf.length }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error((/"message":"([^"]+)"/.exec(d) || [])[1] || 'HTTP ' + res.statusCode));
        resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Upload timeout')));
    req.end(tarBuf);
  });
}

// ─── File browser IPC ─────────────────────────────────────────────────────────
ipcMain.handle('files:list', async (_, { host, port, id, dirPath }) => {
  try {
    const safe = dirPath.replace(/'/g, "'\\''");
    const out = await execCapture(host, port, id, `cd '${safe}' && LC_ALL=C ls -lA`);
    const entries = [];
    for (const line of out.split('\n')) {
      const m = /^([dlbcsp-])([rwxsStT-]{9})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)(?:,\s*\d+)?\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      let name = m[7], link = null;
      if (m[1] === 'l' && name.includes(' -> ')) [name, link] = name.split(' -> ');
      entries.push({ name, type: m[1] === 'd' ? 'dir' : m[1] === 'l' ? 'link' : 'file', size: +m[5], date: m[6], perm: m[1] + m[2], link });
    }
    if (!entries.length && /can't cd|No such file|Permission denied|not found/i.test(out)) {
      return { ok: false, error: out.trim().split('\n')[0] };
    }
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('files:download', async (e, { host, port, id, filePath }) => {
  try {
    const tar = await getArchive(host, port, id, filePath);
    const f = tarExtractFirst(tar);
    if (!f) throw new Error('Empty archive');
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.basename(filePath) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, f.content);
    return { ok: true, savedTo: r.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('files:read', async (_, { host, port, id, filePath }) => {
  try {
    const tar = await getArchive(host, port, id, filePath, 1024 * 1024);
    const f = tarExtractFirst(tar);
    if (!f) throw new Error('Empty archive');
    if (f.content.includes(0)) return { ok: false, error: 'Binary file — use Download instead' };
    return { ok: true, content: f.content.toString('utf8') };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('files:write', async (_, { host, port, id, destDir, name, content }) => {
  try {
    await putArchive(host, port, id, destDir, tarCreate(name, Buffer.from(content, 'utf8')));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('files:upload', async (e, { host, port, id, destDir }) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const src = r.filePaths[0];
    const data = fs.readFileSync(src);
    if (data.length > 100 * 1024 * 1024) throw new Error('File too large (>100MB)');
    await putArchive(host, port, id, destDir, tarCreate(path.basename(src), data));
    return { ok: true, name: path.basename(src) };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ─── Deploy wizard ────────────────────────────────────────────────────────────
ipcMain.handle('deploy:create', async (_, { host, port, spec }) => {
  try {
    await pullImage(host, port, spec.image);
    const ExposedPorts = {}, PortBindings = {};
    for (const p of (spec.ports || [])) {
      if (!p.cont) continue;
      const key = `${p.cont}/${p.proto || 'tcp'}`;
      ExposedPorts[key] = {};
      PortBindings[key] = [{ HostPort: String(p.host || p.cont) }];
    }
    const Binds = (spec.volumes || []).filter(v => v.host && v.cont).map(v => `${v.host}:${v.cont}`);
    const payload = {
      Image: spec.image,
      Env: (spec.env || []).filter(s => s && s.includes('=')),
      ExposedPorts: Object.keys(ExposedPorts).length ? ExposedPorts : undefined,
      HostConfig: {
        PortBindings: Object.keys(PortBindings).length ? PortBindings : undefined,
        Binds: Binds.length ? Binds : undefined,
        RestartPolicy: spec.restart && spec.restart !== 'no' ? { Name: spec.restart } : undefined,
        NetworkMode: spec.network || undefined
      }
    };
    const cr = await dockerRequest({
      host, port,
      path: `/containers/create${spec.name ? '?name=' + encodeURIComponent(spec.name) : ''}`,
      method: 'POST', timeout: 40000
    }, payload);
    if (!cr.body || !cr.body.Id) {
      return { ok: false, error: (cr.body && cr.body.message) || ('Create failed (HTTP ' + cr.status + ')') };
    }
    const sr = await dockerRequest({ host, port, path: `/containers/${cr.body.Id}/start`, method: 'POST', timeout: 40000 });
    if (sr.status >= 400) {
      return { ok: false, error: 'Created but failed to start: ' + ((sr.body && sr.body.message) || 'HTTP ' + sr.status), id: cr.body.Id };
    }
    return { ok: true, id: cr.body.Id };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Live log streaming (follow mode, demuxed) ───────────────────────────────
const logSessions = new Map();

ipcMain.handle('logs:start', async (e, { host, port, id }) => {
  try {
    const agent = createAgent(host);
    if (!agent) return { ok: false, error: 'TLS certs not loaded' };
    const sessionId = randomUUID();
    const sender = e.sender;

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: port || 2376,
        path: `/containers/${id}/logs?follow=true&stdout=true&stderr=true&tail=200`,
        method: 'GET', agent
      });
      req.on('response', (res) => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
        logSessions.set(sessionId, { req });
        let buf = Buffer.alloc(0), mode = null;
        const emit = (text) => { if (text && !sender.isDestroyed()) sender.send('logs:data', { sessionId, text }); };
        res.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          if (mode === null && buf.length >= 8) {
            mode = (buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) ? 'mux' : 'raw';
          }
          if (mode === 'raw') { emit(buf.toString('utf8')); buf = Buffer.alloc(0); return; }
          if (mode === 'mux') {
            let out = '';
            while (buf.length >= 8) {
              const len = buf.readUInt32BE(4);
              if (buf.length < 8 + len) break;
              out += buf.slice(8, 8 + len).toString('utf8');
              buf = buf.slice(8 + len);
            }
            emit(out);
          }
        });
        res.on('end', () => {
          logSessions.delete(sessionId);
          if (!sender.isDestroyed()) sender.send('logs:end', { sessionId });
        });
        res.on('error', () => {});
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('logs:stop', (_, { sessionId }) => {
  const s = logSessions.get(sessionId);
  if (s) { try { s.req.destroy(); } catch {} logSessions.delete(sessionId); }
  return { ok: true };
});

// ─── Menu bar (tray) companion with graphical popover ────────────────────────
let tray = null, trayData = null, isQuitting = false, mainWin = null;
let popWin = null, trayEnabled = true;

async function trayAction(id, action) {
  const d = trayData && trayData.data;
  if (!d || !d.cfg) return;
  const paths = { start: `/containers/${id}/start`, stop: `/containers/${id}/stop`, restart: `/containers/${id}/restart` };
  try { await dockerRequest({ host: d.cfg.host, port: d.cfg.port, path: paths[action], method: 'POST' }); } catch {}
  if (trayData.sender && !trayData.sender.isDestroyed()) trayData.sender.send('app:refresh');
}

let popLastShown = 0;

function createPopover() {
  popWin = new BrowserWindow({
    width: 330, height: 528,
    show: false, frame: false, transparent: true, resizable: false,
    movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  popWin.loadFile('tray.html');
  popWin.setAlwaysOnTop(true, 'pop-up-menu');
  popWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Grace period: the tray click that opens the window can fire an immediate blur
  popWin.on('blur', () => {
    if (popWin && Date.now() - popLastShown > 300) popWin.hide();
  });
  popWin.on('closed', () => { popWin = null; });
  popWin.webContents.on('did-finish-load', () => {
    if (trayData && popWin) popWin.webContents.send('tray:data', trayData.data);
  });
}

function showPopover() {
  if (!popWin) createPopover();
  const tb = (tray && tray.getBounds()) || { x: 0, y: 0, width: 24, height: 24 };
  const x = Math.round(tb.x + tb.width / 2 - 165);
  const y = Math.round(tb.y + tb.height + 5);
  popWin.setPosition(Math.max(x, 8), y, false);
  if (trayData) popWin.webContents.send('tray:data', trayData.data);
  const reveal = () => {
    if (!popWin) return;
    popLastShown = Date.now();
    popWin.show();
    popWin.focus();
  };
  if (popWin.webContents.isLoading()) popWin.webContents.once('did-finish-load', reveal);
  else reveal();
}

function togglePopover() {
  if (popWin && popWin.isVisible()) { popWin.hide(); return; }
  showPopover();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icons', 'tray-iconTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Portside');
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => togglePopover());
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open Portside', click: () => { if (mainWin) { mainWin.show(); app.focus({ steal: true }); } } },
      { type: 'separator' },
      { label: 'Quit Portside', click: () => { isQuitting = true; app.quit(); } }
    ]));
  });
}

function destroyTray() {
  if (popWin) { popWin.destroy(); popWin = null; }
  if (tray) { tray.destroy(); tray = null; }
}

ipcMain.on('tray:update', (e, data) => {
  trayData = { data, sender: e.sender };
  if (tray) tray.setTitle(data.alerts ? ` ${data.alerts}` : '');
  if (popWin && popWin.isVisible()) popWin.webContents.send('tray:data', data);
});

ipcMain.on('tray:action', (_, { id, action }) => trayAction(id, action));
ipcMain.on('tray:open-app', () => {
  if (popWin) popWin.hide();
  if (mainWin) { mainWin.show(); app.focus({ steal: true }); }
});
ipcMain.on('tray:quit', () => { isQuitting = true; app.quit(); });
ipcMain.on('tray:hide', () => { if (popWin) popWin.hide(); });

ipcMain.handle('app:set-tray', (_, enabled) => {
  trayEnabled = !!enabled;
  if (trayEnabled && !tray) createTray();
  if (!trayEnabled) destroyTray();
  return trayEnabled;
});

// Stats streaming (Docker /stats?stream=false for one-shot)
function getContainerStats(host, port, id) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(host);
    if (!agent) return reject(new Error('TLS certs not loaded'));

    const options = {
      hostname: host,
      port: port || 2376,
      path: `/containers/${id}/stats?stream=false`,
      method: 'GET',
      agent
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('Stats timeout')); });
    req.end();
  });
}

// Get container logs
function getContainerLogs(host, port, id) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(host);
    if (!agent) return reject(new Error('TLS certs not loaded'));

    const options = {
      hostname: host,
      port: port || 2376,
      path: `/containers/${id}/logs?stdout=true&stderr=true&tail=200&timestamps=true`,
      method: 'GET',
      agent
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        // Docker log format has 8-byte header per frame; strip it
        const buf = Buffer.concat(chunks);
        let output = '';
        let i = 0;
        while (i + 8 <= buf.length) {
          const frameLen = buf.readUInt32BE(i + 4);
          if (i + 8 + frameLen > buf.length) break;
          output += buf.slice(i + 8, i + 8 + frameLen).toString('utf8');
          i += 8 + frameLen;
        }
        resolve(output || buf.toString('utf8'));
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Logs timeout')); });
    req.end();
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_, cfg) => { saveConfig(cfg); return true; });

ipcMain.handle('docker:info', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/info' });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:containers', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/containers/json?all=true' });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:stats', async (_, { host, port, id }) => {
  try {
    const data = await getContainerStats(host, port, id);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:logs', async (_, { host, port, id }) => {
  try {
    const logs = await getContainerLogs(host, port, id);
    return { ok: true, data: logs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:action', async (_, { host, port, id, action }) => {
  const methodMap = { start: 'POST', stop: 'POST', restart: 'POST', remove: 'DELETE' };
  const pathMap = {
    start:   `/containers/${id}/start`,
    stop:    `/containers/${id}/stop`,
    restart: `/containers/${id}/restart`,
    remove:  `/containers/${id}?force=true`
  };
  try {
    const r = await dockerRequest({
      host, port,
      path: pathMap[action],
      method: methodMap[action]
    });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:images', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/images/json' });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:volumes', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/volumes' });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── Portside self-update check (GitHub releases) ─────────────────────────────
const GITHUB_REPO = 'Mac2100/portside';

function compareVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:check-update', async () => {
  try {
    const r = await regRequest('GET', `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      'User-Agent': 'Portside-App', 'Accept': 'application/vnd.github+json'
    });
    if (r.status === 404) return { ok: true, current: app.getVersion(), latest: app.getVersion(), newer: false };
    if (r.status !== 200) return { ok: false, error: 'GitHub HTTP ' + r.status };
    const rel = JSON.parse(r.body);
    const latest = (rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    const dmg = (rel.assets || []).find(a => /\.dmg$/i.test(a.name)) || (rel.assets || []).find(a => /\.zip$/i.test(a.name));
    return {
      ok: true, current, latest,
      newer: compareVer(latest, current) > 0,
      url: rel.html_url || `https://github.com/${GITHUB_REPO}/releases`,
      dmgUrl: dmg ? dmg.browser_download_url : '',
      assetName: dmg ? dmg.name : ''
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Download the release installer (.dmg) and open it (drag-to-Applications). No code signing required.
ipcMain.handle('app:download-update', async (_e, { url, name }) => {
  try {
    if (!url) return { ok: false, error: 'That release has no downloadable installer attached.' };
    const dest = path.join(app.getPath('downloads'), name || 'Portside-update.dmg');
    await downloadFile(url, dest, (pct) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app:download-progress', pct); });
    shell.openPath(dest); // mounts the .dmg and opens its window so the user can drag Portside → Applications
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ─── Image update checker ─────────────────────────────────────────────────────
let updatesCaches = {}; // keyed by host IP

function regRequest(method, urlStr, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).href;
        return regRequest(method, next, headers, redirects + 1).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Registry timeout')));
    req.end();
  });
}

// Stream a URL to a file (follows redirects — GitHub asset URLs redirect to S3), reporting % progress.
function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'Portside-App' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return downloadFile(new URL(res.headers.location, url).href, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (total && onProgress) onProgress(Math.round((got / total) * 100)); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('Download timed out')));
    req.end();
  });
}

function parseImageRef(image) {
  let ref = image.split('@')[0];
  let tag = 'latest';
  const ti = ref.lastIndexOf(':');
  if (ti > ref.lastIndexOf('/')) { tag = ref.slice(ti + 1); ref = ref.slice(0, ti); }
  let host = 'registry-1.docker.io', repo = ref;
  const first = ref.split('/')[0];
  if (first.includes('.') || first.includes(':') || first === 'localhost') {
    host = first; repo = ref.slice(first.length + 1);
  } else if (!ref.includes('/')) {
    repo = 'library/' + ref;
  }
  if (host === 'docker.io' || host === 'index.docker.io') host = 'registry-1.docker.io';
  if (host === 'registry-1.docker.io' && !repo.includes('/')) repo = 'library/' + repo;
  return { host, repo, tag };
}

async function remoteDigest(image) {
  const { host, repo, tag } = parseImageRef(image);
  const url = `https://${host}/v2/${repo}/manifests/${tag}`;
  const accept = 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json';
  let res = await regRequest('HEAD', url, { Accept: accept });
  if (res.status === 401) {
    const wa = res.headers['www-authenticate'] || '';
    const realm = (/realm="([^"]+)"/.exec(wa) || [])[1];
    const service = (/service="([^"]+)"/.exec(wa) || [])[1];
    if (!realm) throw new Error('Auth required');
    const tr = await regRequest('GET', `${realm}?service=${encodeURIComponent(service || '')}&scope=${encodeURIComponent(`repository:${repo}:pull`)}`);
    const tok = JSON.parse(tr.body || '{}');
    const token = tok.token || tok.access_token;
    if (!token) throw new Error('Token fetch failed');
    res = await regRequest('HEAD', url, { Accept: accept, Authorization: `Bearer ${token}` });
  }
  if (res.status !== 200) throw new Error('Registry HTTP ' + res.status);
  return res.headers['docker-content-digest'] || null;
}

ipcMain.handle('updates:check', async (_, { host, port, force }) => {
  const cached = updatesCaches[host];
  if (!force && cached && Date.now() - cached.time < 6 * 3600e3 && cached.results.length) {
    return { ok: true, cached: true, time: cached.time, results: cached.results };
  }
  try {
    const cr = await dockerRequest({ host, port, path: '/containers/json?all=true' });
    const byImage = new Map();
    for (const c of (cr.body || [])) {
      const img = c.Image;
      if (!img || img.startsWith('sha256:')) continue;
      if (!byImage.has(img)) byImage.set(img, []);
      byImage.get(img).push({ id: c.Id, name: ((c.Names && c.Names[0]) || '').replace(/^\//, ''), state: c.State });
    }
    const results = [];
    const imgs = [...byImage.keys()];
    for (let i = 0; i < imgs.length; i += 4) {
      await Promise.all(imgs.slice(i, i + 4).map(async (image) => {
        const entry = {
          image,
          shortName: image.split('@')[0].split('/').pop().split(':')[0],
          containers: byImage.get(image),
          updateAvailable: false
        };
        try {
          const ir = await dockerRequest({ host, port, path: `/images/${encodeURIComponent(image)}/json` });
          const digests = (ir.body && ir.body.RepoDigests) || [];
          if (!digests.length || !digests[0].includes('@')) { entry.note = 'local build'; results.push(entry); return; }
          const local = digests[0].split('@')[1];
          const remote = await remoteDigest(image);
          entry.updateAvailable = !!remote && remote !== local;
        } catch (e) {
          entry.error = e.message;
        }
        results.push(entry);
      }));
    }
    updatesCaches[host] = { time: Date.now(), results };
    return { ok: true, time: updatesCaches[host].time, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function pullImage(host, port, image) {
  return new Promise((resolve, reject) => {
    const agent = createAgent(host);
    if (!agent) return reject(new Error('TLS certs not loaded'));
    const ref = image.split('@')[0];
    let repo = ref, tag = 'latest';
    const ti = ref.lastIndexOf(':');
    if (ti > ref.lastIndexOf('/')) { tag = ref.slice(ti + 1); repo = ref.slice(0, ti); }
    const req = https.request({
      hostname: host, port: port || 2376,
      path: `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
      method: 'POST', agent, headers: { 'Content-Length': 0 }
    }, (res) => {
      let tail = '';
      res.on('data', d => { tail += d.toString(); if (tail.length > 2e5) tail = tail.slice(-5e4); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Pull failed (HTTP ' + res.statusCode + ')'));
        const err = /"error"\s*:\s*"([^"]+)"/.exec(tail);
        if (err) return reject(new Error('Pull error: ' + err[1]));
        resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('Pull timeout')));
    req.end();
  });
}

ipcMain.handle('updates:apply', async (_, { host, port, id }) => {
  try {
    const ins = await dockerRequest({ host, port, path: `/containers/${id}/json` });
    const c = ins.body;
    if (!c || !c.Config) throw new Error('Inspect failed');
    const name = (c.Name || '').replace(/^\//, '');
    const image = c.Config.Image;

    await pullImage(host, port, image);

    // Rebuild create payload from live config
    const endpoints = {};
    for (const [net, conf] of Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {})) {
      endpoints[net] = {};
      if (conf.Aliases) endpoints[net].Aliases = conf.Aliases.filter(a => !id.startsWith(a));
      if (conf.IPAMConfig) endpoints[net].IPAMConfig = conf.IPAMConfig;
    }
    const payload = { ...c.Config, Image: image, HostConfig: c.HostConfig };
    if (Object.keys(endpoints).length) payload.NetworkingConfig = { EndpointsConfig: endpoints };
    if (payload.Hostname && id.startsWith(payload.Hostname)) delete payload.Hostname;

    const wasRunning = c.State && c.State.Running;
    if (wasRunning) await dockerRequest({ host, port, path: `/containers/${id}/stop?t=20`, method: 'POST', timeout: 40000 });
    const bak = `${name}-old-${Date.now().toString(36)}`;
    await dockerRequest({ host, port, path: `/containers/${id}/rename?name=${encodeURIComponent(bak)}`, method: 'POST' });

    let newId = null;
    try {
      const crr = await dockerRequest({ host, port, path: `/containers/create?name=${encodeURIComponent(name)}`, method: 'POST', timeout: 40000 }, payload);
      if (!crr.body || !crr.body.Id) throw new Error('Create failed: ' + JSON.stringify(crr.body).slice(0, 200));
      newId = crr.body.Id;
      const sr = await dockerRequest({ host, port, path: `/containers/${newId}/start`, method: 'POST', timeout: 40000 });
      if (sr.status >= 400) throw new Error('Start failed (HTTP ' + sr.status + ')');
      await dockerRequest({ host, port, path: `/containers/${id}?force=true`, method: 'DELETE', timeout: 40000 });
      return { ok: true, newId };
    } catch (err) {
      // Rollback: remove half-made container, restore old name, restart old
      if (newId) await dockerRequest({ host, port, path: `/containers/${newId}?force=true`, method: 'DELETE' }).catch(() => {});
      await dockerRequest({ host, port, path: `/containers/${id}/rename?name=${encodeURIComponent(name)}`, method: 'POST' }).catch(() => {});
      if (wasRunning) await dockerRequest({ host, port, path: `/containers/${id}/start`, method: 'POST' }).catch(() => {});
      throw err;
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── Historical metrics (persisted to userData/history.json) ─────────────────
let histData = null, histDirty = false;

function ensureHist() {
  if (histData !== null) return;
  try { histData = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'history.json'), 'utf8')); }
  catch { histData = []; }
}
function flushHist() {
  if (!histDirty || histData === null) return;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'history.json'), JSON.stringify(histData)); histDirty = false; } catch {}
}
setInterval(flushHist, 60000);

ipcMain.on('history:append', (_, s) => {
  ensureHist();
  histData.push(s);
  const cut = Date.now() - 7 * 86400e3;
  if (histData.length && histData[0].t < cut) histData = histData.filter(p => p.t >= cut);
  histDirty = true;
});

ipcMain.handle('history:get', (_, { ms, buckets = 240, host }) => {
  ensureHist();
  const from = Date.now() - ms;
  const pts = histData.filter(p => p.t >= from && (!host || !p.host || p.host === host));
  const out = { cpu: [], mem: [], rx: [], tx: [] };
  if (!pts.length) return out;
  const bsize = ms / buckets;
  let i = 0;
  for (let b = 0; b < buckets; b++) {
    const end = from + (b + 1) * bsize;
    let n = 0, cpu = 0, mem = 0, rx = 0, tx = 0;
    while (i < pts.length && pts[i].t < end) {
      cpu += pts[i].cpu; mem += pts[i].mem; rx += pts[i].rx; tx += pts[i].tx; n++; i++;
    }
    if (n) { out.cpu.push(cpu / n); out.mem.push(mem / n); out.rx.push(rx / n); out.tx.push(tx / n); }
  }
  return out;
});

// ─── Settings: certs / autostart / dock icon ─────────────────────────────────
function certSummary(file) {
  try {
    const pem = fs.readFileSync(file, 'utf8');
    const x = new X509Certificate(pem);
    const cn = (/CN=([^\n,]+)/.exec(x.subject) || [])[1] || x.subject.split('\n')[0];
    return { cn, validTo: x.validTo, expired: new Date(x.validTo) < new Date() };
  } catch (e) {
    return { error: e.message };
  }
}

ipcMain.handle('certs:info', (_, args) => {
  const hostId = args && args.hostId;
  let dir, source;
  if (hostId && certsComplete(hostCertsDir(hostId))) { dir = hostCertsDir(hostId); source = 'host'; }
  else if (certsComplete(userCertsDir())) { dir = userCertsDir(); source = 'custom'; }
  else { dir = path.join(__dirname, 'certs'); source = 'bundled'; }
  return {
    source,
    ca: certSummary(path.join(dir, 'ca.pem')),
    cert: certSummary(path.join(dir, 'cert.pem')),
    key: fs.existsSync(path.join(dir, 'key.pem'))
  };
});

ipcMain.handle('certs:import', async (e, args) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Select certificate files (ca.pem, cert.pem, key.pem)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Certificates & keys', extensions: ['pem', 'crt', 'cer', 'key'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };

  const dir = (args && args.hostId) ? hostCertsDir(args.hostId) : userCertsDir();
  fs.mkdirSync(dir, { recursive: true });
  const placed = [];
  for (const f of r.filePaths) {
    const content = fs.readFileSync(f, 'utf8');
    let target = null;
    if (content.includes('PRIVATE KEY')) target = 'key.pem';
    else {
      try {
        const x = new X509Certificate(content);
        target = (x.ca || x.subject === x.issuer) ? 'ca.pem' : 'cert.pem';
      } catch { return { ok: false, error: `${path.basename(f)} is not a valid PEM certificate or key` }; }
    }
    fs.writeFileSync(path.join(dir, target), content);
    placed.push(`${path.basename(f)} → ${target}`);
  }
  const missing = ['ca.pem', 'cert.pem', 'key.pem'].filter(f => !fs.existsSync(path.join(dir, f)));
  return { ok: true, placed, missing, active: missing.length === 0 };
});

ipcMain.handle('certs:reset', (_, args) => {
  const dir = (args && args.hostId) ? hostCertsDir(args.hostId) : userCertsDir();
  for (const f of ['ca.pem', 'cert.pem', 'key.pem']) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
  return { ok: true };
});

ipcMain.on('app:open-url', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// ─── Docker events stream (Activity feed) ─────────────────────────────────────
let eventsBuffer = [], eventsReq = null, eventsHost = null;

function startEvents(host, port) {
  if (eventsReq) { try { eventsReq.destroy(); } catch {} eventsReq = null; }
  eventsHost = host;
  const agent = createAgent(host);
  if (!agent) return;
  // Reconnect after any failure (error, end, or non-200) — a single hiccup must not kill Activity for good.
  const reconnect = () => { if (eventsHost === host) setTimeout(() => { if (eventsHost === host && !eventsReq) startEvents(host, port); }, 5000); };
  const OK_TYPES = ['container', 'image', 'volume', 'network'];
  // No ?filters= — some Docker/Container Station builds reject the filter form and drop the stream. Filter types here instead.
  const req = https.request({ hostname: host, port: port || 2376, path: '/events', agent }, (res) => {
    if (res.statusCode !== 200) { res.resume(); eventsReq = null; reconnect(); return; }
    let acc = '';
    res.on('data', (c) => {
      acc += c.toString();
      let i;
      while ((i = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, i).trim(); acc = acc.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const action = ev.Action || '';
          if (/^exec_|^top$|^archive|^prune$/.test(action)) continue; // our own polling noise
          const type = ev.Type || 'container';
          if (!OK_TYPES.includes(type)) continue;
          const attrs = (ev.Actor && ev.Actor.Attributes) || {};
          const item = {
            t: ev.time ? ev.time * 1000 : Date.now(),
            type, action,
            name: attrs.name || attrs.image || (ev.Actor && (ev.Actor.ID || '').slice(0, 12)) || '',
            extra: attrs.exitCode ? 'exit ' + attrs.exitCode : (type === 'image' ? attrs.name || '' : ''),
            host
          };
          eventsBuffer.push(item);
          if (eventsBuffer.length > 500) eventsBuffer.shift();
          if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('events:item', item);
        } catch {}
      }
    });
    res.on('end',   () => { eventsReq = null; reconnect(); });
    res.on('error', () => { eventsReq = null; reconnect(); });
  });
  req.on('error', () => { eventsReq = null; reconnect(); });
  eventsReq = req;
  req.end();
}

ipcMain.on('events:start', (_, { host, port }) => startEvents(host, port));
ipcMain.handle('events:list', (_, args) => {
  const host = args && args.host;
  return eventsBuffer.filter(e => !host || e.host === host);
});

ipcMain.handle('app:get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('app:set-login-item', (_, open) => {
  app.setLoginItemSettings({ openAtLogin: !!open });
  return app.getLoginItemSettings().openAtLogin;
});

const LOGO_VARIANTS = ['teal', 'violet', 'sunset', 'mono'];
function setDockIcon(variant) {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (!LOGO_VARIANTS.includes(variant)) variant = 'teal';
  const img = nativeImage.createFromPath(path.join(__dirname, 'icons', `logo-${variant}.png`));
  if (!img.isEmpty()) app.dock.setIcon(img);
}
ipcMain.on('app:set-dock-icon', (_, variant) => setDockIcon(variant));

ipcMain.handle('docker:inspect', async (_, { host, port, id }) => {
  try {
    const r = await dockerRequest({ host, port, path: `/containers/${id}/json` });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:prune-images', async (_, { host, port }) => {
  try {
    // No filter = dangling images only (safe default)
    const r = await dockerRequest({ host, port, path: '/images/prune', method: 'POST', timeout: 30000 });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('dock:badge', (_, count) => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  }
});

ipcMain.handle('docker:df', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/system/df', timeout: 25000 });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('docker:networks', async (_, { host, port }) => {
  try {
    const r = await dockerRequest({ host, port, path: '/networks' });
    return { ok: true, data: r.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ─── Git Deploy (pull a bind-mounted app folder from GitHub, then restart) ────
// Deploy a code change without leaving Portside: run a throwaway alpine/git
// container that's bind-mounted to the app folder, fetch the private repo, and
// `reset --hard` to the latest commit (or an older one to roll back), then
// restart the app container. The read-only token is stored ENCRYPTED via Electron
// safeStorage (macOS Keychain) and handed to the git container only at run-time
// as an env var — it is never written into the repo's .git/config on the NAS.

function getGitDeploys() { try { return loadConfig().gitDeploys || {}; } catch { return {}; } }

function encToken(tok) {
  if (!tok) return '';
  try { if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(tok).toString('base64'); } catch {}
  return 'raw:' + Buffer.from(tok, 'utf8').toString('base64'); // fallback if Keychain unavailable
}
function decToken(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    if (stored.startsWith('raw:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  } catch {}
  return '';
}

// One shared read-only token for ALL apps, stored encrypted at the top level of config.
function getGitToken() { try { return decToken(loadConfig().gitDeployToken || ''); } catch { return ''; } }

// clean "github.com/owner/repo" (no scheme, no .git) — the token is added at run-time via $GT
function gitBase(repoUrl) { return String(repoUrl || '').trim().replace(/^https?:\/\//, '').replace(/\.git$/, ''); }

// Run a one-shot alpine/git container against the app folder; capture output + exit code.
async function runGitContainer(host, port, folder, token, shellCmd) {
  await pullImage(host, port, 'alpine/git');
  const cr = await dockerRequest({ host, port, path: '/containers/create', method: 'POST', timeout: 40000 }, {
    Image: 'alpine/git',
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [shellCmd],
    Env: token ? ['GT=' + token] : [],
    HostConfig: { Binds: [`${folder}:/git`], AutoRemove: false, NetworkMode: 'bridge' }
  });
  if (!cr.body || !cr.body.Id) throw new Error((cr.body && cr.body.message) || 'git container create failed');
  const id = cr.body.Id;
  try {
    const sr = await dockerRequest({ host, port, path: `/containers/${id}/start`, method: 'POST', timeout: 40000 });
    if (sr.status >= 400) throw new Error('git container failed to start (HTTP ' + sr.status + ')');
    const wr = await dockerRequest({ host, port, path: `/containers/${id}/wait`, method: 'POST', timeout: 180000 });
    const exitCode = (wr.body && typeof wr.body.StatusCode === 'number') ? wr.body.StatusCode : -1;
    const output = await getContainerLogs(host, port, id).catch(() => '');
    return { exitCode, output };
  } finally {
    dockerRequest({ host, port, path: `/containers/${id}?force=true`, method: 'DELETE' }).catch(() => {});
  }
}

// Read the saved deploy config for a container key (token never returned raw).
ipcMain.handle('gitdeploy:get', (_, { key }) => {
  const d = getGitDeploys()[key];
  const hasToken = !!loadConfig().gitDeployToken; // shared across all apps
  return { configured: !!d, repoUrl: (d && d.repoUrl) || '', branch: (d && d.branch) || 'main', folder: (d && d.folder) || '', hasToken };
});

// Save/update deploy config. token is optional — omit to keep the existing one.
ipcMain.handle('gitdeploy:set', (_, { key, repoUrl, branch, folder, token }) => {
  try {
    const c = loadConfig();
    c.gitDeploys = c.gitDeploys || {};
    const prev = c.gitDeploys[key] || {};
    c.gitDeploys[key] = {
      repoUrl: (repoUrl != null ? repoUrl : prev.repoUrl || '').trim(),
      branch: (branch != null && branch !== '' ? branch : prev.branch || 'main').trim(),
      folder: (folder != null ? folder : prev.folder || '').trim()
    };
    if (token != null && token !== '') c.gitDeployToken = encToken(String(token).trim()); // shared token — one for every app
    saveConfig(c);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('gitdeploy:forget', (_, { key }) => {
  try { const c = loadConfig(); if (c.gitDeploys) { delete c.gitDeploys[key]; saveConfig(c); } return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// List recent commits for the rollback picker (fetches, changes nothing on disk).
ipcMain.handle('gitdeploy:versions', async (_, { host, port, key }) => {
  try {
    const d = getGitDeploys()[key];
    if (!d || !d.folder || !d.repoUrl) return { ok: false, error: 'Not configured' };
    const branch = d.branch || 'main';
    const cmd = [
      'cd /git',
      'git config --global --add safe.directory /git',
      'git rev-parse --git-dir >/dev/null 2>&1 || git init -q',
      `git fetch --tags "https://x-access-token:$GT@${gitBase(d.repoUrl)}.git" "${branch}"`,
      'git --no-pager log FETCH_HEAD --oneline -20'
    ].join(' && ');
    const r = await runGitContainer(host, port, d.folder, getGitToken(), cmd);
    if (r.exitCode !== 0) return { ok: false, error: (r.output || 'git failed').trim().split('\n').slice(-3).join('\n') };
    const commits = r.output.split('\n').map(l => l.trim()).filter(Boolean)
      .map(l => { const m = /^([0-9a-f]{7,40})\s+(.*)$/.exec(l); return m ? { sha: m[1], msg: m[2] } : null; })
      .filter(Boolean);
    return { ok: true, commits };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Deploy: pull to latest (no ref) or roll back to a commit (ref = sha), then restart.
ipcMain.handle('gitdeploy:run', async (_, { host, port, key, ref, restartId }) => {
  try {
    const d = getGitDeploys()[key];
    if (!d || !d.folder || !d.repoUrl) return { ok: false, error: 'Not configured — set the repo and folder first.' };
    const branch = d.branch || 'main';
    const resetTo = (ref && ref !== 'latest') ? ref : 'FETCH_HEAD';
    const cmd = [
      'cd /git',
      'git config --global --add safe.directory /git',
      'git rev-parse --git-dir >/dev/null 2>&1 || git init -q',
      `git remote get-url origin >/dev/null 2>&1 || git remote add origin "${d.repoUrl}"`,
      `git remote set-url origin "${d.repoUrl}"`,
      `git fetch --tags "https://x-access-token:$GT@${gitBase(d.repoUrl)}.git" "${branch}"`,
      `git reset --hard ${resetTo}`,
      'echo "===PORTSIDE-DEPLOYED==="',
      'git --no-pager log -1 --format="%h %s"'
    ].join(' && ');
    const r = await runGitContainer(host, port, d.folder, getGitToken(), cmd);
    if (r.exitCode !== 0) {
      return { ok: false, error: (r.output || 'git failed').trim().split('\n').slice(-4).join('\n'), output: r.output };
    }
    let restarted = false, restartError = null;
    if (restartId) {
      const rr = await dockerRequest({ host, port, path: `/containers/${restartId}/restart`, method: 'POST', timeout: 40000 });
      if (rr.status >= 400) restartError = 'Files updated, but container restart failed (HTTP ' + rr.status + ')';
      else restarted = true;
    }
    const deployed = ((r.output.split('===PORTSIDE-DEPLOYED===')[1]) || '').trim().split('\n').pop().trim();
    return { ok: true, restarted, restartError, deployed, output: r.output };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false  // keep polling/notifications alive when hidden
    },
    icon: path.join(__dirname, 'icons', 'icon.png')
  });

  win.loadFile('index.html', process.env.PORTAINARR_PAGE ? { query: { page: process.env.PORTAINARR_PAGE } } : undefined);

  // Close → hide to menu bar if tray is on (keeps monitoring); otherwise quit
  win.on('close', (e) => {
    if (!isQuitting && trayEnabled) { e.preventDefault(); win.hide(); }
    else if (!isQuitting) { isQuitting = true; app.quit(); }
  });
  win.on('closed', () => { mainWin = null; });
}

// One-time migration: app was renamed Portainarr → Portside; carry over user data
function migrateUserData() {
  try {
    const newDir = app.getPath('userData');
    if (fs.existsSync(path.join(newDir, 'config.json'))) return;
    const oldDir = path.join(newDir, '..', 'Portainarr');
    if (!fs.existsSync(oldDir)) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['config.json', 'history.json']) {
      try { fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f)); } catch {}
    }
    const oldCerts = path.join(oldDir, 'certs');
    if (fs.existsSync(oldCerts)) {
      fs.mkdirSync(path.join(newDir, 'certs'), { recursive: true });
      for (const f of fs.readdirSync(oldCerts)) {
        try { fs.copyFileSync(path.join(oldCerts, f), path.join(newDir, 'certs', f)); } catch {}
      }
    }
  } catch {}
}

app.whenReady().then(() => {
  migrateUserData();
  const cfg = loadConfig();
  trayEnabled = cfg.trayEnabled !== false;
  createWindow();
  if (trayEnabled) createTray();
  if (cfg.logo && cfg.logo !== 'teal') setDockIcon(cfg.logo);
  if (process.env.PORTAINARR_POPOVER) {
    setTimeout(() => togglePopover(), 4000);
  }
});
app.on('before-quit', () => { isQuitting = true; flushHist(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (mainWin) mainWin.show();
  else if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
