#!/usr/bin/env node
// Walk renderPage body in server.cjs, extract every ${...} interpolation
// site, and classify each as bare (server-interpolated) or escaped \${...}
// (browser-side JS template).
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.argv[2] || 'server.cjs');
const START = 2388, END = 8147;

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const sites = []; // {ln, col, expr, kind}

for (let i = 0; i < lines.length; i++) {
  const ln = i + 1;
  if (ln < START || ln > END) continue;
  const txt = lines[i];
  let j = 0;
  while ((j = txt.indexOf('${', j)) !== -1) {
    // Walk forward to find matching }
    let depth = 1, k = j + 2;
    while (k < txt.length && depth > 0) {
      if (txt[k] === '{') depth++;
      else if (txt[k] === '}') depth--;
      k++;
    }
    const expr = txt.slice(j + 2, k - 1);
    const escaped = j > 0 && txt[j - 1] === '\\';
    sites.push({ ln, col: j + 1, expr, kind: escaped ? 'browser' : 'server', context: txt.trim().slice(0, 100) });
    j = k;
  }
}

const server = sites.filter((s) => s.kind === 'server');
const browser = sites.filter((s) => s.kind === 'browser');

console.log(`Total interpolation sites: ${sites.length}`);
console.log(`  server-side (BARE \${...}): ${server.length}  ← M4 Phase 3 targets`);
console.log(`  browser-side (escaped \\\${...}): ${browser.length}  ← non-targets`);
console.log('');
console.log('### Server-side interpolations (ranked by line)\n');
for (const s of server) {
  console.log(`L${s.ln}  \${${s.expr}}`);
  console.log(`        ${s.context}`);
}
