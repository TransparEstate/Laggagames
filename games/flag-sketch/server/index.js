const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./gameLogic');

const PORT = Number(process.env.PORT) || 3020;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HUB_INTERNAL_URL = (
  process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${process.env.HUB_PORT || 3000}`
).replace(/\/$/, '');
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  maxHttpBufferSize: 2e6,
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) =>
  res.json({ ok: true, game: 'flag-sketch', flags: Object.keys(game.flagsData.flags).length })
);

const rooms = new Map();
const socketMeta = new Map();

async function fetchHubParty(partyId) {
  const id = String(partyId || '').toUpperCase();
  if (!id) return { error: 'partyId fehlt.' };
  try {
    const res = await fetch(`${HUB_INTERNAL_URL}/api/party/${encodeURIComponent(id)}`, {
      headers: { 'x-party-token': PARTY_INTERNAL_TOKEN },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `Hub-Party ${res.status}` };
    return { ok: true, party: data.party };
  } catch (err) {
    return { error: err.message || 'Hub nicht erreichbar.' };
  }
}

async function postHubPartyReturn(partyId) {
  const id = String(partyId || '').toUpperCase();
  if (!id) return { error: 'partyId fehlt.' };
  try {
    const res = await fetch(`${HUB_INTERNAL_URL}/api/party/${encodeURIComponent(id)}/return`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-party-token': PARTY_INTERNAL_TOKEN,
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `Hub-Return ${res.status}` };
    return { ok: true, party: data.party };
  } catch (err) {
    return { error: err.message || 'Hub nicht erreichbar.' };
  }
}

function getRoom(id) {
  return rooms.get(id) || null;
}

function ensureHost(room) {
  if (room.hostId && room.players.has(room.hostId)) return;
  const first = [...room.players.keys()][0] || null;
  room.hostId = first;
}

function clearTimer(room, key) {
  if (room.timers?.[key]) {
    clearTimeout(room.timers[key]);
    room.timers[key] = null;
  }
}

function broadcast(room) {
  if (!room) return;
  for (const p of room.players.values()) {
    if (p.connected === false) continue;
    io.to(p.id).emit('state:update', game.getPublicState(room, p.id));
  }
}

function scheduleDrawLock(room) {
  clearTimer(room, 'draw');
  const ms = Math.max(0, (room.drawEndsAt || Date.now()) - Date.now());
  room.timers.draw = setTimeout(() => {
    if (room.phase !== 'drawing') return;
    // Auto-fill blank halves so round can continue
    for (const m of room.mashups) {
      if (!m.leftData) m.leftData = blankHalfDataUrl();
      if (!m.rightData) m.rightData = blankHalfDataUrl();
    }
    lockAndReveal(room);
  }, ms + 50);
}

function blankHalfDataUrl() {
  // 1x1 transparent png
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
}

function lockAndReveal(room) {
  clearTimer(room, 'draw');
  game.composeMashups(room);
  broadcast(room);
  io.to(room.id).emit('sfx', { id: 'reveal' });
  clearTimer(room, 'reveal');
  room.timers.reveal = setTimeout(() => {
    if (room.phase !== 'reveal') return;
    game.enterGuessing(room);
    broadcast(room);
    io.to(room.id).emit('sfx', { id: 'guess' });
  }, 3500);
}

function maybeFinishGuessing(room) {
  if (room.phase !== 'guessing') return;
  if (!game.allGuessesDone(room)) {
    broadcast(room);
    return;
  }
  game.enterVoting(room);
  broadcast(room);
  io.to(room.id).emit('sfx', { id: 'vote' });
}

function maybeFinishVoting(room) {
  if (room.phase !== 'voting') return;
  if (!game.allVotesDone(room)) {
    broadcast(room);
    return;
  }
  game.enterRoundScore(room);
  broadcast(room);
  io.to(room.id).emit('sfx', { id: 'score' });
}

io.on('connection', (socket) => {
  socket.on('session:join', (payload = {}, ack) => {
    try {
      const name = String(payload.name || '').trim() || 'Solo';
      const roomId = `solo-${socket.id.slice(0, 8)}`;
      const room = game.createRoom(roomId, { party: false });
      room.players.set(socket.id, {
        id: socket.id,
        name,
        memberId: null,
        connected: true,
      });
      room.hostId = socket.id;
      rooms.set(roomId, room);
      socket.join(roomId);
      socketMeta.set(socket.id, { roomId });
      game.ensurePlayerScore(room, socket.id);
      if (typeof ack === 'function') {
        ack({ ok: true, roomId, state: game.getPublicState(room, socket.id) });
      }
      broadcast(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Join fehlgeschlagen.' });
    }
  });

  socket.on('session:join-party', async (payload = {}, ack) => {
    try {
      const partyId = String(payload.partyId || '').toUpperCase();
      const name = String(payload.name || '').trim() || 'Spieler';
      const memberId = String(payload.memberId || '').trim();
      if (!partyId) {
        if (typeof ack === 'function') ack({ error: 'partyId nötig.' });
        return;
      }
      const hub =
        partyId === 'LOCALVS' || process.env.ALLOW_LOCAL_VERSUS === '1'
          ? { ok: true, party: { id: partyId, local: true } }
          : await fetchHubParty(partyId);
      if (hub.error) {
        if (typeof ack === 'function') ack({ error: hub.error });
        return;
      }

      let room = getRoom(partyId);
      if (!room) {
        room = game.createRoom(partyId, { party: true });
        rooms.set(partyId, room);
      }
      room.players.set(socket.id, {
        id: socket.id,
        name,
        memberId,
        connected: true,
      });
      ensureHost(room);
      game.ensurePlayerScore(room, socket.id);
      socket.join(partyId);
      socketMeta.set(socket.id, { roomId: partyId, partyId });
      if (typeof ack === 'function') {
        ack({
          ok: true,
          partyId,
          party: hub.party,
          state: game.getPublicState(room, socket.id),
        });
      }
      broadcast(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Party-Join fehlgeschlagen.' });
    }
  });

  socket.on('settings:update', (payload = {}, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    if (socket.id !== room.hostId) return ack?.({ error: 'Nur Host.' });
    if (room.phase !== 'lobby' && room.phase !== 'finished') {
      return ack?.({ error: 'Settings nur in Lobby.' });
    }
    const next = { ...room.settings };
    if (payload.rounds != null) next.rounds = Math.min(7, Math.max(1, Number(payload.rounds) || 3));
    if (payload.drawSeconds != null) {
      next.drawSeconds = Math.min(180, Math.max(20, Number(payload.drawSeconds) || 60));
    }
    if (Array.isArray(payload.hints)) {
      next.hints = payload.hints.filter((h) => game.HINT_KEYS.includes(h));
    }
    room.settings = next;
    ack?.({ ok: true, settings: room.settings });
    broadcast(room);
  });

  socket.on('match:start', (_payload, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    if (socket.id !== room.hostId) return ack?.({ error: 'Nur Host startet.' });
    if (room.players.size < 1) return ack?.({ error: 'Keine Spieler.' });
    clearTimer(room, 'draw');
    clearTimer(room, 'reveal');
    game.startMatch(room);
    scheduleDrawLock(room);
    ack?.({ ok: true });
    broadcast(room);
    io.to(room.id).emit('sfx', { id: 'draw' });
  });

  socket.on('draw:submit', (payload = {}, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    const result = game.submitDrawing(room, socket.id, payload);
    if (result.error) return ack?.(result);
    ack?.(result);
    broadcast(room);
    io.to(socket.id).emit('sfx', { id: 'lock' });
    if (!result.byeContinue && game.allDrawingsIn(room)) {
      lockAndReveal(room);
    }
  });

  socket.on('guess:submit', (payload = {}, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    const result = game.submitGuess(room, socket.id, payload);
    if (result.error) return ack?.(result);
    ack?.(result);
    io.to(socket.id).emit('sfx', { id: result.correct ? 'correct' : 'wrong' });
    maybeFinishGuessing(room);
  });

  socket.on('vote:submit', (payload = {}, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    const result = game.submitVote(room, socket.id, payload);
    if (result.error) return ack?.(result);
    ack?.(result);
    io.to(socket.id).emit('sfx', { id: 'vote' });
    maybeFinishVoting(room);
  });

  socket.on('round:continue', (_payload, ack) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && getRoom(meta.roomId);
    if (!room) return ack?.({ error: 'Kein Raum.' });
    if (socket.id !== room.hostId) return ack?.({ error: 'Nur Host.' });
    if (room.phase !== 'round_score' && room.phase !== 'finished') {
      return ack?.({ error: 'Falsche Phase.' });
    }
    if (room.phase === 'finished') {
      room.phase = 'lobby';
      ack?.({ ok: true });
      broadcast(room);
      return;
    }
    game.advanceAfterScore(room);
    if (room.phase === 'drawing') {
      scheduleDrawLock(room);
      io.to(room.id).emit('sfx', { id: 'draw' });
    }
    ack?.({ ok: true });
    broadcast(room);
  });

  socket.on('session:return-hub', async (_payload, ack) => {
    const meta = socketMeta.get(socket.id);
    if (meta?.partyId) await postHubPartyReturn(meta.partyId);
    ack?.({ ok: true, redirect: '/' });
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = getRoom(meta.roomId);
    socketMeta.delete(socket.id);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.connected = false;
    ensureHost(room);
    if (room.phase === 'guessing') maybeFinishGuessing(room);
    else if (room.phase === 'voting') maybeFinishVoting(room);
    else broadcast(room);

    const anyLive = [...room.players.values()].some((p) => p.connected !== false);
    if (!anyLive) {
      clearTimer(room, 'draw');
      clearTimer(room, 'reveal');
      rooms.delete(room.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`flag-sketch on :${PORT}`);
});
