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
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    game: 'border-path',
    meta: game.meta,
    difficulties: game.difficulties(),
  });
});

app.get('/api/meta', (_req, res) => {
  res.json({ ok: true, meta: game.meta, difficulties: game.difficulties() });
});

app.get('/api/world', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', 'geo', 'world.geojson'));
});

app.get('/api/suggest', (req, res) => {
  res.json({ ok: true, suggestions: game.suggestNames(String(req.query.q || '')) });
});

app.post('/api/round', (req, res) => {
  try {
    const difficulty = String(req.body?.difficulty || 'medium');
    const session = game.getOrCreateSession(req.body?.sessionId);
    const state = game.newRound(session, difficulty);
    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Runde fehlgeschlagen.' });
  }
});

app.get('/api/round/:sessionId', (req, res) => {
  const session = game.sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  res.json({ ok: true, state: game.serializeRound(session) });
});

app.post('/api/guess', (req, res) => {
  const session = game.sessions.get(String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  const result = game.applyGuess(session, req.body?.name);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/hint', (req, res) => {
  const session = game.sessions.get(String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  const result = game.applyHint(session);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

/** socketId → { partyId, name, memberId } */
const partyPlayers = new Map();
/** partyId → versus room */
const versusRooms = new Map();

function getVersusRoom(partyId) {
  return versusRooms.get(partyId) || null;
}

function getOrCreateVersusRoom(partyId) {
  let room = versusRooms.get(partyId);
  if (!room) {
    room = {
      partyId,
      status: 'lobby',
      difficulty: 'medium',
      hostSocketId: null,
      puzzle: null,
      players: new Map(),
      startedAt: null,
    };
    versusRooms.set(partyId, room);
  }
  return room;
}

function publicPlayerSummary(socketId, player, selfId) {
  const round = player.round;
  const scored = round ? game.scoreVersusPlayer(round) : { score: 0, finishTimeMs: null };
  const summary = {
    playerId: socketId,
    name: player.name,
    memberId: player.memberId || null,
    isHost: false,
    status: round ? round.status : 'idle',
    remaining: round
      ? round.status === 'playing'
        ? game.remainingCost(
            round.start,
            round.goal,
            new Set(round.guesses.map((g) => g.id))
          )
        : 0
      : null,
    guessesLeft: round ? round.guessesLeft : null,
    guessesUsed: round ? round.guesses.length : 0,
    hintsLeft: round ? round.hintsLeft : null,
    hintsUsed: round ? round.hintsUsed || 0 : 0,
    score: scored.score,
    finishTimeMs: scored.finishTimeMs,
    perfect: round ? !!round.perfect : false,
  };
  if (socketId === selfId && round) {
    summary.state = game.serializeRoundState(round, null);
  }
  return summary;
}

function serializeVersusRoom(room, selfId = null) {
  const players = [];
  for (const [sid, player] of room.players) {
    const summary = publicPlayerSummary(sid, player, selfId);
    summary.isHost = sid === room.hostSocketId;
    players.push(summary);
  }

  let ranking = null;
  if (room.status === 'finished') {
    ranking = game.rankVersusPlayers(
      players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        score: p.score,
        finishTimeMs: p.finishTimeMs,
        status: p.status,
        perfect: p.perfect,
      }))
    );
  }

  const self = selfId ? room.players.get(selfId) : null;
  return {
    partyId: room.partyId,
    status: room.status,
    difficulty: room.difficulty,
    startedAt: room.startedAt,
    hostSocketId: room.hostSocketId,
    puzzle:
      room.puzzle && room.status !== 'lobby'
        ? {
            start: {
              id: room.puzzle.start,
              nameDe: game.countryLabel(room.puzzle.start, 'de'),
              nameEn: game.countryLabel(room.puzzle.start, 'en'),
            },
            goal: {
              id: room.puzzle.goal,
              nameDe: game.countryLabel(room.puzzle.goal, 'de'),
              nameEn: game.countryLabel(room.puzzle.goal, 'en'),
            },
            hops: room.puzzle.hops,
          }
        : null,
    players,
    ranking,
    you: selfId
      ? {
          playerId: selfId,
          isHost: selfId === room.hostSocketId,
          state: self?.round ? game.serializeRoundState(self.round, null) : null,
        }
      : null,
  };
}

function emitVersusState(partyId) {
  const room = getVersusRoom(partyId);
  if (!room) return;
  for (const sid of room.players.keys()) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('versus:state', serializeVersusRoom(room, sid));
  }
}

function refreshRoomFinished(room) {
  if (room.status !== 'playing') return;
  const players = [...room.players.values()];
  if (!players.length) return;
  const allDone = players.every((p) => p.round && p.round.status !== 'playing');
  if (allDone) {
    room.status = 'finished';
  }
}

function ensureHost(room) {
  if (room.hostSocketId && room.players.has(room.hostSocketId)) return;
  const first = room.players.keys().next().value || null;
  room.hostSocketId = first;
}

