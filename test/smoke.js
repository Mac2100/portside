#!/usr/bin/env node
/**
 * Portside smoke test — no dependencies, runs in plain node.
 *
 *   npm test
 *
 * It cannot click buttons, but it catches the three things that actually break
 * this app when you edit it:
 *
 *   1. a syntax error in any renderer script                (app boots to a white window)
 *   2. $('some-id') pointing at an element that doesn't exist (silent null crash on click)
 *   3. a js/ file that isn't loaded by index.html, or loaded out of order
 *
 * Exit code 0 = clean, 1 = problems (printed).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const jsDir = path.join(root, 'js');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();

const problems = [];
const ok = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const bad = m => { problems.push(m); console.log('  \x1b[31m✗\x1b[0m ' + m); };

// ── 1. Every renderer script parses ──────────────────────────────────────────
console.log('\nSyntax');
const sources = {};
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  sources[f] = src;
  try {
    new vm.Script(src, { filename: f });
    ok(f);
  } catch (e) {
    bad(`${f}: ${e.message}`);
  }
}

// ── 2. index.html loads every js file, in filename order ─────────────────────
console.log('\nScript loading');
const loaded = [...html.matchAll(/<script src="js\/([^"]+)"><\/script>/g)].map(m => m[1]);
const missing = jsFiles.filter(f => !loaded.includes(f));
const orphan = loaded.filter(f => !jsFiles.includes(f));
if (missing.length) bad('js/ files not loaded by index.html: ' + missing.join(', '));
if (orphan.length) bad('index.html loads files that do not exist: ' + orphan.join(', '));
if (loaded.join() !== [...loaded].sort().join())
  bad('script tags are out of order — load order defines the dependency order');
if (!missing.length && !orphan.length) ok(`${loaded.length} scripts loaded in order`);

// ── 3. Every $('id') resolves to an element that exists somewhere ────────────
// "Somewhere" = index.html, or markup that the renderer itself injects
// (Insights cards, container grid, modals built from template literals).
console.log('\nElement IDs');
const declared = new Set();
const collectIds = text => {
  for (const m of text.matchAll(/\bid\s*=\s*["']([\w-]+)["']/g)) declared.add(m[1]);
  for (const m of text.matchAll(/\bid\s*=\s*\\?["']([\w-]+)\\?["']/g)) declared.add(m[1]);
  // id="${...}" — dynamic, can't verify; ignore
};
collectIds(html);
for (const f of jsFiles) collectIds(sources[f]);

const referenced = new Map(); // id -> file
for (const f of jsFiles) {
  for (const m of sources[f].matchAll(/\$\(\s*'([\w-]+)'\s*\)/g))
    if (!referenced.has(m[1])) referenced.set(m[1], f);
  for (const m of sources[f].matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g))
    if (!referenced.has(m[1])) referenced.set(m[1], f);
}

let danglingIds = 0;
for (const [id, f] of referenced) {
  if (!declared.has(id)) { bad(`${f} references #${id} — no such element`); danglingIds++; }
}
if (!danglingIds) ok(`${referenced.size} element references all resolve`);

// ── Result ───────────────────────────────────────────────────────────────────
console.log('');
if (problems.length) {
  console.log(`\x1b[31m${problems.length} problem${problems.length > 1 ? 's' : ''}\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mAll checks passed\x1b[0m\n');
