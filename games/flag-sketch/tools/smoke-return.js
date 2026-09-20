#!/usr/bin/env node
/**
 * Verifies leave → Hub return clears in_game (the redirect loop bug).
 * Spawns a tiny hub mock + flag-sketch, joins LOCALVS-style party, calls return-to-lobby.
 */
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const HUB_PORT = 3190;
const GAME_PORT = 3191;
const TOKEN = 'dev-party-token';

let partyStatus = 'in_game';
let returnHits = 0;

const hub = express();
hub.use(express.json());
hub.get('/api/party/:id', (req, res) => {
  if (req.headers['x-party-token'] !== TOKEN) return res.status(401).json({ error: 'token' });
  res.json({
    ok: true,
    party: {
      id: req.params.id.toUpperCase(),
      leadId: 'lead-1',
      status: partyStatus,
      currentGame: partyStatus === 'in_game' ? 'flag-sketch' : null,
      members: [{ id: 'lead-1', name: 'Lead', isLead: true }],
    },
  });
});
hub.post('/api/party/:id/return', (req, res) => {
  if (req.headers['x-party-token'] !== TOKEN) return res.status(401).json({ error: 'token' });
  returnHits += 1;
  partyStatus = 'lobby';
  res.json({
    ok: true,
    party: {
      id: req.params.id.toUpperCase(),
      leadId: 'lead-1',
      status: 'lobby',
      currentGame: null,
      members: [{ id: 'lead-1', name: 'Lead', isLead: true }],
    },
  });
});
const hubServer = hub.listen(HUB_PORT);

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(port, ms = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      const body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      if (body.ok) return body;
    } catch (_) {
      /* retry */
    }
    if (Date.now() - start > ms) throw new Error('health timeout ' + port);
    await wait(100);
  }
}

async function main() {
  // Ensure client lib for this smoke only
  try {
    require.resolve('socket.io-client');
  } catch {
    console.log('installing socket.io-client for smoke…');
    await new Promise((resolve, reject) => {
      const c = spawn('npm', ['install', 'socket.io-client@4', '--no-save'], {
        cwd: path.join(__dirname, '..', '..', '..'),
        stdio: 'inherit',
      });
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
    });
  }
  const { io } = require('socket.io-client');

  const game = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      HUB_INTERNAL_URL: `http://127.0.0.1:${HUB_PORT}`,
      PARTY_INTERNAL_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  game.stdout.on('data', (d) => (logs += d));
  game.stderr.on('data', (d) => (logs += d));

  try {
    await waitHealth(GAME_PORT);
    const socket = io(`http://127.0.0.1:${GAME_PORT}`, { transports: ['websocket'] });
    await new Promise((res, rej) => {
      socket.on('connect', res);
      socket.on('connect_error', rej);
      setTimeout(() => rej(new Error('connect timeout')), 5000);
    });

    const joinAck = await new Promise((res) => {
      socket.emit(
        'session:join-party',
        { partyId: 'ABCD12', name: 'Lead', memberId: 'lead-1' },
        res
      );
    });
    if (!joinAck?.ok) throw new Error('join failed ' + JSON.stringify(joinAck));
    if (!joinAck.state?.isHost) throw new Error('lead should be host');

    let returned = false;
    socket.on('session:returned', () => {
      returned = true;
    });

    const retAck = await new Promise((res) => {
      socket.emit('session:return-to-lobby', {}, res);
    });
    if (!retAck?.ok) throw new Error('return ack failed ' + JSON.stringify(retAck));
    await wait(200);
    if (!returned) throw new Error('session:returned not emitted');
    if (returnHits < 1) throw new Error('hub /return not called');
    if (partyStatus !== 'lobby') throw new Error('party still in_game');

    console.log('RETURN SMOKE OK', { returnHits, partyStatus });
    socket.close();
  } finally {
    game.kill('SIGTERM');
    hubServer.close();
  }
}

main().catch((err) => {
  console.error('RETURN SMOKE FAIL', err);
  process.exit(1);
});