io.on('connection', (socket) => {
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

      partyPlayers.set(socket.id, { partyId, name, memberId });
      socket.join(`party:${partyId}`);

      const room = getOrCreateVersusRoom(partyId);
      room.players.set(socket.id, {
        name,
        memberId,
        round: room.status === 'playing' && room.puzzle
          ? game.createRoundFromPuzzle(room.puzzle, room.difficulty)
          : null,
      });
      ensureHost(room);
      if (room.status === 'playing') refreshRoomFinished(room);

      const versus = serializeVersusRoom(room, socket.id);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          partyId,
          playerId: socket.id,
          party: hub.party,
          mode: 'versus',
          versus,
        });
      }
      emitVersusState(partyId);
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Join fehlgeschlagen.' });
    }
  });

  socket.on('versus:start', (payload = {}, ack) => {
    try {
      const info = partyPlayers.get(socket.id);
      if (!info?.partyId) {
        if (typeof ack === 'function') ack({ error: 'Keine Party-Session.' });
        return;
      }
      const room = getVersusRoom(info.partyId);
      if (!room) {
        if (typeof ack === 'function') ack({ error: 'Versus-Raum fehlt.' });
        return;
      }
      if (socket.id !== room.hostSocketId) {
        if (typeof ack === 'function') ack({ error: 'Nur der Host startet.' });
        return;
      }
      if (room.players.size < 1) {
        if (typeof ack === 'function') ack({ error: 'Keine Spieler.' });
        return;
      }

      const difficulty = String(payload.difficulty || room.difficulty || 'medium');
      const puzzle = game.createSharedPuzzle(difficulty);
      room.difficulty = puzzle.difficulty;
      room.puzzle = puzzle;
      room.status = 'playing';
      room.startedAt = Date.now();

      for (const player of room.players.values()) {
        player.round = game.createRoundFromPuzzle(puzzle, room.difficulty);
      }

      emitVersusState(info.partyId);
      if (typeof ack === 'function') ack({ ok: true, versus: serializeVersusRoom(room, socket.id) });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Start fehlgeschlagen.' });
    }
  });

  socket.on('versus:guess', (payload = {}, ack) => {
    try {
      const info = partyPlayers.get(socket.id);
      if (!info?.partyId) {
        if (typeof ack === 'function') ack({ error: 'Keine Party-Session.' });
        return;
      }
      const room = getVersusRoom(info.partyId);
      const player = room?.players.get(socket.id);
      if (!room || room.status !== 'playing' || !player?.round) {
        if (typeof ack === 'function') ack({ error: 'Keine laufende Versus-Runde.' });
        return;
      }
      const result = game.applyGuessToRound(player.round, payload.name);
      if (result.error) {
        if (typeof ack === 'function') {
          ack({
            error: result.error,
            code: result.code,
            versus: serializeVersusRoom(room, socket.id),
          });
        }
        return;
      }
      refreshRoomFinished(room);
      emitVersusState(info.partyId);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          guess: result.guess,
          versus: serializeVersusRoom(room, socket.id),
        });
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Tipp fehlgeschlagen.' });
    }
  });

  socket.on('versus:hint', (_payload = {}, ack) => {
    try {
      const info = partyPlayers.get(socket.id);
      if (!info?.partyId) {
        if (typeof ack === 'function') ack({ error: 'Keine Party-Session.' });
        return;
      }
      const room = getVersusRoom(info.partyId);
      const player = room?.players.get(socket.id);
      if (!room || room.status !== 'playing' || !player?.round) {
        if (typeof ack === 'function') ack({ error: 'Keine laufende Versus-Runde.' });
        return;
      }
      const result = game.applyHintToRound(player.round);
      if (result.error) {
        if (typeof ack === 'function') {
          ack({
            error: result.error,
            code: result.code,
            versus: serializeVersusRoom(room, socket.id),
          });
        }
        return;
      }
      emitVersusState(info.partyId);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          hint: result.hint,
          versus: serializeVersusRoom(room, socket.id),
        });
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Hinweis fehlgeschlagen.' });
    }
  });

  socket.on('session:return-to-lobby', async (_payload, ack) => {
    try {
      const info = partyPlayers.get(socket.id);
      if (!info?.partyId) {
        if (typeof ack === 'function') ack({ error: 'Keine Party-Session.' });
        return;
      }
      const { partyId } = info;
      const room = getVersusRoom(partyId);
      if (room) {
        room.players.delete(socket.id);
        ensureHost(room);
        if (!room.players.size) versusRooms.delete(partyId);
        else {
          refreshRoomFinished(room);
          emitVersusState(partyId);
        }
      }
      if (partyId !== 'LOCALVS' && process.env.ALLOW_LOCAL_VERSUS !== '1') {
        await postHubPartyReturn(partyId);
      }
      partyPlayers.delete(socket.id);
      socket.emit('session:returned', { partyId });
      if (typeof ack === 'function') ack({ ok: true, partyId });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Return fehlgeschlagen.' });
    }
  });

  socket.on('disconnect', () => {
    const info = partyPlayers.get(socket.id);
    if (info?.partyId) {
      const room = getVersusRoom(info.partyId);
      if (room) {
        room.players.delete(socket.id);
        ensureHost(room);
        if (!room.players.size) versusRooms.delete(info.partyId);
        else {
          refreshRoomFinished(room);
          emitVersusState(info.partyId);
        }
      }
    }
    partyPlayers.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Border Path on :${PORT}`);
});

module.exports = { versusRooms, serializeVersusRoom };
