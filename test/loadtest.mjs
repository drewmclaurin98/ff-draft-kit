#!/usr/bin/env node
/* =====================================================================
   loadtest.mjs — simulated multi-device draft for ff-draft-kit.

   Spins up N iframes of the real app in one Chromium page. All of them talk
   to a shared in-memory fake Firebase (test/fake-firebase.js) that counts
   every byte and delays every message, so we can measure what a real draft
   night actually costs each phone in the room.

   Usage:
     node test/loadtest.mjs                       # test ../index.html
     node test/loadtest.mjs --file /tmp/old.html  # test some other build
     node test/loadtest.mjs --teams 12 --rounds 15 --pool 1400 --latency 40

   Reports: bytes broadcast per pick, total draft traffic, sync latency
   percentiles, and a concurrency check for lost picks.
===================================================================== */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TARGET  = path.resolve(arg('file', path.join(__dirname, '..', 'index.html')));
const TEAMS   = +arg('teams', 12);
const ROUNDS  = +arg('rounds', 15);
const POOL    = +arg('pool', 1400);
const LATENCY = +arg('latency', 40);
const HEADFUL = argv.includes('--headful');

const TOTAL_PICKS = TEAMS * ROUNDS;

/* ---------- build the instrumented device page ---------- */
const src = fs.readFileSync(TARGET, 'utf8');
const hasPoolSplit = src.includes('POOL_KEY');

const STUB = `
<script>
  /* Route the app at the harness's shared fake database. */
  window.firebase = parent.__FF.sdk;
  /* No network in the sandbox: make the Sleeper fetch fail fast so the app
     falls back to its bundled list. The pool under test is seeded separately. */
  window.fetch = () => Promise.reject(new Error('offline test harness'));
  /* Export XLSX as absent so the export button no-ops instead of throwing. */
  window.XLSX = undefined;
  window.__deviceReady = false;
</script>
`;

const deviceHtml = src
  .replace(/<script src="https?:\/\/[^"]+"><\/script>\s*/g, '')
  .replace('<script>', STUB + '<script>');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdraft-loadtest-'));
fs.writeFileSync(path.join(tmp, 'device.html'), deviceHtml);
fs.copyFileSync(path.join(__dirname, 'fake-firebase.js'), path.join(tmp, 'fake-firebase.js'));

/* ---------- seed data ---------- */
const NFL = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
const POSES = ['QB','RB','WR','TE','K','DST'];
const players = Array.from({ length: POOL }, (_, i) => ({
  id: 'p' + i,
  name: `Player ${i} Testcase`,
  pos: POSES[i % POSES.length],
  team: NFL[i % NFL.length],
  rank: i + 1,
  sleeperId: String(1000 + i),
}));
const teams = Array.from({ length: TEAMS }, (_, i) => ({ id: 't' + i, name: 'Team ' + (i + 1), remote: false }));
const queues = {};
teams.forEach((t) => { queues[t.id] = []; });

const seedState = {
  version: 1,
  config: { leagueName: 'Load Test', teams, rounds: ROUNDS, snake: true, tradedPicks: {}, keepers: {} },
  picks: [],
  queues,
  pickStartedAt: Date.now(),
  status: 'drafting',
};
/* The patched build keeps the pool on its own key; the original expects it
   inline. Seed each the way that build would actually have written it. */
