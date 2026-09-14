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
assert.ok(deIt && deIt.includes('AT') || deIt.includes('CH') || deIt.includes('FR'));
ok('DE–IT path exists');

assert.ok(!(game.adjacency.PL || []).includes('RU'), 'PL–RU removed');
assert.ok((game.adjacency.FR || []).includes('GB'), 'FR–GB bridge');
ok('edge exceptions');

// --- Round + scoring ---
const session = game.getOrCreateSession();
const round = game.newRound(session, 'easy');
assert.strictEqual(round.status, 'playing');
assert.ok(round.hops >= 2 && round.hops <= 3);
assert.ok(round.guessesLeft >= round.hops);
assert.ok(round.hintsLeft >= 0);
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
  // already guessed somehow
  ok('japan skipped');
}

// finish via remaining path
let guard = 0;
while (session.round.status === 'playing' && guard++ < 30) {
  const remPath = game.shortestPath(session.round.start, session.round.goal);
  const guessed = new Set(session.round.guesses.map((g) => g.id));
  // pick any neighbor of start-component that reduces cost
  const before = game.remainingCost(
    session.round.start,
    session.round.goal,
    guessed
  );
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

// --- HTTP smoke ---
const { spawn } = require('child_process');
const pathMod = require('path');
const port = 3027;
const child = spawn(process.execPath, [pathMod.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
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
  await new Promise((r) => setTimeout(r, 400));
  const health = await get('/health');
  assert.strictEqual(health.status, 200);
  ok('GET /health');

  const world = await get('/api/world');
  assert.strictEqual(world.status, 200);
  assert.ok(world.body.includes('FeatureCollection'));
  ok('GET /api/world');

  const roundRes = await post('/api/round', { difficulty: 'medium' });
  assert.strictEqual(roundRes.status, 200);
  const roundJson = JSON.parse(roundRes.body);
  assert.ok(roundJson.state.sessionId);
  ok('POST /api/round');

  const suggest = await get('/api/suggest?q=deut');
  assert.strictEqual(suggest.status, 200);
  const sug = JSON.parse(suggest.body);
  assert.ok((sug.suggestions || []).some((s) => s.id === 'DE'));
  ok('GET /api/suggest');

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
