/**
 * Terminal checks for mj-headle UX / syncReveal / async stages.
 * Run: node games/mj-headle/tools/ux-smoke-test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const root = path.join(__dirname, '..');
const game = require(path.join(root, 'server', 'gameLogic'));

const songs = [
  { id: 's1', title: 'Billie Jean', artist: 'Michael Jackson', cueStartSec: 1, hasAudio: true },
  { id: 's2', title: 'Beat It', artist: 'Michael Jackson', cueStartSec: 0, hasAudio: true },
  { id: 's3', title: 'Thriller', artist: 'Michael Jackson', cueStartSec: 2, hasAudio: true },
];

function roomWithTwo() {
  const room = game.createEmptyRoom('TEST01', 'host');
  game.addPlayer(room, 'host', 'Host');
  game.addPlayer(room, 'guest', 'Guest');
  return room;
}

function section(title) {
  console.log(`\n== ${title}`);
}

section('async skip: stages independent');
{
  const room = roomWithTwo();
  const start = game.startMatch(room, songs);
  assert.ok(start.ok, start.error);
  assert.strictEqual(room.phase, 'playing');

  const skipHost = game.skipStage(room, 'host');
  assert.ok(skipHost.ok, skipHost.error);
  assert.strictEqual(skipHost.stageIndex, 1);

  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.strictEqual(stHost.current.stageIndex, 1, 'host advanced');
  assert.strictEqual(stGuest.current.stageIndex, 0, 'guest still at 0');
  assert.strictEqual(stHost.current.stageSeconds, 0.5);
  assert.strictEqual(stGuest.current.stageSeconds, 0.1);
  console.log('ok: host stage 1, guest stage 0');
}

section('wrong guess only advances own stage');
{
  const room = roomWithTwo();
  game.startMatch(room, songs);
  const bad = game.submitGuess(room, 'guest', 'Definitely Wrong Title XYZ');
  assert.ok(bad.ok && bad.correct === false);
  assert.strictEqual(bad.stageIndex, 1);
  assert.strictEqual(game.publicState(room, 'host').current.stageIndex, 0);
  assert.strictEqual(game.publicState(room, 'guest').current.stageIndex, 1);
  console.log('ok: wrong guess only guest');
}

section('syncReveal ON: no early personal reveal');
{
  const room = roomWithTwo();
  room.settings.syncReveal = true;
  game.startMatch(room, songs);
  const title = room.current.title;
  const ok = game.submitGuess(room, 'host', title);
  assert.ok(ok.correct);
  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.strictEqual(stHost.current.revealedForMe, false);
  assert.strictEqual(stHost.current.title, null);
  assert.strictEqual(stGuest.current.title, null);
  assert.strictEqual(room.phase, 'playing');
  console.log('ok: host waits, answer hidden');
}

section('syncReveal OFF: early personal reveal + shared when all done');
{
  const room = roomWithTwo();
  const set = game.setSyncReveal(room, 'host', false);
  assert.ok(set.ok);
  assert.strictEqual(set.syncReveal, false);
  game.startMatch(room, songs);
  const title = room.current.title;
  const ok = game.submitGuess(room, 'host', title);
  assert.ok(ok.correct);
  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.strictEqual(stHost.current.revealedForMe, true);
  assert.strictEqual(stHost.current.title, title);
  assert.strictEqual(stGuest.current.revealedForMe, false);
  assert.strictEqual(stGuest.current.title, null);
  assert.strictEqual(room.phase, 'playing', 'still playing until guest done');

  // guest gives up via skips
  while (!room.current.guesses.guest?.done) {
    const r = game.skipStage(room, 'guest');
    assert.ok(r.ok || r.error);
    if (r.error) break;
  }
  assert.ok(room.current.guesses.guest.done);
  assert.strictEqual(room.phase, 'reveal');
  assert.strictEqual(room.current.revealed, true);
  assert.strictEqual(game.publicState(room, 'guest').current.title, title);
  console.log('ok: early reveal for host, shared reveal after guest');
}

section('setSyncReveal host-only / lobby-only');
{
  const room = roomWithTwo();
  assert.ok(game.setSyncReveal(room, 'guest', false).error);
  game.startMatch(room, songs);
  assert.ok(game.setSyncReveal(room, 'host', false).error);
  console.log('ok: guarded');
}

section('static UI markers');
{
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(!html.includes('id="btnReady"'), 'btnReady removed');
  assert.ok(html.includes('id="syncRevealToggle"'));
  assert.ok(html.includes('Skippen'));
  assert.ok(html.includes('id="btnRevealPlay"'));
  assert.ok(!js.includes('.slice(0, 12)'));
  assert.ok(css.includes('min(50vh, 420px)'));
  console.log('ok: html/js/css markers');
}

section('live catalog length via game server');
(async () => {
  const PORT = 3017;
  process.env.PORT = String(PORT);
  // Requiring index starts listen — spawn instead.
  const { spawn } = require('child_process');
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (d) => {
    boot += d.toString();
  });
  child.stderr.on('data', (d) => {
    boot += d.toString();
  });

  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${PORT}/api/songs`, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
          });
          req.on('error', reject);
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('server did not start\n' + boot);
  };

  try {
    await waitUp();
    const data = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${PORT}/api/songs`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });
    const n = (data.songs || []).length;
    assert.ok(n > 12, `expected >12 songs, got ${n}`);
    console.log(`ok: catalog ${n} songs, playable=${data.playableCount}`);

    // Socket multiplayer via socket.io-client from root node_modules
    let ioClient;
    try {
      ioClient = require('socket.io-client');
    } catch {
      ioClient = require('/workspace/node_modules/socket.io-client');
    }

    const connect = (name) =>
      new Promise((resolve, reject) => {
        const s = ioClient(`http://127.0.0.1:${PORT}`, {
          transports: ['websocket'],
          forceNew: true,
        });
        const t = setTimeout(() => reject(new Error('connect timeout ' + name)), 5000);
        s.on('connect', () => {
          clearTimeout(t);
          resolve(s);
        });
        s.on('connect_error', reject);
      });

    const emit = (s, event, payload = {}) =>
      new Promise((resolve) => s.emit(event, payload, (res) => resolve(res || {})));

    // Solo create + second player can't join without party — use gameLogic for 2p already.
    // Still verify lobby:set-sync-reveal over socket for solo host.
    const a = await connect('a');
    const solo = await emit(a, 'room:create-solo', { name: 'A', rounds: 3 });
    assert.ok(solo.ok, solo.error);
    assert.strictEqual(solo.state.settings.syncReveal, true);
    const toggled = await emit(a, 'lobby:set-sync-reveal', { syncReveal: false });
    assert.ok(toggled.ok, toggled.error);
    assert.strictEqual(toggled.syncReveal, false);
    assert.strictEqual(toggled.state.settings.syncReveal, false);
    console.log('ok: socket lobby:set-sync-reveal');
    a.close();

    console.log('\nALL CHECKS PASSED');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error('\nFAILED', err);
  process.exit(1);
});