const seedStateJson = JSON.stringify(hasPoolSplit ? seedState : { ...seedState, players });
const seedPoolJson = JSON.stringify(players);

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>ff-draft-kit load test</title>
<style>body{margin:0;font:12px system-ui;background:#111;color:#ddd}
#grid{display:grid;grid-template-columns:repeat(${Math.min(4, TEAMS)},1fr);gap:2px}
iframe{width:100%;height:220px;border:1px solid #333;background:#000}</style></head><body>
<script src="fake-firebase.js"></script>
<script>
  window.__FF = makeFakeFirebase({ latencyMs: ${LATENCY}, jitterMs: ${Math.round(LATENCY * 0.35)} });
  window.__FF.seed('ffdraft:state:v1', ${JSON.stringify(seedStateJson)});
  ${hasPoolSplit ? `window.__FF.seed('ffdraft:pool:v1', ${JSON.stringify(seedPoolJson)});` : ''}
</script>
<div id="grid"></div>
<script>
  const N = ${TEAMS};
  for (let i = 0; i < N; i++) {
    const f = document.createElement('iframe');
    f.name = 'device' + i;
    f.src = 'device.html';
    document.getElementById('grid').appendChild(f);
  }
</script>
</body></html>`;
fs.writeFileSync(path.join(tmp, 'harness.html'), harnessHtml);

/* ---------- tiny static server ---------- */
const server = http.createServer((req, res) => {
  const file = path.join(tmp, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'harness.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* ---------- drive ---------- */
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmtKB = (b) => (b / 1024).toFixed(1) + ' KB';

/* Use whatever Chromium is already on the machine rather than downloading one. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);
const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

const browser = await chromium.launch({
  headless: !HEADFUL,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

console.log(`\n  target      ${TARGET}`);
console.log(`  build       ${hasPoolSplit ? 'pool split (patched)' : 'pool inline (original)'}`);
console.log(`  simulating  ${TEAMS} devices · ${ROUNDS} rounds · ${TOTAL_PICKS} picks · ${POOL}-player pool · ${LATENCY}ms link\n`);

await page.goto(`http://127.0.0.1:${PORT}/harness.html`);

const deviceFrames = () => page.frames().filter((f) => f.url().includes('device.html'));
await page.waitForFunction((n) => document.querySelectorAll('iframe').length === n, TEAMS);
await new Promise((r) => setTimeout(r, 1200));

const frames = deviceFrames();
if (frames.length !== TEAMS) throw new Error(`expected ${TEAMS} device frames, got ${frames.length}`);

// wait for every device to boot into the draft view with the pool attached
for (const f of frames) {
  await f.waitForFunction(
    (n) => typeof state !== 'undefined' && state && state.players && state.players.length === n && state.status === 'drafting',
    POOL,
    { timeout: 30000 },
  );
}
console.log('  all devices booted into the draft\n');

// baseline: reset counters so boot traffic doesn't pollute per-pick numbers
const bootStats = await page.evaluate(() => JSON.parse(JSON.stringify(window.__FF.stats)));
await page.evaluate(() => window.__FF.reset());

/* ---- run the draft ---- */
const latencies = [];
const t0 = Date.now();

/* Stop two picks short so the concurrency check below has room to run. */
const DRAFT_UNTIL = TOTAL_PICKS - 2;

for (let n = 0; n < DRAFT_UNTIL; n++) {
  const drafter = frames[n % TEAMS];                     // a different device each pick
  const pid = await drafter.evaluate(() => {
    const taken = takenIds();
    const next = state.players.find((p) => !taken.has(p.id));
    return next ? next.id : null;
  });
  if (!pid) break;

  const target = n + 1;
  const tp = Date.now();
  await drafter.evaluate((id) => draftPlayer(id), pid);
  await Promise.all(
    frames.map((f) =>
      f.waitForFunction((t) => typeof state !== 'undefined' && state.picks.length >= t, target, { timeout: 20000 }),
    ),
  );
  latencies.push(Date.now() - tp);

  if ((n + 1) % 30 === 0) process.stdout.write(`  … ${n + 1}/${DRAFT_UNTIL} picks\n`);
}

const wall = Date.now() - t0;
const stats = await page.evaluate(() => JSON.parse(JSON.stringify(window.__FF.stats)));

/* ---- concurrency check: two devices pick at the same instant ---- */
await page.evaluate(() => window.__FF.reset());
const before = await frames[0].evaluate(() => state.picks.length);
const racePids = await frames[0].evaluate(() => {
  const taken = takenIds();
  const avail = state.players.filter((p) => !taken.has(p.id));
  return [avail[0] && avail[0].id, avail[1] && avail[1].id];
});
let raceResult = 'skipped (draft complete)';
if (racePids[0] && racePids[1]) {
  await Promise.all([
    frames[0].evaluate((id) => draftPlayer(id), racePids[0]),
    frames[1].evaluate((id) => draftPlayer(id), racePids[1]),
  ]).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const after = await frames[0].evaluate(() => state.picks.length);
  const dupes = await frames[0].evaluate(() => {
    const ids = state.picks.map((p) => p.playerId);
    return ids.length - new Set(ids).size;
  });
  const landed = after - before;
  raceResult = `${landed} of 2 simultaneous picks survived` + (dupes ? `, ${dupes} duplicate player(s)!` : '');
  if (landed < 2) raceResult += '  <-- LOST PICK';
}

/* ---- report ---- */
const perPickBroadcast = stats.bytesBroadcast / Math.max(1, latencies.length);
const perDevicePerPick = perPickBroadcast / TEAMS;

console.log('\n  ── results ─────────────────────────────────────────────');
console.log(`  picks completed          ${latencies.length}/${DRAFT_UNTIL}`);
console.log(`  wall clock               ${(wall / 1000).toFixed(1)}s`);
console.log('');
console.log(`  boot traffic (all ${TEAMS})   ${fmtKB(bootStats.bytesBroadcast + bootStats.bytesRead)}`);
console.log(`  total draft traffic      ${fmtKB(stats.bytesBroadcast)}   (broadcast to all devices)`);
console.log(`  per pick, all devices    ${fmtKB(perPickBroadcast)}`);
console.log(`  per pick, per device     ${fmtKB(perDevicePerPick)}   <-- what one phone downloads`);
console.log('');
console.log(`  sync latency  p50        ${pct(latencies, 50)}ms`);
console.log(`                p95        ${pct(latencies, 95)}ms`);
console.log(`                max        ${Math.max(...latencies)}ms`);
console.log('');
console.log(`  transaction retries      ${stats.transactionRetries}`);
console.log(`  aborted writes           ${stats.abortedTransactions}`);
console.log(`  concurrency check        ${raceResult}`);
if (errors.length) {
  console.log(`\n  page errors (${errors.length}):`);
  [...new Set(errors)].slice(0, 5).forEach((e) => console.log('    ' + e.split('\n')[0]));
}
console.log('  ────────────────────────────────────────────────────────\n');

await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
