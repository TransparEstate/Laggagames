#!/usr/bin/env node
/** Terminal verification for Border Path */
const assert = require('assert');
const http = require('http');
const game = require('../server/gameLogic');

function ok(msg) {
  console.log('✓', msg);
}

// --- Graph / aliases ---
assert.strictEqual(game.resolveName('Deutschland'), 'DE');
assert.strictEqual(game.resolveName('Germany'), 'DE');
assert.strictEqual(game.resolveName('Frankreich'), 'FR');
assert.strictEqual(game.resolveName('United Kingdom'), 'GB');
ok('DE/EN aliases resolve');

const deFr = game.shortestPath('DE', 'FR');
assert.ok(deFr && deFr.length === 2, 'DE borders FR');
ok('DE–FR adjacency');

const deIt = game.shortestPath('DE', 'IT');
assert.ok((deIt && deIt.includes('AT')) || deIt.includes('CH') || deIt.includes('FR'));
ok('DE–IT path exists');

assert.ok(!(game.adjacency.PL || []).includes('RU'), 'PL–RU removed');
assert.ok((game.adjacency.FR || []).includes('GB'), 'FR–GB bridge');
ok('edge exceptions');

// --- Difficulites always have 3 hints ---
for (const d of game.difficulties()) {
  assert.strictEqual(d.hints, 3, `${d.id} should have 3 hints`);
}
ok('all difficulties have 3 hints');

// --- Round + scoring ---
const session = game.getOrCreateSession();
const round = game.newRound(session, 'easy');
assert.strictEqual(round.status, 'playing');
assert.ok(round.hops >= 2 && round.hops <= 3);
assert.ok(round.guessesLeft >= round.hops);
assert.strictEqual(round.hintsLeft, 3);
ok(`easy round ${round.start.nameDe} → ${round.goal.nameDe} (hops ${round.hops})`);

const path = game.shortestPath(round.start.id, round.goal.id);
assert.ok(path && path.length >= 3);
const mid = path[1];
const midName = game.countryLabel(mid, 'de');
const guess = game.applyGuess(session, midName);
assert.ok(guess.ok);
assert.strictEqual(guess.guess.quality, 'green');
assert.strictEqual(guess.guess.frontier, true);
ok(`frontier guess green: ${midName}`);

const bad = game.applyGuess(session, 'Japan');
if (!bad.error) {
  assert.ok(['red', 'orange'].includes(bad.guess.quality));
  ok(`far guess quality=${bad.guess.quality}`);
} else {
  ok('japan skipped');
}

// finish via remaining path
let guard = 0;
while (session.round.status === 'playing' && guard++ < 30) {
  const remPath = game.shortestPath(session.round.start, session.round.goal);
  const guessed = new Set(session.round.guesses.map((g) => g.id));
  const before = game.remainingCost(session.round.start, session.round.goal, guessed);
  let picked = null;
  for (const id of remPath.slice(1, -1)) {
    if (guessed.has(id)) continue;
    const after = game.remainingCost(
      session.round.start,
      session.round.goal,
      new Set([...guessed, id])
    );
    if (after < before) {
      picked = id;
      break;
    }
  }
  if (!picked) {
    for (const id of remPath.slice(1, -1)) {
      if (!guessed.has(id)) {
        picked = id;
        break;
      }
    }
  }
  if (!picked) break;
  game.applyGuess(session, game.countryLabel(picked, 'en'));
}
assert.strictEqual(session.round.status, 'won');
ok('round can be won via path guesses');

// --- Progressive hints ---
const hintSession = game.getOrCreateSession();
const hintRound = game.newRound(hintSession, 'medium');
assert.strictEqual(hintRound.hintsLeft, 3);

const h1 = game.applyHint(hintSession);
assert.ok(h1.ok);
assert.strictEqual(h1.hint.stage, 1);
assert.ok(h1.hint.pattern);
assert.ok(!h1.hint.revealId);
assert.ok(!h1.hint.country);
assert.ok(!h1.hint.nameDe);
assert.notStrictEqual(h1.hint.pattern, game.countryLabel(h1.hint.targetId, 'de'));
assert.deepStrictEqual(h1.state.revealedHintIds, []);
ok(`hint stage 1: ${h1.hint.pattern}`);

const h2 = game.applyHint(hintSession);
assert.ok(h2.ok);
assert.strictEqual(h2.hint.stage, 2);
assert.ok(h2.hint.pattern.startsWith(h2.hint.initial));
assert.ok(h2.hint.pattern.includes('·'));
assert.ok(!h2.hint.revealId);
assert.deepStrictEqual(h2.state.revealedHintIds, []);
ok(`hint stage 2: ${h2.hint.pattern}`);

