// ─── Export a container's config (docker run / compose YAML) ─────────────────
// Portside knows every port, env var and mount of a running container. Until now
// it kept that to itself: if a container was removed, or the NAS was rebuilt, the
// config was gone. This hands it back in a form you can re-run anywhere.
//
// Everything is derived from /containers/{id}/json (inspect), not from the list
// API — the list doesn't carry env, restart policy, limits or the full binds.

const EXPORT_SKIP_LABELS = [
  /^com\.docker\.compose\./,   // compose re-adds these itself
  /^org\.opencontainers\./,    // baked into the image, not user config
  /^desktop\.docker\./
];

// Shell-quote only when needed, so the output stays readable
function shq(v) {
  const s = String(v);
  return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function exportBits(ins) {
  const cfg = ins.Config || {};
  const host = ins.HostConfig || {};
  const name = (ins.Name || '').replace(/^\//, '');

  // Ports: { "8080/tcp": [{ HostIp, HostPort }] }
  const ports = [];
  for (const [inner, binds] of Object.entries(host.PortBindings || {}))
    for (const b of (binds || [])) {
      const ip = b.HostIp && b.HostIp !== '0.0.0.0' ? b.HostIp + ':' : '';
      ports.push({ host: `${ip}${b.HostPort}`, inner });
    }

  // Mounts: prefer HostConfig.Binds (source:target:mode), fall back to Mounts
  const binds = (host.Binds && host.Binds.length)
    ? host.Binds.slice()
    : (ins.Mounts || [])
        .filter(m => m.Type === 'bind' || m.Type === 'volume')
        .map(m => `${m.Type === 'volume' ? m.Name : m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`);

  // Env: everything the container runs with. Some of it comes from the image
  // (PATH, LANG…) rather than from you — we can't tell them apart from inspect
  // alone, so we keep them and say so in the header comment.
  const env = (cfg.Env || []).filter(e => !/^(PATH|HOME|HOSTNAME|TERM)=/.test(e));

  const labels = Object.entries(cfg.Labels || {})
    .filter(([k]) => !EXPORT_SKIP_LABELS.some(re => re.test(k)));

  const rp = host.RestartPolicy || {};
  const restart = rp.Name && rp.Name !== 'no'
    ? (rp.Name === 'on-failure' && rp.MaximumRetryCount ? `on-failure:${rp.MaximumRetryCount}` : rp.Name)
    : '';

  const netMode = host.NetworkMode || '';
  const nets = Object.keys((ins.NetworkSettings && ins.NetworkSettings.Networks) || {})
    .filter(n => !['bridge', 'host', 'none'].includes(n));

  return {
    name, image: cfg.Image, ports, binds, env, labels, restart, netMode, nets,
    memory: host.Memory || 0,
    nanoCpus: host.NanoCpus || 0,
    privileged: !!host.Privileged,
    devices: (host.Devices || []).map(d => `${d.PathOnHost}:${d.PathInContainer}${d.CgroupPermissions && d.CgroupPermissions !== 'rwm' ? ':' + d.CgroupPermissions : ''}`),
    capAdd: host.CapAdd || [],
    entrypoint: cfg.Entrypoint || null,
    cmd: cfg.Cmd || null,
    user: cfg.User || '',
    workDir: cfg.WorkingDir || '',
    tty: !!cfg.Tty
  };
}

function toDockerRun(b) {
  const L = ['docker run -d \\'];
  const add = s => L.push('  ' + s + ' \\');

  add(`--name ${shq(b.name)}`);
  if (b.restart) add(`--restart ${b.restart}`);
  if (b.netMode && !['default', 'bridge'].includes(b.netMode)) add(`--network ${shq(b.netMode)}`);
  for (const p of b.ports) {
    const [inner, proto] = p.inner.split('/');           // "1900/udp" → 1900, udp
    add(`-p ${shq(p.host)}:${inner}${proto === 'udp' ? '/udp' : ''}`);
  }
  for (const v of b.binds) add(`-v ${shq(v)}`);
  for (const e of b.env) add(`-e ${shq(e)}`);
  for (const [k, v] of b.labels) add(`--label ${shq(k + '=' + v)}`);
  if (b.memory) add(`--memory ${Math.round(b.memory / 1024 / 1024)}m`);
  if (b.nanoCpus) add(`--cpus ${(b.nanoCpus / 1e9).toFixed(2)}`);
  if (b.privileged) add('--privileged');
  for (const d of b.devices) add(`--device ${shq(d)}`);
  for (const c of b.capAdd) add(`--cap-add ${shq(c)}`);
  if (b.user) add(`--user ${shq(b.user)}`);
  if (b.workDir) add(`--workdir ${shq(b.workDir)}`);
  if (b.tty) add('-t');
  if (b.entrypoint && b.entrypoint.length) add(`--entrypoint ${shq(b.entrypoint[0])}`);

  // last line carries the image (and command) with no trailing backslash
  let last = shq(b.image);
  if (b.cmd && b.cmd.length) last += ' ' + b.cmd.map(shq).join(' ');
  L.push('  ' + last);

  return [
    `# ${b.name} — exported from Portside on ${new Date().toLocaleString()}`,
    `# Env vars include values baked into the image (inspect can't tell them apart).`,
    `# Review before running; bind-mount paths must exist on the target host.`,
    '',
    L.join('\n')
  ].join('\n');
}

function toCompose(b) {
  const y = [];
  const svc = (b.name || 'app').replace(/[^A-Za-z0-9_.-]/g, '-');
  y.push(`# ${b.name} — exported from Portside on ${new Date().toLocaleString()}`);
  y.push(`# Env vars include values baked into the image (inspect can't tell them apart).`);
  y.push('');
  y.push('services:');
  y.push(`  ${svc}:`);
  y.push(`    image: ${b.image}`);
  y.push(`    container_name: ${b.name}`);
  if (b.restart) y.push(`    restart: ${b.restart}`);
  if (b.netMode === 'host') y.push('    network_mode: host');
  if (b.privileged) y.push('    privileged: true');
  if (b.user) y.push(`    user: "${b.user}"`);
  if (b.workDir) y.push(`    working_dir: ${b.workDir}`);
  if (b.ports.length) {
    y.push('    ports:');
    for (const p of b.ports) y.push(`      - "${p.host}:${p.inner.replace('/tcp', '')}"`);
  }
  if (b.binds.length) {
    y.push('    volumes:');
    for (const v of b.binds) y.push(`      - "${v}"`);
  }
  if (b.env.length) {
    y.push('    environment:');
    for (const e of b.env) {
      const i = e.indexOf('=');
      y.push(`      - ${e.slice(0, i)}=${JSON.stringify(e.slice(i + 1)).slice(1, -1)}`);
    }
  }
  if (b.labels.length) {
    y.push('    labels:');
    for (const [k, v] of b.labels) y.push(`      - "${k}=${v}"`);
  }
  if (b.devices.length) {
    y.push('    devices:');
    for (const d of b.devices) y.push(`      - "${d}"`);
  }
  if (b.capAdd.length) {
    y.push('    cap_add:');
    for (const c of b.capAdd) y.push(`      - ${c}`);
  }
  if (b.memory) y.push(`    mem_limit: ${Math.round(b.memory / 1024 / 1024)}m`);
  if (b.nanoCpus) y.push(`    cpus: ${(b.nanoCpus / 1e9).toFixed(2)}`);
  if (b.cmd && b.cmd.length) y.push(`    command: ${JSON.stringify(b.cmd)}`);
  if (b.nets.length) {
    y.push('    networks:');
    for (const n of b.nets) y.push(`      - ${n}`);
    y.push('');
    y.push('networks:');
    for (const n of b.nets) y.push(`  ${n}:\n    external: true`);
  }
  return y.join('\n') + '\n';
}

// ─── Modal ───────────────────────────────────────────────────────────────────
let exportState = { name: '', run: '', yml: '', tab: 'compose' };

async function openExport(id) {
  const r = await api.docker.inspect({ ...state.config, id });
  if (!r.ok) return toast(r.error || 'Inspect failed', 'error');

  const bits = exportBits(r.data);
  exportState = {
    name: bits.name,
    run: toDockerRun(bits),
    yml: toCompose(bits),
    tab: exportState.tab
  };
  $('export-title').textContent = `Export — ${bits.name}`;
  renderExport();
  $('export-modal').classList.add('open');
}

function renderExport() {
  const isYml = exportState.tab === 'compose';
  $('export-body').textContent = isYml ? exportState.yml : exportState.run;
  document.querySelectorAll('#export-tabs .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.etab === exportState.tab));
}

function closeExport() { $('export-modal').classList.remove('open'); }

document.querySelectorAll('#export-tabs .seg-btn').forEach(b =>
  b.addEventListener('click', () => { exportState.tab = b.dataset.etab; renderExport(); }));

$('export-close-btn').addEventListener('click', closeExport);
$('export-cancel-btn').addEventListener('click', closeExport);
$('export-modal').addEventListener('click', (e) => { if (e.target === $('export-modal')) closeExport(); });

$('export-copy-btn').addEventListener('click', async () => {
  const isYml = exportState.tab === 'compose';
  await navigator.clipboard.writeText(isYml ? exportState.yml : exportState.run);
  toast('Copied to clipboard ✓', 'success');
});

$('export-save-btn').addEventListener('click', async () => {
  const isYml = exportState.tab === 'compose';
  const r = await api.exportSave({
    name: isYml ? `${exportState.name}-compose.yml` : `${exportState.name}-docker-run.sh`,
    content: isYml ? exportState.yml : exportState.run
  });
  if (r.canceled) return;
  if (!r.ok) return toast(r.error || 'Save failed', 'error');
  toast(`Saved to ${r.path}`, 'success', 6000);
});
