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
    w.__confirms = [];
    w.confirm = (msg) => { w.__confirms.push(msg); return true; };
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
      registry: { list: async () => [{ host: 'ghcr.io', username: 'mike' }], set: okp, remove: okp, test: okp },
      crashlog: {
        list: async () => [{ file: 'sonarr-123.log', name: 'sonarr', exitCode: '137', time: Date.now() }],
        get: async () => ({ ok: true, text: 'panic: out of memory\nexit status 137' }),
        save: okp, remove: okp
      },
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
  (async () => {
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
      { Id: 'sha256:img1', RepoTags: ['plex:latest'], Size: 1e8, Created: 1 },      // in use (plex)
      { Id: 'sha256:img2', RepoTags: ['sonarr:latest'], Size: 1e8, Created: 2 },    // in use (sonarr, stopped)
      { Id: 'sha256:img3', RepoTags: ['radarr:old'], Size: 2e8, Created: 3 },       // unused, tagged
      { Id: 'sha256:dead', RepoTags: [], Size: 9e7, Created: 4 }                    // dangling
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

    // Saved registry credentials are listed
    await w.renderRegistries();
    if (!/ghcr\.io/.test(w.document.getElementById('registry-list').innerHTML))
      errors.push('registries: saved credential not listed');

    // A crash snapshot must surface on the crashed container's Insights card
    await w.refreshCrashLogs();
    w.renderInsights([]);
    const ins2 = w.document.getElementById('insights-list').innerHTML;
    if (!/Crash log/.test(ins2)) errors.push('crash log button missing from the crashed card');
    await w.openCrashLog('sonarr-123.log');
    if (!/out of memory/.test(w.document.getElementById('crashlog-body').textContent))
      errors.push('crash log contents not shown');
    w.document.getElementById('crashlog-cancel-btn').click();

    // Image cleanup sheet: dangling is a SUBSET of unused, so ticking "unused"
    // must account for both, and must never double-count.
    w.openCleanup();
    const box = k => w.document.querySelector(`[data-cl="${k}"]`);
    const total = () => w.document.getElementById('cleanup-total').textContent;
    if (!box('dangling').checked) errors.push('cleanup: dangling not pre-ticked');
    if (box('unused').checked) errors.push('cleanup: unused should not be pre-ticked');
    // dangling only: just the 90 MB untagged layer
    if (!/85\.8 MB across 1 image/.test(total())) errors.push('cleanup: dangling-only total wrong — ' + total().trim());
    // ticking unused must SWALLOW dangling: 2 images (radarr + the untagged one), not 3, no double-count
    box('unused').checked = true; w.updateCleanupTotal();
    if (!/276\.6 MB across 2 images/.test(total())) errors.push('cleanup: unused should include dangling exactly once — ' + total().trim());
    box('dangling').checked = false; box('unused').checked = false; w.updateCleanupTotal();
    if (!w.document.getElementById('cleanup-go-btn').disabled) errors.push('cleanup: Remove enabled with nothing selected');
    w.document.getElementById('cleanup-close-btn').click();

    // Bulk group button pre-ticks the selection in the group modal
    st.selection = new Set([st.containers[0].Id, st.containers[1].Id]);
    w.document.getElementById('bulk-group').click();
    const ticked = [...w.document.querySelectorAll('#group-members [data-gm]')].filter(c => c.checked).map(c => c.dataset.gm);
    if (ticked.join() !== 'plex,sonarr') errors.push('bulk group: selection not pre-ticked — got ' + ticked.join());
    w.document.getElementById('group-cancel-btn').click();

    // Destructive actions must confirm TWICE
    w.__confirms = [];
    await w.runBulkAction([st.containers[0].Id], 'remove', '');
    if (w.__confirms.length !== 2) errors.push('bulk remove asked ' + w.__confirms.length + ' time(s), expected 2');
    if (!/Last chance/.test(w.__confirms[1] || '')) errors.push('bulk remove: second dialog is not the point-of-no-return one');

    w.__confirms = [];
    await w.runBulkAction([st.containers[0].Id], 'restart', '');
    if (w.__confirms.length !== 1) errors.push('restart should ask once, asked ' + w.__confirms.length);

    w.__confirms = [];
    await w.runContainerAction(st.containers[0].Id, 'remove', 'plex');
    if (w.__confirms.length !== 2) errors.push('single remove asked ' + w.__confirms.length + ' time(s), expected 2');

    // Volume delete now uses the type-to-confirm modal, not confirm()
    w.__confirms = [];
    const delPromise = w.removeVolume('orphan');
    await new Promise(r => setTimeout(r, 30));
    if (w.__confirms.length !== 0) errors.push('volume delete should not use a native confirm()');
    if (!w.document.getElementById('destroy-modal').classList.contains('open'))
      errors.push('volume delete did not open the destroy modal');
    const goBtn = w.document.getElementById('destroy-go-btn');
    const phrase = w.document.getElementById('destroy-phrase');
    if (!goBtn.disabled) errors.push('destroy: button enabled before the name was typed');
    phrase.value = 'not-the-name'; phrase.dispatchEvent(new w.Event('input'));
    if (!goBtn.disabled) errors.push('destroy: button enabled on the WRONG name');
    phrase.value = 'orphan'; phrase.dispatchEvent(new w.Event('input'));
    if (goBtn.disabled) errors.push('destroy: button still disabled after typing the exact name');
    goBtn.click();
    await delPromise;
  } catch (e) {
    errors.push('runtime: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n'));
  }
  })();

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
