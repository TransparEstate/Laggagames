/**
 * Versus rematch + win-announce socket smoke (local party, no Hub).
 * Run: ALLOW_LOCAL_VERSUS=1 node games/border-path/tools/rematch-smoke.js
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const PORT = 3031;
const partyId = 'LOCALVS';

function waitHealth(port, ms = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get({ hostname: '127.0.0.1', port, path: '/health' }, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else if (Date.now() - start > ms) reject(new Error('health timeout'));
          else setTimeout(tick, 200);
        })
        .on('error', () => {
          if (Date.now() - start > ms) reject(new Error('health timeout'));
          else setTimeout(tick, 200);
        });
    };
    tick();
  });
}

(async () => {
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ALLOW_LOCAL_VERSUS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(root, '..', '..'),
  });
  let boot = '';
  child.stdout.on('data', (d) => {
    boot += d.toString();
  });
  child.stderr.on('data', (d) => {
    boot += d.toString();
  });

  try {
    await waitHealth(PORT);
    const { io } = require(path.join(root, '..', '..', 'node_modules', 'socket.io-client'));

    const connect = (name) =>
      new Promise((resolve, reject) => {
        const s = io(`http://127.0.0.1:${PORT}`, {
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

    const host = await connect('host');
    const guest = await connect('guest');

    const joinH = await emit(host, 'session:join-party', {
      partyId,
      name: 'Host',
      memberId: 'm-host',
    });
    assert.ok(joinH.ok, joinH.error);
    assert.strictEqual(joinH.versus.status, 'lobby');
    assert.ok(joinH.versus.you.isHost);

    const joinG = await emit(guest, 'session:join-party', {
      partyId,
      name: 'Alex',
      memberId: 'm-alex',
    });
    assert.ok(joinG.ok, joinG.error);

    const started = await emit(host, 'versus:start', { difficulty: 'easy' });
    assert.ok(started.ok, started.error);
    assert.strictEqual(started.versus.status, 'playing');

    // Force finished via rematch path: finish by calling rematch after marking finished
    // Simulate end by rematch from finished — first rematch from playing should fail? Only host rematch anytime.
    // Set finished by completing isn't easy without guesses; call rematch after manually using server map.
    // Instead: rematch is allowed from any status for host — then lobby.
    let guestRematch = null;
    guest.once('party:rematch', (payload) => {
      guestRematch = payload;
    });

    const rematch = await emit(host, 'versus:rematch', {});
    assert.ok(rematch.ok, rematch.error);
    assert.strictEqual(rematch.versus.status, 'lobby');
    assert.strictEqual(rematch.versus.winner, null);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(guestRematch, 'guest received party:rematch');
    console.log('ok: versus:rematch → lobby for host+guest');

    let guestWin = null;
    guest.once('party:win-announce', (payload) => {
      guestWin = payload;
    });
    const announce = await emit(host, 'party:win-announce', {
      name: 'Host',
      perfect: true,
      guessesUsed: 2,
    });
    assert.ok(announce.ok, announce.error);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(guestWin);
    assert.strictEqual(guestWin.name, 'Host');
    assert.strictEqual(guestWin.perfect, true);
    console.log('ok: party:win-announce broadcast');

    host.close();
    guest.close();
    console.log('\nrematch-smoke: all ok');
  } catch (err) {
    console.error(boot);
    console.error(err);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
  }
})();
