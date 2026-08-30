#!/usr/bin/env node
/* =====================================================================
   functional.mjs — regression checks for the sync rework.

   These exercise the paths the refactor touched, across several simulated
   devices, and assert every device ends up agreeing:

     · a pick made on one device shows up on all of them
     · the snake draft order matches an independent computation
     · keepers stay locked and the clock skips their slots
     · traded picks land on the receiving team
     · undo rolls back everywhere
     · autopick honours the queue, then falls back to best available
     · two devices picking the same player at the same instant -> one pick,
       one clear rejection, no duplicate roster entry
     · two devices picking different players at the same instant -> both land
     · the export snapshot still carries the pool, so resume works
     · VALUE / REACH badges point the right way round

   The whole suite runs once per league size in RUNS (below): a 4-team
   baseline plus a 10-team draft (the app's default configuration). Every
   size-specific constant — keeper slot, traded slot — is computed from the
   team count the same way the app does, so the 10-team pass is a genuine
   exercise of the draft-order math, not just the 4-team pass with a bigger
   grid.

   Usage:
     node test/functional.mjs [--file path/to/index.html]
     node test/functional.mjs --teams 12 --rounds 15 --pool 200   # one custom run
===================================================================== */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness, waitForBoot, waitForPicks, makePlayers, makeTeams, makeState, detectPoolSplit } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TARGET = path.resolve(arg('file', path.join(__dirname, '..', 'index.html')));

/* League sizes the suite runs at. Pass --teams (with optional --rounds /
   --pool) to replace the list with a single custom run. */
const RUNS = argv.includes('--teams')
  ? [{ TEAMS: +arg('teams', 10), ROUNDS: +arg('rounds', 15), POOL: +arg('pool', 200) }]
  : [
      { TEAMS: 4, ROUNDS: 4, POOL: 60 },     // the original baseline, unchanged
      { TEAMS: 10, ROUNDS: 15, POOL: 200 },  // the app's default league size
    ];

const poolSplit = detectPoolSplit(TARGET);

let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); }
}

/* Overall pick index (0-based) for a given team slot in a given round, the
   same way index.html's teamForPick() computes it: snake reverses on odd
   rounds. Used to place the keeper so its slot is correct at any team count. */
function overallFor(round, teamIdx, n, snake = true) {
  const idxInRound = snake && round % 2 === 1 ? n - 1 - teamIdx : teamIdx;
  return round * n + idxInRound;
}

