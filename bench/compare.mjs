/**
 * Bundle size of the globe layer that NetEye ships today, against dotglobe.
 *
 * Both sides go through the same esbuild settings and the same gzip, so the numbers compare.
 * React is external on both sides, because the app ships React either way.
 *
 * Point it at an app with the old stack installed:
 *   node bench/compare.mjs "C:/path/to/NetEye"
 */
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundle } from './build.mjs';

const appRoot = process.argv[2];
if (!appRoot) {
  console.error('Usage: node bench/compare.mjs <path-to-app-with-the-old-stack>');
  process.exit(2);
}

const kb = (n) => `${(n / 1024).toFixed(2)} kB`;
const SHARED = {
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
};

/** Bundle one bare import from inside the app, and return its gzipped size. */
async function sizeOf(source) {
  const dir = mkdtempSync(join(appRoot, '.sizecheck-'));
  try {
    const entry = join(dir, 'entry.js');
    writeFileSync(entry, source);
    const out = await build({ ...SHARED, entryPoints: [entry], outfile: join(dir, 'out.js') });
    const raw = out.outputFiles[0].contents;
    return { raw: raw.length, gzip: gzipSync(raw, { level: 9 }).length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  ['react-globe.gl', "import G from 'react-globe.gl'; console.log(G);"],
  ['globe.gl', "import G from 'globe.gl'; console.log(G);"],
  ['three-globe', "import G from 'three-globe'; console.log(G);"],
  ['three', "import * as T from 'three'; console.log(T);"],
];

console.log(`Old stack, resolved from ${appRoot}\n`);
const results = [];
for (const [name, source] of cases) {
  try {
    const size = await sizeOf(source);
    results.push([name, size]);
    console.log(`${name.padEnd(18)} raw ${kb(size.raw).padStart(10)}   gzip ${kb(size.gzip).padStart(9)}`);
  } catch (e) {
    console.log(`${name.padEnd(18)} not resolvable: ${e.message.split('\n')[0]}`);
  }
}

await bundle();
const own = readFileSync('dist/dotglobe.js');
const ownGzip = gzipSync(own, { level: 9 }).length;
console.log(`\n${'dotglobe'.padEnd(18)} raw ${kb(own.length).padStart(10)}   gzip ${kb(ownGzip).padStart(9)}`);

const top = results.find(([name]) => name === 'react-globe.gl') ?? results[0];
if (top) {
  const [name, size] = top;
  console.log(`\n${name} is ${(size.gzip / ownGzip).toFixed(1)}x the gzipped size of dotglobe.`);
  console.log(`Replacing it saves ${kb(size.gzip - ownGzip)} gzipped, before any app code changes.`);
}
