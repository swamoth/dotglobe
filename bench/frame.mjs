/*
 * Frame-time harness. It serves the repository, drives Chrome, and reads the result that
 * bench/fixture.html reports.
 *
 * Each scenario gets its own browser. ANGLE caches a shader translation for the life of the
 * process, so a second page that uses the same shader links about ten times faster. Sharing one
 * browser would report that cached time as the first frame, which no real visitor ever sees.
 *
 * The CPU throttle stands in for a mid phone. It slows the CPU only. A desktop GPU stays fast,
 * so the GPU column is a lower bound, not a phone measurement. Read the CPU column as the budget.
 */
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';

/*
 * blockedMs is the budget that this library controls and that a visitor feels as a freeze.
 * It is stable across runs, within about 1 ms.
 *
 * firstFrameMs is reported but gated loosely. It is mostly the graphics driver translating and
 * compiling the shader, and the driver keeps its own cache that this harness cannot clear. A
 * fresh browser for each run was not enough: with one warm-up discarded the scenarios became
 * comparable, but the absolute value still belongs to the machine more than to the code. Gate it
 * only wide enough to catch a real regression.
 */
const BUDGET = { frameMs: 4, blockedMs: 20, firstFrameMs: 120, idleFrames: 0 };
const THROTTLE = Number(process.env.BENCH_CPU_THROTTLE ?? 4); // Lighthouse uses 4x for a mid phone
const REPEATS = Number(process.env.BENCH_REPEATS ?? 5); // first frame is noisy, so take a median
const SCENARIOS = [
  { name: 'sphere only', query: '' },
  { name: '10k markers', query: '?markers=10000' },
  { name: '1k arcs', query: '?arcs=1000' },
  { name: '10k markers + 1k arcs', query: '?markers=10000&arcs=1000' },
];

const { server, base } = await serve();

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : NaN; };
const ms = (n) => (Number.isFinite(n) ? `${n.toFixed(2)} ms` : '   n/a');

const launch = () => chromium.launch({
  channel: 'chrome',
  args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'],
});

try {
  await (await launch()).close();
} catch (e) {
  console.error('Cannot start Chrome. Install Google Chrome, or set a channel playwright-core knows.');
  console.error(e.message);
  server.close();
  process.exit(2);
}

async function runOnce(query) {
  const browser = await launch(); // a cold shader cache for each run
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${base}/bench/fixture.html${query}`, { waitUntil: 'load' });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    return await page.waitForFunction('window.__bench', null, { timeout: 60000 }).then((h) => h.jsonValue());
  } finally {
    await browser.close();
  }
}

// Warm the driver once and throw the result away, so no scenario pays for the ones before it.
await runOnce('');

let failed = false;
const rows = [];

for (const s of SCENARIOS) {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) {
    const result = await runOnce(s.query);
    if (result.skipped) {
      console.log(`skip  ${s.name.padEnd(24)} ${result.skipped}`);
      break;
    }
    runs.push(result);
  }
  if (!runs.length) continue;

  const first = median(runs.map((r) => r.firstFrameMs));
  const blocked = median(runs.map((r) => r.split.blocked));
  const cpu = median(runs.flatMap((r) => r.cpu));
  const gpu = median(runs.flatMap((r) => r.gpu));
  const idle = Math.max(...runs.map((r) => r.idleFrames));
  const lit = Math.min(...runs.map((r) => r.lit));
  const firstRange = `${Math.min(...runs.map((r) => r.firstFrameMs)).toFixed(0)} to ${Math.max(...runs.map((r) => r.firstFrameMs)).toFixed(0)} ms`;

  console.log(`      ${s.name}: main thread blocked ${blocked.toFixed(1)} ms, first frame over ${REPEATS} cold runs ${firstRange}.`);

  const over = cpu > BUDGET.frameMs || blocked > BUDGET.blockedMs || first > BUDGET.firstFrameMs
    || idle > BUDGET.idleFrames || lit === 0;
  if (over) failed = true;
  rows.push({ name: s.name, cpu, cpuP95: p95(runs.flatMap((r) => r.cpu)), gpu, blocked, first, idle, lit, over });
}

if (rows.length) {
  console.log(`\nCPU throttle ${THROTTLE}x, median of ${REPEATS} runs, one warm-up discarded.`);
  console.log(`Budget: frame ${BUDGET.frameMs} ms, blocked ${BUDGET.blockedMs} ms, idle ${BUDGET.idleFrames} frames. First frame is reported, and gated loosely at ${BUDGET.firstFrameMs} ms.\n`);
  console.log('scenario                  cpu med   cpu p95   gpu med   blocked     first    idle    lit');
  for (const r of rows) {
    console.log(`${(r.over ? 'FAIL ' : 'ok   ') + r.name.padEnd(20)} ${ms(r.cpu).padStart(9)} ${ms(r.cpuP95).padStart(9)} ${ms(r.gpu).padStart(9)} ${ms(r.blocked).padStart(9)} ${ms(r.first).padStart(9)} ${String(r.idle).padStart(6)} ${String(r.lit).padStart(6)}`);
  }
}

server.close();
process.exit(failed ? 1 : 0);
