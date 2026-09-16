/*
 * Frame-time harness. It serves the repository, drives Chrome, and reads the result that
 * bench/fixture.html reports.
 *
 * The CPU throttle stands in for a mid phone. It slows the CPU only. A desktop GPU stays fast,
 * so the GPU column is a lower bound, not a phone measurement. Read the CPU column as the budget.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const BUDGET = { frameMs: 4, firstFrameMs: 50, idleFrames: 0 };
const THROTTLE = Number(process.env.BENCH_CPU_THROTTLE ?? 4); // Lighthouse uses 4x for a mid phone
const SCENARIOS = [
  { name: 'sphere only', query: '' },
  { name: '10k markers', query: '?markers=10000' },
  { name: '1k arcs', query: '?arcs=1000' },
  { name: '10k markers + 1k arcs', query: '?markers=10000&arcs=1000' },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0]));
  const path = join(process.cwd(), rel);
  if (!path.startsWith(process.cwd())) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : NaN; };
const ms = (n) => (Number.isFinite(n) ? `${n.toFixed(2)} ms` : '   n/a');

let browser;
try {
  browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
} catch (e) {
  console.error('Cannot start Chrome. Install Google Chrome, or set a channel playwright-core knows.');
  console.error(e.message);
  server.close();
  process.exit(2);
}

const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
const cdp = await page.context().newCDPSession(page);
let failed = false;
const rows = [];

for (const s of SCENARIOS) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.goto(`${base}/bench/fixture.html${s.query}`, { waitUntil: 'load' });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const result = await page.waitForFunction('window.__bench', null, { timeout: 60000 }).then((h) => h.jsonValue());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  if (result.skipped) {
    console.log(`skip  ${s.name.padEnd(24)} ${result.skipped}`);
    continue;
  }
  const cpu = median(result.cpu);
  const over = cpu > BUDGET.frameMs || result.firstFrameMs > BUDGET.firstFrameMs || result.idleFrames > BUDGET.idleFrames || result.lit === 0;
  if (over) failed = true;
  rows.push({ name: s.name, cpu, cpuP95: p95(result.cpu), gpu: median(result.gpu), first: result.firstFrameMs, idle: result.idleFrames, lit: result.lit, over });
}

if (rows.length) {
  console.log(`\nCPU throttle ${THROTTLE}x. Budget: frame ${BUDGET.frameMs} ms, first frame ${BUDGET.firstFrameMs} ms, idle ${BUDGET.idleFrames} frames.\n`);
  console.log('scenario                  cpu med   cpu p95   gpu med   first     idle    lit');
  for (const r of rows) {
    console.log(`${(r.over ? 'FAIL ' : 'ok   ') + r.name.padEnd(20)} ${ms(r.cpu).padStart(9)} ${ms(r.cpuP95).padStart(9)} ${ms(r.gpu).padStart(9)} ${ms(r.first).padStart(9)} ${String(r.idle).padStart(6)} ${String(r.lit).padStart(6)}`);
  }
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