const h3 = game.applyHint(hintSession);
assert.ok(h3.ok);
assert.strictEqual(h3.hint.stage, 3);
assert.strictEqual(h3.hint.revealId, h3.hint.targetId);
assert.ok(h3.state.revealedHintIds.includes(h3.hint.targetId));
assert.ok(!h3.hint.nameDe);
ok(`hint stage 3 outlines ${h3.hint.targetId}`);

const hintedName = game.countryLabel(h3.hint.targetId, 'de');
const afterHintGuess = game.applyGuess(hintSession, hintedName);
assert.ok(afterHintGuess.ok);
assert.ok(['green', 'orange', 'red'].includes(afterHintGuess.guess.quality));
assert.ok(!afterHintGuess.state.revealedHintIds.includes(h3.hint.targetId));
ok(`guess after hint clears outline (${afterHintGuess.guess.quality})`);

// --- Versus match pool ---
assert.strictEqual(game.VERSUS_MATCH.rounds, 3);
assert.strictEqual(game.VERSUS_MATCH.matchHints, 4);
const puzzle = game.createSharedPuzzle('easy');
const pA = game.createRoundFromPuzzle(puzzle, 'easy', { hintsLeft: 4 });
const pB = game.createRoundFromPuzzle(puzzle, 'easy', { hintsLeft: 4 });
assert.strictEqual(pA.hintsLeft, 4);
for (const id of puzzle.path.slice(1, -1)) {
  game.applyGuessToRound(pA, game.countryLabel(id, 'de'));
  if (pA.status !== 'playing') break;
}
assert.strictEqual(pA.status, 'won');
const hBurn = game.applyHintToRound(pB);
assert.ok(hBurn.ok);
assert.strictEqual(pB.hintsLeft, 3);
ok('versus round can start with match hint pool (4)');

const scoreA = game.scoreVersusPlayer(pA);
assert.ok(scoreA.score >= 100);
const ranked = game.rankVersusPlayers([
  { name: 'A', score: scoreA.score, finishTimeMs: 5000 },
  { name: 'B', score: scoreA.score, finishTimeMs: 3000 },
]);
assert.strictEqual(ranked[0].name, 'B');
ok(`versus score ${scoreA.score}; time tiebreak prefers faster`);

// --- HTTP smoke ---
const { spawn } = require('child_process');
const pathMod = require('path');
const port = 3027;
const child = spawn(process.execPath, [pathMod.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: pathMod.join(__dirname, '..', '..', '..'),
});

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function post(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let boot = '';
  child.stdout.on('data', (c) => {
    boot += c.toString();
  });
  child.stderr.on('data', (c) => {
    boot += c.toString();
  });
  await new Promise((r) => setTimeout(r, 800));
  if (boot && /Error|Cannot find/.test(boot)) {
    throw new Error(`server failed to start:\n${boot}`);
  }
  const health = await get('/health');
  assert.strictEqual(health.status, 200);
  const healthJson = JSON.parse(health.body);
  assert.ok(healthJson.difficulties.every((d) => d.hints === 3));
  ok('GET /health');

  const world = await get('/api/world');
  assert.strictEqual(world.status, 200);
  assert.ok(world.body.includes('FeatureCollection'));
  ok('GET /api/world');

  const roundRes = await post('/api/round', { difficulty: 'medium' });
  assert.strictEqual(roundRes.status, 200);
  const roundJson = JSON.parse(roundRes.body);
  assert.ok(roundJson.state.sessionId);
  assert.strictEqual(roundJson.state.hintsLeft, 3);
  ok('POST /api/round');

  const sid = roundJson.state.sessionId;
  const hintRes = await post('/api/hint', { sessionId: sid });
  assert.strictEqual(hintRes.status, 200);
  const hintJson = JSON.parse(hintRes.body);
  assert.strictEqual(hintJson.hint.stage, 1);
  assert.ok(!hintJson.hint.country);
  assert.ok(!(hintJson.state.revealedHintIds || []).length);
  ok('POST /api/hint stage 1 (no outline, no full name)');

  const suggest = await get('/api/suggest?q=deut');
  assert.strictEqual(suggest.status, 200);
  const sug = JSON.parse(suggest.body);
  assert.ok((sug.suggestions || []).some((s) => s.id === 'DE'));
  ok('GET /api/suggest');

  // Versus socket smoke without Hub: join will fail Hub fetch — unit scoring already covered.
  // Direct room helpers via applyGuessToRound covered above.

  child.kill('SIGTERM');
  console.log('\nAll Border Path checks passed.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  try {
    child.kill('SIGTERM');
  } catch (_) {}
  process.exit(1);
});
