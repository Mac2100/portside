// ─── Theme & logo ─────────────────────────────────────────────────────────────
const LOGO_PALETTES = {
  teal:   ['#1d4ed8','#2563eb','#3b82f6','#0284c7','#0ea5e9','#38bdf8','#0d9488','#14b8a6','#2dd4bf'],
  violet: ['#4f46e5','#6366f1','#818cf8','#7c3aed','#8b5cf6','#a78bfa','#9333ea','#a855f7','#c084fc'],
  sunset: ['#dc2626','#ef4444','#f87171','#ea580c','#f97316','#fb923c','#d97706','#f59e0b','#fbbf24'],
  mono:   ['#334155','#475569','#64748b','#526079','#64748b','#94a3b8','#5b6b7f','#7c8aa0','#cbd5e1']
};
const sysThemeMq = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(mode) {
  const effective = mode === 'system' ? (sysThemeMq.matches ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = effective;
  document.querySelectorAll('#theme-picker .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.themeOpt === mode));
}
sysThemeMq.addEventListener('change', () => {
  if ((state.config.theme || 'system') === 'system') applyTheme('system');
});

function applyLogo(variant) {
  const pal = LOGO_PALETTES[variant] || LOGO_PALETTES.teal;
  document.querySelectorAll('#titlebar svg polygon').forEach((poly, i) => {
    if (i < 9) poly.setAttribute('fill', pal[i]);
  });
  api.appx.setDockIcon(variant);
  document.querySelectorAll('#logo-picker .logo-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.logo === variant));
}

function saveCfg(patch) {
  state.config = { ...state.config, ...patch };
  api.config.save(state.config);
}

