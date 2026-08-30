/* =====================================================================
   harness.mjs — shared plumbing for the ff-draft-kit browser tests.

   Builds an offline, instrumented copy of index.html, serves it, and opens
   N iframes of it in one Chromium page against a shared fake Firebase.
   Both loadtest.mjs and functional.mjs sit on top of this.
===================================================================== */

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const NFL = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];
export const POSES = ['QB','RB','WR','TE','K','DST'];

export function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i,
    name: `Player ${i} Testcase`,
    pos: POSES[i % POSES.length],
    team: NFL[i % NFL.length],
    rank: i + 1,
    sleeperId: String(1000 + i),
  }));
}

export function makeTeams(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 't' + i, name: 'Team ' + (i + 1), remote: false }));
}

export function makeState({ teams, rounds, tradedPicks = {}, keepers = {} }) {
  const queues = {};
  teams.forEach((t) => { queues[t.id] = []; });
  return {
    version: 1,
    config: { leagueName: 'Test League', teams, rounds, snake: true, tradedPicks, keepers },
    picks: [],
    queues,
    pickStartedAt: Date.now(),
    status: 'drafting',
  };
}

/* Does this build keep the player pool on its own key? */
export function detectPoolSplit(target) {
  return fs.readFileSync(target, 'utf8').includes('POOL_KEY');
}

const STUB = `
<script>
  window.firebase = parent.__FF.sdk;
  window.fetch = () => Promise.reject(new Error('offline test harness'));
  window.XLSX = undefined;
</script>
`;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

/* Returns { page, frames, browser, stats(), reset(), peek(key), close() } */
export async function startHarness({
  target,
  devices,
  seedState,
  seedPool,
  latency = 40,
  headful = false,
  onPageError,
}) {
  const src = fs.readFileSync(target, 'utf8');
  const hasPoolSplit = src.includes('POOL_KEY');

  const deviceHtml = src
    .replace(/<script src="https?:\/\/[^"]+"><\/script>\s*/g, '')
    .replace('<script>', STUB + '<script>');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdraft-test-'));
  fs.writeFileSync(path.join(tmp, 'device.html'), deviceHtml);
  fs.copyFileSync(path.join(__dirname, 'fake-firebase.js'), path.join(tmp, 'fake-firebase.js'));

  const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>ff-draft-kit test</title>
<style>body{margin:0;font:12px system-ui;background:#111;color:#ddd}
#grid{display:grid;grid-template-columns:repeat(${Math.min(4, devices)},1fr);gap:2px}
iframe{width:100%;height:220px;border:1px solid #333;background:#000}</style></head><body>
<script src="fake-firebase.js"></script>
<script>
  window.__FF = makeFakeFirebase({ latencyMs: ${latency}, jitterMs: ${Math.round(latency * 0.35)} });
  window.__FF.seed('ffdraft:state:v1', ${JSON.stringify(seedState)});
  ${hasPoolSplit && seedPool ? `window.__FF.seed('ffdraft:pool:v1', ${JSON.stringify(seedPool)});` : ''}
</script>
<div id="grid"></div>
<script>
  for (let i = 0; i < ${devices}; i++) {
    const f = document.createElement('iframe');
    f.name = 'device' + i;
    f.src = 'device.html';
    document.getElementById('grid').appendChild(f);
  }
</script>
</body></html>`;
  fs.writeFileSync(path.join(tmp, 'harness.html'), harnessHtml);

  const server = http.createServer((req, res) => {
    const file = path.join(tmp, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'harness.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const executablePath = findChrome();
  const browser = await chromium.launch({
    headless: !headful,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e)); if (onPageError) onPageError(e); });

  await page.goto(`http://127.0.0.1:${port}/harness.html`);
  await page.waitForFunction((n) => document.querySelectorAll('iframe').length === n, devices);
  await new Promise((r) => setTimeout(r, 1000));

  const frames = page.frames().filter((f) => f.url().includes('device.html'));
  if (frames.length !== devices) throw new Error(`expected ${devices} device frames, got ${frames.length}`);

  return {
    hasPoolSplit,
    browser,
    page,
    frames,
    errors,
    stats: () => page.evaluate(() => JSON.parse(JSON.stringify(window.__FF.stats))),
    reset: () => page.evaluate(() => window.__FF.reset()),
    peek: (key) => page.evaluate((k) => window.__FF.peek(k), key),
    async close() {
      await browser.close();
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/* Wait for every device to be sitting in the draft view with a full pool. */
export async function waitForBoot(frames, poolSize, timeout = 30000) {
  for (const f of frames) {
    await f.waitForFunction(
      (n) => typeof state !== 'undefined' && state && state.players && state.players.length === n && (state.status === 'drafting' || state.status === 'done'),
      poolSize,
      { timeout },
    );
  }
}

/* Wait until every device agrees the board has at least `n` picks. */
export async function waitForPicks(frames, n, timeout = 20000) {
  await Promise.all(
    frames.map((f) => f.waitForFunction((t) => typeof state !== 'undefined' && state.picks.length >= t, n, { timeout })),
  );
}