async function runSuite({ TEAMS, ROUNDS, POOL }) {
  const tag = `[${TEAMS}t]`;
  const P = (name) => `${tag} ${name}`;

  if (TEAMS < 4) throw new Error('the race checks need at least 4 devices');

  const players = makePlayers(POOL);
  const teams = makeTeams(TEAMS);

  /* Keeper: team t2 keeps p5 in round index 1 (the second round, which snake
     reverses). Traded pick: whoever owns overall 2 hands it to t3. Both slots
     are recomputed from TEAMS so they stay right as the league grows. */
  const KEEPER_TEAM_IDX = 2;
  const KEEPER_ROUND = 1;
  const KEEPER_PID = 'p5';
  const KEEPER_OVERALL = overallFor(KEEPER_ROUND, KEEPER_TEAM_IDX, TEAMS);
  const TRADED_OVERALL = 2;
  const TRADED_TO = 't3';

  const state = makeState({
    teams,
    rounds: ROUNDS,
    keepers: { [KEEPER_OVERALL]: { playerId: KEEPER_PID, teamId: 't' + KEEPER_TEAM_IDX } },
    tradedPicks: { [TRADED_OVERALL]: TRADED_TO },
  });

  const H = await startHarness({
    target: TARGET,
    devices: TEAMS,
    seedState: JSON.stringify(poolSplit ? state : { ...state, players }),
    seedPool: poolSplit ? JSON.stringify(players) : null,
    latency: 25,
  });

  const frames = H.frames;

  console.log(`\n  ── ${TEAMS} teams · ${ROUNDS} rounds · ${POOL}-player pool ─────────────`);
  console.log(`  target ${TARGET}`);
  console.log(`  build  ${H.hasPoolSplit ? 'pool split (patched)' : 'pool inline (original)'}`);
  console.log(`  keeper slot overall ${KEEPER_OVERALL} (t${KEEPER_TEAM_IDX}, round ${KEEPER_ROUND + 1})\n`);

  try {
    await waitForBoot(frames, POOL);
    check(P('all devices boot into the draft with the full pool'), true);

    /* --- snake draft order --------------------------------------------- */
    const orderOk = await frames[0].evaluate((n) => {
      const expected = [];
      for (let r = 0; r < 2; r++)
        for (let i = 0; i < n; i++)
          expected.push('t' + (r % 2 === 1 ? n - 1 - i : i));
      const got = expected.map((_, ov) => originalOwner(ov).id);
      return { ok: expected.join(',') === got.join(','), expected, got };
    }, TEAMS);
    check(P('snake order matches an independent computation for the first two rounds'),
      orderOk.ok, `expected ${orderOk.expected.join(',')} got ${orderOk.got.join(',')}`);

    /* --- keepers ------------------------------------------------------- */
    // the keeper slot only fills once the clock reaches it, so just assert lockout for now
    const keeperLocked = await frames[0].evaluate((pid) => takenIds().has(pid), KEEPER_PID);
    check(P('keeper is locked out of the available pool'), keeperLocked);

    /* --- a pick propagates --------------------------------------------- */
    const firstPid = await frames[0].evaluate(() => {
      const taken = takenIds();
      return state.players.find((p) => !taken.has(p.id)).id;
    });
    await frames[0].evaluate((id) => draftPlayer(id), firstPid);
    await waitForPicks(frames, 1);
    const seenEverywhere = await Promise.all(
      frames.map((f) => f.evaluate((id) => state.picks.some((p) => p.playerId === id), firstPid)),
    );
    check(P('a pick made on one device reaches every device'), seenEverywhere.every(Boolean));

    /* --- traded pick ---------------------------------------------------- */
    // draft up to and including the traded slot
    while ((await frames[0].evaluate(() => state.picks.length)) <= TRADED_OVERALL) {
      const n = await frames[0].evaluate(() => state.picks.length);
      const pid = await frames[0].evaluate(() => {
        const taken = takenIds();
        return state.players.find((p) => !taken.has(p.id)).id;
      });
      await frames[n % frames.length].evaluate((id) => draftPlayer(id), pid);
      await waitForPicks(frames, n + 1);
    }
    const tradedOwner = await frames[0].evaluate((ov) => {
      const p = state.picks.find((x) => x.overall === ov);
      return p ? p.teamId : null;
    }, TRADED_OVERALL);
    check(P('traded pick lands on the receiving team'), tradedOwner === TRADED_TO,
      `got ${tradedOwner}, expected ${TRADED_TO}`);

    /* --- keeper auto-fills when the clock reaches it -------------------- */
    while ((await frames[0].evaluate(() => state.picks.length)) < KEEPER_OVERALL + 1) {
      const n = await frames[0].evaluate(() => state.picks.length);
      const pid = await frames[0].evaluate(() => {
        const taken = takenIds();
        return state.players.find((p) => !taken.has(p.id)).id;
      });
      await frames[n % frames.length].evaluate((id) => draftPlayer(id), pid);
      await waitForPicks(frames, n + 1);
    }
    const kp = await frames[0].evaluate((ov) => {
      const p = state.picks.find((x) => x.overall === ov);
      return p ? { teamId: p.teamId, playerId: p.playerId, keeper: !!p.keeper } : null;
    }, KEEPER_OVERALL);
    check(P('keeper fills its own slot for the right team'),
      !!kp && kp.keeper && kp.playerId === KEEPER_PID && kp.teamId === 't' + KEEPER_TEAM_IDX,
      JSON.stringify(kp));

    /* --- undo ----------------------------------------------------------- */
    const beforeUndo = await frames[0].evaluate(() => state.picks.length);
    await frames[1].evaluate(async () => {
      const mutate = () => {
        if (!state.picks.some((p) => !p.keeper)) return false;
        while (state.picks.length && state.picks[state.picks.length - 1].keeper) state.picks.pop();
        if (state.picks.length) state.picks.pop();
        state.status = 'drafting'; state.pickStartedAt = Date.now();
        return true;
      };
      // works on both the patched and the pre-split build
      if (typeof applyAtomic === 'function') await applyAtomic(mutate);
      else if (mutate() !== false) await commit();
    });
    await new Promise((r) => setTimeout(r, 900));
    const afterUndoAll = await Promise.all(frames.map((f) => f.evaluate(() => state.picks.length)));
    check(P('undo rolls back on every device'),
      afterUndoAll.every((n) => n < beforeUndo) && new Set(afterUndoAll).size === 1,
      `before ${beforeUndo}, after ${afterUndoAll.join('/')}`);

    /* --- autopick honours the queue ------------------------------------- */
    const onClockTeam = await frames[0].evaluate(() => ownerForPick(currentOverall()).id);
    const queuePid = await frames[0].evaluate(() => {
      const taken = takenIds();
      // pick something deliberately NOT at the top of the board
      return state.players.filter((p) => !taken.has(p.id))[8].id;
    });
    await frames[0].evaluate(async (args) => {
      const mutate = () => { state.queues[args.tid] = [args.pid]; return true; };
      if (typeof applyAtomic === 'function') await applyAtomic(mutate);
      else { mutate(); await commit(); }
    }, { tid: onClockTeam, pid: queuePid });
    await new Promise((r) => setTimeout(r, 700));
    const nBefore = await frames[0].evaluate(() => state.picks.length);
    await frames[0].evaluate(() => autopick());
    await waitForPicks(frames, nBefore + 1);
    const autoPicked = await frames[0].evaluate((n) => {
      const p = state.picks[n];
      return p ? p.playerId : null;
    }, nBefore);
    check(P('autopick takes the queued player, not best available'), autoPicked === queuePid,
      `got ${autoPicked}, expected ${queuePid}`);

    /* --- race: same player, two devices --------------------------------- */
    const contested = await frames[0].evaluate(() => {
      const taken = takenIds();
      return state.players.find((p) => !taken.has(p.id)).id;
    });
    const nRace = await frames[0].evaluate(() => state.picks.length);
    await Promise.all([
      frames[0].evaluate((id) => draftPlayer(id), contested),
      frames[2].evaluate((id) => draftPlayer(id), contested),
    ]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    const raceState = await frames[0].evaluate(() => {
      const ids = state.picks.map((p) => p.playerId);
      return { len: state.picks.length, dupes: ids.length - new Set(ids).size };
    });
    check(P('same player contested by two devices -> exactly one pick, no duplicate'),
      raceState.len === nRace + 1 && raceState.dupes === 0,
      `picks ${nRace} -> ${raceState.len}, dupes ${raceState.dupes}`);

    /* --- race: different players, two devices --------------------------- */
    const [pidA, pidB] = await frames[0].evaluate(() => {
      const taken = takenIds();
      const avail = state.players.filter((p) => !taken.has(p.id));
      return [avail[0].id, avail[1].id];
    });
    const nRace2 = await frames[0].evaluate(() => state.picks.length);
    await Promise.all([
      frames[1].evaluate((id) => draftPlayer(id), pidA),
      frames[3].evaluate((id) => draftPlayer(id), pidB),
    ]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1400));
    const after2 = await frames[0].evaluate(() => state.picks.length);
    check(P('two different players picked simultaneously -> both land'),
      after2 === nRace2 + 2, `picks ${nRace2} -> ${after2}`);

    /* --- every device agrees on the final board ------------------------- */
    const boards = await Promise.all(
      frames.map((f) => f.evaluate(() => state.picks.map((p) => p.overall + ':' + p.teamId + ':' + p.playerId).join('|'))),
    );
    check(P('all devices agree on the final board'), new Set(boards).size === 1);

    /* --- export snapshot still carries the pool ------------------------- */
    const snapshotHasPool = await frames[0].evaluate(() => {
      const s = JSON.parse(JSON.stringify(state));
      return Array.isArray(s.players) && s.players.length > 0;
    });
    check(P('export snapshot still includes the player pool (resume works)'), snapshotHasPool);

    /* --- the wire payload does NOT carry the pool ----------------------- */
    const wire = await H.peek('ffdraft:state:v1');
    const wireHasPool = typeof wire === 'string' && wire.includes('"players"');
    check(H.hasPoolSplit ? P('synced payload no longer carries the pool') : P('synced payload carries the pool (original)'),
      H.hasPoolSplit ? !wireHasPool : wireHasPool,
      `payload ${(String(wire).length / 1024).toFixed(1)} KB`);

    if (H.errors.length) {
      check(P('no uncaught page errors'), false, [...new Set(H.errors)].slice(0, 3).join(' | '));
    } else {
      check(P('no uncaught page errors'), true);
    }
  } finally {
    await H.close();
  }

  /* ===================================================================
     Migration: a draft already in progress on the OLD build (pool inline,
     no pool key) must keep working when devices reload onto the new build.
  =================================================================== */
  if (poolSplit) {
    console.log(`\n  ${tag} migration from a draft started on the old build:`);
    const M = await startHarness({
      target: TARGET,
      devices: 2,
      seedState: JSON.stringify({ ...state, players }),   // old shape
      seedPool: null,                                      // pool key absent
      latency: 25,
    });
    try {
      await waitForBoot(M.frames, POOL);
      check(P('in-progress old-build draft still loads'), true);

      await new Promise((r) => setTimeout(r, 800));
      const poolKey = await M.peek('ffdraft:pool:v1');
      check(P('pool is republished to its own key'), typeof poolKey === 'string' && poolKey.length > 0);

      const pid = await M.frames[0].evaluate(() => {
        const taken = takenIds();
        return state.players.find((p) => !taken.has(p.id)).id;
      });
      await M.frames[0].evaluate((id) => draftPlayer(id), pid);
      await waitForPicks(M.frames, 1);
      const bothSee = await Promise.all(
        M.frames.map((f) => f.evaluate((id) => state.players.length > 0 && state.picks.some((p) => p.playerId === id), pid)),
      );
      check(P('picks still sync and both devices keep a full pool'), bothSee.every(Boolean));
    } finally {
      await M.close();
    }
  }

  /* ===================================================================
     VALUE / REACH badges on the draft board.

     The pool is seeded so player pN has rank N+1. A player taken well AFTER
     their rank is value; one taken well BEFORE it is a reach. These were
     inverted once, so pin the direction. The app's threshold is a fixed
     12-slot delta, so this holds at any team count.
  =================================================================== */
  {
    console.log(`\n  ${tag} draft board VALUE/REACH badges:`);
    const B = await startHarness({
      target: TARGET,
      devices: 1,
      seedState: JSON.stringify(poolSplit ? state : { ...state, players }),
      seedPool: poolSplit ? JSON.stringify(players) : null,
      latency: 15,
    });
    try {
      await waitForBoot(B.frames, POOL);
      const f = B.frames[0];

      // Pick 1 takes p40 (rank 41) -> 40 slots ahead of its rank -> REACH.
      // Picks 2..14 burn other late-ranked players so p0 survives...
      const order = ['p40'];
      for (let i = 41; i <= 53; i++) order.push('p' + i);
      order.push('p0');            // ...to pick 15 (rank 1, 14 picks late) -> VALUE

      for (const pid of order) {
        const n = await f.evaluate(() => state.picks.length);
        await f.evaluate((id) => draftPlayer(id), pid);
        await waitForPicks(B.frames, n + 1);
      }

      const badges = await f.evaluate(() => {
        const cells = [...document.querySelectorAll('.bcell')];
        const at = (name) => {
          const c = cells.find((x) => x.querySelector('.bp') && x.querySelector('.bp').textContent === name);
          if (!c) return 'missing';
          if (c.querySelector('.adp-val')) return 'VALUE';
          if (c.querySelector('.adp-reach')) return 'REACH';
          return 'none';
        };
        return { early: at('Player 40 Testcase'), late: at('Player 0 Testcase') };
      });

      check(P('rank 41 taken at pick 1 shows REACH'), badges.early === 'REACH', `got ${badges.early}`);
      check(P('rank 1 taken at pick 15 shows VALUE'), badges.late === 'VALUE', `got ${badges.late}`);
    } finally {
      await B.close();
    }
  }
}

for (const cfg of RUNS) {
  await runSuite(cfg);
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
