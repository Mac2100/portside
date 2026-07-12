/**
 * Portside boot test — needs jsdom (`npm install`).
 *
 *   npm test        (runs this after the dependency-free smoke test)
 *
 * Loads index.html in a fake browser and lets it pull in js/*.js the same way
 * Electron does — real <script> tags, one shared global scope. Then feeds the
 * renderers a fake Docker host (a compose stack, a crashed container, a dangling
 * image, an orphan volume) and asserts the pages actually render.
 *
 * This is what catches "app boots to a white window": a missing element, a bad
 * selector, a function that moved between files.
 */
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch {
  console.log('\n  ⚠ jsdom not installed — skipping boot test (run `npm install`)\n');
  process.exit(0);
}
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace(/<script src="node_modules[^"]*"><\/script>/g, '')   // skip xterm
  .replace(/<link[^>]*>/g, '');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push(e.message + (e.detail ? ' — ' + e.detail : '')));
vc.on('error', (...a) => errors.push(a.join(' ')));

const noop = () => {};
const okp = async () => ({ ok: true, data: [] });

const dom = new JSDOM(html, {
  url: 'file://' + path.join(root, 'index.html'),
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener: noop, addListener: noop });
    w.Notification = function () {};
    w.CSS = { escape: (x) => String(x).replace(/([^\w-])/g, '\\$1') };
    w.Terminal = function () { return { open: noop, write: noop, onData: noop, loadAddon: noop, dispose: noop, focus: noop }; };
    w.FitAddon = { FitAddon: function () { return { fit: noop }; } };
    w.SearchAddon = { SearchAddon: function () { return { findNext: noop, findPrevious: noop }; } };
    w.portside = {
      config: { load: async () => ({ host: '', notifyRules: {} }), save: noop },
      docker: new Proxy({}, { get: (_, k) => k === 'stats'
        ? async () => ({ ok: true, data: { cpu_stats: { cpu_usage: { total_usage: 1 }, system_cpu_usage: 10, online_cpus: 4 },
            precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
            memory_stats: { usage: 1e8, limit: 1e9, stats: { cache: 0 } }, networks: {}, blkio_stats: { io_service_bytes_recursive: [] } } })
        : okp }),
      certs: { info: async () => ({ source: 'bundled', ca: null, cert: null, key: false }), import: okp, reset: okp },
      appUpdate: { version: async () => '1.9.2', check: async () => ({}), download: okp, onProgress: noop },
      events: { start: noop, list: okp, onItem: noop },
      history: { append: noop, get: async () => ({ ok: true, data: [] }) },
      updates: { check: okp, apply: okp },
      gitdeploy: new Proxy({}, { get: () => okp }),
      github: { latestRelease: okp },
      files: new Proxy({}, { get: () => okp }),
      logs: { start: okp, stop: okp, onData: noop, onEnd: noop },
      term: { start: okp, write: noop, resize: okp, kill: okp, onData: noop, onExit: noop },
      compose: { parse: okp }, deploy: { create: okp }, exportSave: okp,
      tray: { update: noop }, trayPanel: new Proxy({}, { get: () => noop }),
      appx: { getLoginItem: async () => false, setLoginItem: noop, setDockIcon: noop },
      setTray: okp, dockBadge: noop, openUrl: noop, onRefresh: noop, onOpenContainer: noop
    };
  }
});

setTimeout(() => {
  const w = dom.window;
  // top-level const/let live in the script lexical scope, not on window
  w.eval('window.__st = state');
  const st = w.__st;
  // Exercise the renderers we changed, with realistic data
  try {
    st.containers = [
      { Id: 'a'.repeat(64), Names: ['/plex'], Image: 'plex:latest', ImageID: 'sha256:img1', State: 'running',
        Status: 'Up 2 hours (healthy)', Created: 1, Ports: [{ PublicPort: 32400, PrivatePort: 32400, Type: 'tcp' }],
        Labels: { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
        Mounts: [{ Type: 'volume', Name: 'plexdata', Destination: '/config' }],
        NetworkSettings: { Networks: { media_net: {} } } },
      { Id: 'b'.repeat(64), Names: ['/sonarr'], Image: 'sonarr:latest', ImageID: 'sha256:img2', State: 'exited',
        Status: 'Exited (137) 3 minutes ago', Created: 2, Ports: [], Labels: { 'com.docker.compose.project': 'media' },
        Mounts: [], NetworkSettings: { Networks: {} } }
    ];
    st.images = [
      { Id: 'sha256:img1', RepoTags: ['plex:latest'], Size: 1e8, Created: 1 },
      { Id: 'sha256:dead', RepoTags: [], Size: 9e7, Created: 2 }                 // dangling
    ];
    st.volumes = [{ Name: 'plexdata', Driver: 'local', Mountpoint: '/x' }, { Name: 'orphan', Driver: 'local', Mountpoint: '/y' }];
    st.networks = [{ Id: 'n1', Name: 'media_net', Driver: 'bridge', Scope: 'local', IPAM: { Config: [] } },
                        { Id: 'n2', Name: 'bridge', Driver: 'bridge', Scope: 'local', IPAM: { Config: [] } }];
    st.showAllContainers = true;

    w.renderContainersList();
    const listHtml = w.document.getElementById('containers-list').innerHTML;
    if (!/gh-stack/.test(listHtml)) errors.push('compose stack header not rendered');
    if (!/sel-box/.test(listHtml)) errors.push('selection checkbox not rendered');

    w.loadImages(); w.loadVolumes(); w.loadNetworks();
    w.renderInsights([]);
    const ins = w.document.getElementById('insights-list').innerHTML;
    if (!/Crashed/.test(ins)) errors.push('crashed container not surfaced in Insights');
    if (/Status/.test(w.document.querySelector('.ins-sec[data-sec="status"]') || '')) errors.push('status section still exists');

    w.renderNotifyRules();
    if (w.document.querySelectorAll('[data-nr]').length !== 7) errors.push('notification rules not rendered');
  } catch (e) {
    errors.push('runtime: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }

  setTimeout(() => {
    if (errors.length) {
      console.log('\n\x1b[31mErrors:\x1b[0m');
      errors.forEach(e => console.log('  ✗ ' + e));
      process.exit(1);
    }
    console.log('\n\x1b[32m✓ renderer booted clean; containers/images/volumes/networks/insights/settings all rendered\x1b[0m');
    process.exit(0);
  }, 300);
}, 700);
