const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const game = require('./gameLogic');
const countries = require('./countries');
const raceHighscores = require('./raceHighscores');

const PORT = Number(process.env.PORT) || 3031;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HUB_INTERNAL_URL = (
  process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${process.env.HUB_PORT || 3000}`
).replace(/\/$/, '');
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function fetchHubParty(partyId) {
  const id = String(partyId || '').toUpperCase();
  if (!id) return { error: 'partyId fehlt.' };
  if (id === 'LOCALVS' || process.env.ALLOW_LOCAL_VERSUS === '1') {
    return { ok: true, party: { id, local: true, leadId: null } };
  }
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
  if (id === 'LOCALVS') return { ok: true, party: { id, local: true } };
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

/* ── Room manager ─────────────────────────────────────────── */
const ROOM_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const socketToRoom = new Map();

function generateCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Kein freier Room-Code.');
}

function createRoom(hostSocketId) {
  const code = generateCode();
  const room = game.createEmptyRoom(code, hostSocketId);
  rooms.set(code, room);
  socketToRoom.set(hostSocketId, code);
  return room;
}

function getOrCreatePartyRoom(partyId, hostSocketId) {
  const code = String(partyId || '').toUpperCase();
  if (!code) throw new Error('partyId fehlt.');
  let room = rooms.get(code);
  if (!room) {
    room = game.createEmptyRoom(code, hostSocketId);
    room.partyId = code;
    room.solo = false;
    rooms.set(code, room);
  }
  socketToRoom.set(hostSocketId, code);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

function getRoomForSocket(socketId) {
  const code = socketToRoom.get(socketId);
  return code ? getRoom(code) : null;
}

function joinRoom(code, socketId, name) {
  const room = getRoom(code);
  if (!room) return { error: 'Raum nicht gefunden.' };
  const prev = socketToRoom.get(socketId);
  if (prev && prev !== room.code) leaveSocket(socketId, { hard: false });
  const result = game.addPlayer(room, socketId, name);
  if (result.error) return result;
  socketToRoom.set(socketId, room.code);
  return { ok: true, room, player: result.player, reclaimed: !!result.reclaimed };
}

function leaveSocket(socketId, opts = {}) {
  const hard = !!opts.hard;
  const code = socketToRoom.get(socketId);
  socketToRoom.delete(socketId);
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;
  if (hard) {
    const result = game.removePlayer(room, socketId);
    if (result.empty || room.players.length === 0) {
      clearRoomTimers(room);
      rooms.delete(code);
      return { code, empty: true, hard: true };
    }
    return { code, room, empty: false, hard: true, hostLeft: !!result.hostLeft };
  }
  game.softDisconnect(room, socketId);
  return { code, room, empty: false, soft: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      clearRoomTimers(room);
      for (const p of room.players) socketToRoom.delete(p.id);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref?.();

/* ── Timers / broadcast ───────────────────────────────────── */
function clearRoomTimers(room) {
  if (!room._timers) room._timers = {};
  for (const key of Object.keys(room._timers)) {
    clearTimeout(room._timers[key]);
    delete room._timers[key];
  }
}

function broadcastRoom(room) {
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('room:state', game.publicState(room, p.id));
  }
}

function scheduleRoundEnd(room) {
  clearRoomTimers(room);
  if (!room.current || room.phase !== 'playing') return;
  const delay = Math.max(0, room.current.endsAt - Date.now());
  room._timers.end = setTimeout(() => {
    delete room._timers.end;
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'playing') return;
    game.revealRound(room);
    broadcastRoom(room);
    scheduleAfterReveal(room);
  }, delay);
}

function maybeRecordHighscores(room) {
  if (!room || room.phase !== 'finished') return;
  try {
    raceHighscores.recordRaceFinish(room);
  } catch (err) {
    console.warn('[flag-rush] highscore write failed', err.message || err);
  }
}

function scheduleAfterReveal(room) {
  if (room._timers.after) clearTimeout(room._timers.after);
  room._timers.after = setTimeout(() => {
    delete room._timers.after;
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'reveal') return;
    const result = game.advanceAfterReveal(room);
    if (result.finished) maybeRecordHighscores(room);
    broadcastRoom(room);
    if (result.next) scheduleRoundEnd(room);
  }, game.REVEAL_MS);
}

function maybeRevealEarly(room) {
  if (room.phase === 'playing' && game.allGuessesDone(room)) {
    clearRoomTimers(room);
    game.revealRound(room);
    broadcastRoom(room);
    scheduleAfterReveal(room);
  }
}

/* ── HTTP ─────────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    game: 'flag-rush',
    countries: countries.count,
    difficulties: countries.difficulties(),
  });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    ok: true,
    countries: countries.count,
    difficulties: countries.difficulties(),
    race: {
      windowMs: game.RACE_WINDOW_MS,
      maxPoints: game.RACE_MAX_POINTS,
      minPoints: game.RACE_MIN_POINTS,
      firstBonus: game.RACE_FIRST_BONUS,
    },
    roundOptions: game.ROUND_OPTIONS,
  });
});

app.get('/api/suggest', (req, res) => {
  res.json({ ok: true, suggestions: countries.suggestNames(String(req.query.q || '')) });
});

app.get('/api/countries', (req, res) => {
  const difficulty = String(req.query.difficulty || 'hard');
  const pool = countries.poolForDifficulty(difficulty);
  res.json({
    ok: true,
    difficulty,
    count: pool.length,
    countries: pool.map((iso2) => {
      const c = countries.byIso2.get(iso2);
      return { iso2: c.iso2, de: c.de, en: c.en, difficulty: c.difficulty };
    }),
  });
});

app.get('/api/race-highscores', (req, res) => {
  const roundsRaw = req.query.rounds;
  if (roundsRaw == null || roundsRaw === '') {
    return res.json({
      ok: true,
      buckets: raceHighscores.listBuckets(),
      board: raceHighscores.getBoard(10),
    });
  }
  const board = raceHighscores.getBoard(roundsRaw);
  res.json({ ok: true, ...board });
});

/* ── Sockets ──────────────────────────────────────────────── */
io.on('connection', (socket) => {
  socket.on('room:create-solo', (payload = {}, ack) => {
    try {
      if (payload.partyId) {
        if (typeof ack === 'function') ack({ error: 'In einer Party ist Solo gesperrt.' });
        return;
      }
      const room = createRoom(socket.id);
      room.solo = true;
      const join = joinRoom(room.code, socket.id, payload.name || 'Solo');
      if (join.error) {
        leaveSocket(socket.id, { hard: true });
        if (typeof ack === 'function') ack({ error: join.error });
        return;
      }
      if (payload.rounds) game.setRounds(room, socket.id, payload.rounds);
      if (payload.difficulty) game.setDifficulty(room, socket.id, payload.difficulty);
      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: game.publicState(room, socket.id),
          playerId: socket.id,
          solo: true,
        });
      }
      broadcastRoom(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Solo-Start fehlgeschlagen.' });
    }
  });

  socket.on('session:join-party', async (payload = {}, ack) => {
    try {
      const partyId = String(payload.partyId || '').toUpperCase();
      const name = String(payload.name || '').trim();
      const memberId = String(payload.memberId || '').trim();
      if (!partyId) {
        if (typeof ack === 'function') ack({ error: 'partyId nötig.' });
        return;
      }
      if (!name) {
        if (typeof ack === 'function') ack({ error: 'Name nötig.' });
        return;
      }

      const hub = await fetchHubParty(partyId);
      if (hub.error) {
        if (typeof ack === 'function') ack({ error: hub.error });
        return;
      }
      const hubParty = hub.party;
      if (!hubParty) {
        if (typeof ack === 'function') ack({ error: 'Party nicht gefunden.' });
        return;
      }

      const room = getOrCreatePartyRoom(partyId, socket.id);
      room.solo = false;
      room.partyId = partyId;

      const join = joinRoom(room.code, socket.id, name);
      if (join.error) {
        if (typeof ack === 'function') ack({ error: join.error });
        return;
      }

      const player = join.player;
      player.memberId = memberId;

      const isLead = hubParty.leadId && memberId && hubParty.leadId === memberId;
      if (isLead || !room.hostId) {
        room.hostId = socket.id;
        room.hostSocketId = socket.id;
      }

      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: game.publicState(room, socket.id),
          playerId: socket.id,
          isHost: room.hostId === socket.id,
          partyId,
        });
      }
      broadcastRoom(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Party-Join fehlgeschlagen.' });
    }
  });

  socket.on('session:return-to-lobby', async (_payload, ack) => {
    try {
      const room = getRoomForSocket(socket.id);
      if (!room) {
        if (typeof ack === 'function') ack({ error: 'Keine Session.' });
        return;
      }
      const partyId = room.partyId;
      const code = room.code;
      leaveSocket(socket.id, { hard: true });
      if (partyId) {
        await postHubPartyReturn(partyId);
        io.to(code).emit('session:returned', { partyId });
      }
      if (typeof ack === 'function') ack({ ok: true, partyId });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Return fehlgeschlagen.' });
    }
  });

  socket.on('lobby:set-rounds', (payload = {}, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setRounds(room, socket.id, payload.rounds);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: game.publicState(room, socket.id) });
  });

  socket.on('lobby:set-difficulty', (payload = {}, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setDifficulty(room, socket.id, payload.difficulty);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: game.publicState(room, socket.id) });
  });

  socket.on('lobby:ready', (payload = {}, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setReady(room, socket.id, payload.ready !== false);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: game.publicState(room, socket.id) });
  });

  socket.on('game:start', (_payload, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    if (room.hostId !== socket.id) {
      return typeof ack === 'function' && ack({ error: 'Nur der Host startet.' });
    }
    const result = game.beginMatch(room);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    scheduleRoundEnd(room);
    if (typeof ack === 'function') ack({ ok: true, state: game.publicState(room, socket.id) });
  });

  socket.on('game:rematch', (_payload, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    if (room.hostId !== socket.id) {
      return typeof ack === 'function' && ack({ error: 'Nur der Host.' });
    }
    clearRoomTimers(room);
    game.rematch(room);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: game.publicState(room, socket.id) });
  });

  socket.on('round:guess', (payload = {}, ack) => {
    const room = getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.submitGuess(room, socket.id, payload.text || '');
    if (result.error && !result.timedOut) {
      return typeof ack === 'function' && ack(result);
    }
    broadcastRoom(room);
    if (result.allDone || result.timedOut) maybeRevealEarly(room);
    else if (result.correct) maybeRevealEarly(room);
    if (typeof ack === 'function') {
      ack({
        ok: !result.error,
        ...result,
        state: game.publicState(room, socket.id),
      });
    }
  });

  socket.on('clock:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, serverNow: Date.now() });
  });

  socket.on('disconnect', () => {
    const result = leaveSocket(socket.id, { hard: false });
    if (result?.room) {
      broadcastRoom(result.room);
      maybeRevealEarly(result.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Flag Rush on :${PORT} (${countries.count} countries)`);
});
