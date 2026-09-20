#!/usr/bin/env node
/**
 * Terminal checks for Flag Rush.
 * 1) In-process gameLogic (no extra deps)
 * 2) HTTP + Socket race against a spawned server (needs socket.io-client)
 */
const path = require('path');
const { spawn } = require('child_process');
const game = require('../server/gameLogic');
const countries = require('../server/countries');

const PORT = Number(process.env.FLAG_RUSH_TEST_PORT) || 3091;
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function testLogic() {
  assert(countries.count >= 200, `country count ${countries.count}`);
  assert(countries.resolveGuess('Deutschland')?.iso2 === 'DE', 'resolve DE');
  assert(countries.resolveGuess('germany')?.iso2 === 'DE', 'resolve germany');
  assert(countries.resolveGuess('USA')?.iso2 === 'US', 'resolve USA');
  assert(!countries.resolveGuess('Atlantis'), 'reject atlantis');

  const easy = countries.poolForDifficulty('easy');
  const hard = countries.poolForDifficulty('hard');
  assert(easy.length >= 40, 'easy pool');
  assert(hard.length >= easy.length, 'hard >= easy');

  const room = game.createEmptyRoom('TEST01', 's1');
  room.solo = true;
  game.addPlayer(room, 's1', 'Solo');
  game.setRounds(room, 's1', 5);
  game.setDifficulty(room, 's1', 'easy');
  const started = game.beginMatch(room);
  assert(started.ok, 'beginMatch');
  assert(room.phase === 'playing', 'playing');
  assert(room.current?.iso2, 'has flag');

  const iso2 = room.current.iso2;
  const name = countries.byIso2.get(iso2).de;
  const miss = game.submitGuess(room, 's1', 'Atlantis');
  assert(miss.ok && miss.correct === false, 'miss');
  const hit = game.submitGuess(room, 's1', name);
  assert(hit.ok && hit.correct && hit.firstBonus, 'hit+bonus');
  assert(hit.guess.points >= 100, 'points');

  game.revealRound(room);
  assert(room.phase === 'reveal', 'reveal');
  const pub = game.publicState(room, 's1');
  assert(pub.current.de === name, 'reveal name');
  assert(pub.current.flagUrl.includes(room.current.iso.toLowerCase()), 'flag url');

  console.log('OK gameLogic', countries.count, 'countries');
}

async function waitHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error('Health-Check Timeout');
}

function onceAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: ${event}`)), 5000);
    socket.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

async function testServer() {
  let ioClient;
  try {
    ioClient = require('socket.io-client');
  } catch {
    console.log('SKIP socket suite (socket.io-client nicht installiert)');
    // HTTP-only against spawned server still useful
  }

  const entry = path.join(__dirname, '..', 'server', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ALLOW_LOCAL_VERSUS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });

  try {
    const health = await waitHealth();
    assert(health.ok && health.game === 'flag-rush', 'health');
    assert(health.countries > 100, 'countries');
    console.log('OK health', health.countries);

    const meta = await (await fetch(`${BASE}/api/meta`)).json();
    assert(meta.ok && meta.race?.firstBonus, 'meta');
    const sug = await (await fetch(`${BASE}/api/suggest?q=deut`)).json();
    assert((sug.suggestions || []).some((s) => s.iso2 === 'DE'), 'suggest');
    console.log('OK http api');

    if (!ioClient) return;

    const { io } = ioClient;
    const a = io(BASE, { transports: ['websocket'] });
    const b = io(BASE, { transports: ['websocket'] });
    await Promise.all([
      new Promise((res, rej) => {
        a.on('connect', res);
        a.on('connect_error', rej);
      }),
      new Promise((res, rej) => {
        b.on('connect', res);
        b.on('connect_error', rej);
      }),
    ]);

    const joinA = await onceAck(a, 'session:join-party', {
      partyId: 'LOCALVS',
      name: 'Alice',
      memberId: 'lead',
    });
    const joinB = await onceAck(b, 'session:join-party', {
      partyId: 'LOCALVS',
      name: 'Bob',
      memberId: 'm2',
    });
    assert(joinA?.ok && joinB?.ok, 'party join');
    assert(joinA.isHost === true, 'alice host');

    await onceAck(b, 'lobby:ready', { ready: true });
    await onceAck(a, 'lobby:set-rounds', { rounds: 5 });
    await onceAck(a, 'lobby:set-difficulty', { difficulty: 'easy' });
    const start = await onceAck(a, 'game:start', {});
    assert(start?.ok && start.state?.phase === 'playing', 'start');
    assert(!start.state.current.de, 'no leak');

    const iso2 = start.state.current.iso2;
    const pool = await (await fetch(`${BASE}/api/countries?difficulty=easy`)).json();
    const country = (pool.countries || []).find((c) => c.iso2 === iso2);
    assert(country, 'pool country');

    const wrong = await onceAck(a, 'round:guess', { text: 'Atlantis' });
    assert(!wrong.correct, 'wrong');
    const rightA = await onceAck(a, 'round:guess', { text: country.de });
    assert(rightA.correct && rightA.firstBonus, 'alice first');
    const rightB = await onceAck(b, 'round:guess', { text: country.en });
    assert(rightB.correct && !rightB.firstBonus, 'bob second');
    console.log('OK party race socket');

    a.close();
    b.close();

    const s = io(BASE, { transports: ['websocket'] });
    await new Promise((res, rej) => {
      s.on('connect', res);
      s.on('connect_error', rej);
    });
    const solo = await onceAck(s, 'room:create-solo', {
      name: 'Solo',
      rounds: 5,
      difficulty: 'easy',
    });
    assert(solo?.ok, 'solo create');
    const soloStart = await onceAck(s, 'game:start', {});
    assert(soloStart?.ok, 'solo start');
    const soloIso = soloStart.state.current.iso2;
    const soloCountry = (pool.countries || []).find((c) => c.iso2 === soloIso);
    const soloGuess = await onceAck(s, 'round:guess', { text: soloCountry.de });
    assert(soloGuess.correct, 'solo guess');
    console.log('OK solo socket');
    s.close();
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    if (logs && process.env.FLAG_RUSH_DEBUG) console.log(logs.slice(-500));
  }
}

async function main() {
  testLogic();
  await testServer();
  console.log('ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('TEST ERROR', err);
  process.exitCode = 1;
});
