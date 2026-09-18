// Gate the bundle size. The core is the budget that matters. React is a separate entry.
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { analyzeMetafile } from 'esbuild';
import { bundle } from './build.mjs';

const BUDGET_GZIP = { 'dist/globedots.js': 20 * 1024 };
const kb = (n) => `${(n / 1024).toFixed(2)} kB`;

const results = await bundle({ metafile: true });
let failed = false;

for (const [file, result] of Object.entries(results)) {
  const raw = readFileSync(file);
  const gzip = gzipSync(raw, { level: 9 }).length;
  const brotli = brotliCompressSync(raw).length;
  const budget = BUDGET_GZIP[file];
  const over = budget !== undefined && gzip > budget;
  if (over) failed = true;
  const verdict = budget === undefined ? '' : over
    ? `OVER by ${kb(gzip - budget)} (budget ${kb(budget)})`
    : `${kb(budget - gzip)} left of ${kb(budget)}`;
  console.log(`${file.padEnd(22)} raw ${kb(statSync(file).size).padStart(9)}  gzip ${kb(gzip).padStart(9)}  brotli ${kb(brotli).padStart(9)}  ${verdict}`);
  if (process.argv.includes('--why')) console.log(await analyzeMetafile(result.metafile));
}

process.exit(failed ? 1 : 0);
