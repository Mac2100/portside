// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  config: { host: '', port: 2376 },
  containers: [],
  images: [],
  volumes: [],
  networks: [],
  selectedContainer: null,
  statsCache: {},
  refreshTimer: null,
  refreshInterval: 10000,
  showAllContainers: true,
  containerView: 'grid',
  collapsedGroups: {},
  hostInfo: null,
  history: { t: [], cpu: [], mem: [], rx: [], tx: [] },
  prevNet: null,
  prevPerIO: {},
  inspectCache: {},
  inspectFetched: 0,
  prevRunningIds: null,
  lastPer: [],
  df: null,
  dfFetched: 0
};

