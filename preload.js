const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portside', {
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (cfg) => ipcRenderer.invoke('config:save', cfg)
  },
  docker: {
    info:       (args) => ipcRenderer.invoke('docker:info', args),
    containers: (args) => ipcRenderer.invoke('docker:containers', args),
    stats:      (args) => ipcRenderer.invoke('docker:stats', args),
    logs:       (args) => ipcRenderer.invoke('docker:logs', args),
    action:     (args) => ipcRenderer.invoke('docker:action', args),
    images:     (args) => ipcRenderer.invoke('docker:images', args),
    volumes:    (args) => ipcRenderer.invoke('docker:volumes', args),
    networks:   (args) => ipcRenderer.invoke('docker:networks', args),
    df:         (args) => ipcRenderer.invoke('docker:df', args),
    inspect:    (args) => ipcRenderer.invoke('docker:inspect', args),
    pruneImages:(args) => ipcRenderer.invoke('docker:prune-images', args)
  },
  dockBadge: (n) => ipcRenderer.send('dock:badge', n),
  appx: {
    getLoginItem: () => ipcRenderer.invoke('app:get-login-item'),
    setLoginItem: (v) => ipcRenderer.invoke('app:set-login-item', v),
    setDockIcon: (variant) => ipcRenderer.send('app:set-dock-icon', variant)
  },
  certs: {
    info:   (args) => ipcRenderer.invoke('certs:info', args),
    import: (args) => ipcRenderer.invoke('certs:import', args),
    reset:  (args) => ipcRenderer.invoke('certs:reset', args)
  },
  openUrl: (url) => ipcRenderer.send('app:open-url', url),
  appUpdate: {
    version: () => ipcRenderer.invoke('app:version'),
    check:   () => ipcRenderer.invoke('app:check-update')
  },
  events: {
    start:  (args) => ipcRenderer.send('events:start', args),
    list:   (args) => ipcRenderer.invoke('events:list', args),
    onItem: (cb) => ipcRenderer.on('events:item', (_, d) => cb(d))
  },
  tray: {
    update: (data) => ipcRenderer.send('tray:update', data)
  },
  trayPanel: {
    onData:  (cb) => ipcRenderer.on('tray:data', (_, d) => cb(d)),
    action:  (id, action) => ipcRenderer.send('tray:action', { id, action }),
    openApp: () => ipcRenderer.send('tray:open-app'),
    quit:    () => ipcRenderer.send('tray:quit'),
    hide:    () => ipcRenderer.send('tray:hide')
  },
  setTray: (v) => ipcRenderer.invoke('app:set-tray', v),
  updates: {
    check: (args) => ipcRenderer.invoke('updates:check', args),
    apply: (args) => ipcRenderer.invoke('updates:apply', args)
  },
  history: {
    append: (s) => ipcRenderer.send('history:append', s),
    get:    (args) => ipcRenderer.invoke('history:get', args)
  },
  onRefresh: (cb) => ipcRenderer.on('app:refresh', () => cb()),
  onOpenContainer: (cb) => ipcRenderer.on('app:open-container', (_, id) => cb(id)),
  files: {
    list:     (args) => ipcRenderer.invoke('files:list', args),
    download: (args) => ipcRenderer.invoke('files:download', args),
    read:     (args) => ipcRenderer.invoke('files:read', args),
    write:    (args) => ipcRenderer.invoke('files:write', args),
    upload:   (args) => ipcRenderer.invoke('files:upload', args)
  },
  deploy: {
    create: (args) => ipcRenderer.invoke('deploy:create', args)
  },
  logs: {
    start:  (args) => ipcRenderer.invoke('logs:start', args),
    stop:   (args) => ipcRenderer.invoke('logs:stop', args),
    onData: (cb) => ipcRenderer.on('logs:data', (_, d) => cb(d)),
    onEnd:  (cb) => ipcRenderer.on('logs:end', (_, d) => cb(d))
  },
  term: {
    start:  (args) => ipcRenderer.invoke('term:start', args),
    write:  (args) => ipcRenderer.send('term:write', args),
    resize: (args) => ipcRenderer.invoke('term:resize', args),
    kill:   (args) => ipcRenderer.invoke('term:kill', args),
    onData: (cb) => ipcRenderer.on('term:data', (_, d) => cb(d)),
    onExit: (cb) => ipcRenderer.on('term:exit', (_, d) => cb(d))
  }
});
