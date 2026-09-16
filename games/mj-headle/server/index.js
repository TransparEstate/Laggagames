const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { Server } = require('socket.io');

const RoomManager = require('./roomManager');
const game = require('./gameLogic');
const catalog = require('./catalog');
const cueDetect = require('./cueDetect');
const r2 = require('./r2');

const PORT = Number(process.env.PORT) || 3010;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HUB_INTERNAL_URL = (
  process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${process.env.HUB_PORT || 3000}`
).replace(/\/$/, '');
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });
const rooms = new RoomManager();

app.use(express.json({ limit: '1mb' }));
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

function broadcastRoom(room) {
  if (!room) return;
  for (const player of room.players) {
    if (player.connected === false) continue;
    io.to(player.id).emit('state:update', rooms.getPublicState(room, player.id));
  }
}

function clearRaceTimers(room) {
  if (!room) return;
  if (room._raceArmTimer) {
    clearTimeout(room._raceArmTimer);
    room._raceArmTimer = null;
  }
  if (room._raceEndTimer) {
    clearTimeout(room._raceEndTimer);
    room._raceEndTimer = null;
  }
}

function scheduleRaceEnd(room) {
  if (!room?.current?.endsAt) return;
  if (room._raceEndTimer) {
    clearTimeout(room._raceEndTimer);
    room._raceEndTimer = null;
  }
  const delay = Math.max(0, room.current.endsAt - Date.now() + 40);
  room._raceEndTimer = setTimeout(() => {
    room._raceEndTimer = null;
    const result = game.endRaceWindow(room);
    if (result.ok) broadcastRoom(room);
  }, delay);
}

function fireRaceGo(room) {
  if (!game.raceOn(room) || !room.current || room.current.goFired) return;
  if (room._raceArmTimer) {
    clearTimeout(room._raceArmTimer);
    room._raceArmTimer = null;
  }
  const result = game.applyRaceGo(room);
  if (result.error) return;
  io.to(room.code).emit('race:go', {
    songId: room.current.songId,
    playAt: result.playAt,
    endsAt: result.endsAt,
    serverNow: result.serverNow,
    windowMs: game.RACE_WINDOW_MS,
    clipSec: game.RACE_CLIP_SEC,
    leadMs: game.RACE_GO_LEAD_MS,
  });
  broadcastRoom(room);
  scheduleRaceEnd(room);
}

function armRaceRound(room) {
  if (!game.raceOn(room) || !room.current) return;
  clearRaceTimers(room);
  room.current.armed = new Set();
  room.current.goFired = false;
  room.current.playAt = null;
  room.current.endsAt = null;
  const serverNow = Date.now();
  io.to(room.code).emit('race:arm', {
    songId: room.current.songId,
    clipSec: game.RACE_CLIP_SEC,
    serverNow,
    cueStartSec: room.current.cueStartSec,
  });
  room._raceArmTimer = setTimeout(() => {
    room._raceArmTimer = null;
    fireRaceGo(room);
  }, game.RACE_ARM_TIMEOUT_MS);
  broadcastRoom(room);
}

async function warmClipsForSong(song, { race = false } = {}) {
  if (!song) return;
  const durs = race ? [game.RACE_CLIP_SEC] : game.CLIP_STAGES || [];
  await Promise.all(
    durs.map(async (dur) => {
      try {
        await catalog.resolveClip(song, dur);
      } catch (err) {
        console.warn('[mj-headle] clip warm failed', song.id, dur, err.message || err);
      }
    })
  );
}

app.get('/health', async (_req, res) => {
  const ping = await r2.ping();
  res.json({
    ok: true,
    game: 'mj-headle',
    r2: { ...r2.status(), ping },
    stages: game.CLIP_STAGES,
    points: game.STAGE_POINTS,
    race: {
      windowMs: game.RACE_WINDOW_MS,
      clipSec: game.RACE_CLIP_SEC,
      maxPoints: game.RACE_MAX_POINTS,
      minPoints: game.RACE_MIN_POINTS,
      firstBonus: game.RACE_FIRST_BONUS,
    },
  });
});

app.get('/api/songs', async (_req, res) => {
  try {
    const songs = await catalog.listPublicSongs();
    const ping = await r2.ping();
    const meta = catalog.catalogMeta();
    res.json({
      songs,
      playableCount: songs.filter((s) => s.playable).length,
      stages: game.CLIP_STAGES,
      points: game.STAGE_POINTS,
      race: {
        windowMs: game.RACE_WINDOW_MS,
        clipSec: game.RACE_CLIP_SEC,
        maxPoints: game.RACE_MAX_POINTS,
        minPoints: game.RACE_MIN_POINTS,
        firstBonus: game.RACE_FIRST_BONUS,
      },
      r2: { ...r2.status(), ping },
      catalog: meta,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Katalogfehler' });
  }
});

app.post('/api/catalog/sync', async (_req, res) => {
  try {
    const summary = await catalog.syncFromStorage();
    res.json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Sync fehlgeschlagen' });
  }
});

app.get('/api/audio/:id', async (req, res) => {
  try {
    const song = await catalog.getSong(req.params.id);
    if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
    const audio = await catalog.resolveAudio(song);
    if (!audio) return res.status(404).json({ error: 'Audio fehlt (lokal oder R2).' });
    res.setHeader('Content-Type', audio.contentType || 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(audio.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Audio-Fehler' });
  }
});

/** Short clip from cue — what the play button should use (fast + audible). */
app.get('/api/clip/:id', async (req, res) => {
  try {
    const song = await catalog.getSong(req.params.id);
    if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
    const dur = Math.min(35, Math.max(0.05, Number(req.query.dur) || 0.1));
    const clip = await catalog.resolveClip(song, dur);
    if (!clip) return res.status(404).json({ error: 'Clip fehlt (Audio/R2).' });
    res.setHeader('Content-Type', clip.contentType || 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Cue-Start-Sec', String(clip.startSec ?? clip.song?.cueStartSec ?? 0));
    res.setHeader('X-Clip-Dur', String(clip.durationSec || dur));
    res.setHeader('X-Audio-Source', String(clip.source || ''));
    res.send(clip.buffer);
  } catch (err) {
    const msg = err.message || 'Clip-Fehler';
    const hint = msg.includes('bucket does not exist')
      ? ` Bucket "${r2.bucket()}" fehlt — Railway: MJ_R2_BUCKET=lagga-mj-headle`
      : '';
    res.status(500).json({ error: msg + hint, bucket: r2.bucket() });
  }
});

app.get('/api/songs/:id/preview', async (req, res) => {
  try {
    const song = await catalog.getSong(req.params.id);
    if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
    const dur = Math.min(1, Math.max(0.05, Number(req.query.dur) || 0.1));
    const audio = await catalog.resolveAudio(song);
    if (!audio) return res.status(404).json({ error: 'Audio fehlt.' });
    res.setHeader('Content-Type', audio.contentType || 'audio/mpeg');
    res.setHeader('X-Cue-Start-Sec', String(song.cueStartSec || 0));
    res.setHeader('X-Cue-Quality', String(song.cueQuality || 'missing'));
    res.setHeader('X-Preview-Dur', String(dur));
    res.send(audio.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Preview-Fehler' });
  }
});

app.post('/api/songs/:id/cue', async (req, res) => {
  try {
    const song = await catalog.getSong(req.params.id);
    if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
    const cueStartSec = Number(req.body?.cueStartSec);
    if (!Number.isFinite(cueStartSec) || cueStartSec < 0) {
      return res.status(400).json({ error: 'cueStartSec muss eine Zahl >= 0 sein.' });
    }
    const saved = catalog.saveCueOverride(song.id, {
      cueStartSec,
      cueQuality: 'manual',
      cueReason: String(req.body?.cueReason || 'manual-override'),
    });
    await catalog.loadCatalog({ force: true });
    res.json({ ok: true, id: song.id, ...saved });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Cue-Override fehlgeschlagen' });
  }
});

app.post('/api/songs/:id/analyze-cue', async (req, res) => {
  try {
    const song = await catalog.getSong(req.params.id);
    if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
    const audio = await catalog.resolveAudio(song);
    if (!audio) return res.status(404).json({ error: 'Audio fehlt.' });
    const ext = path.extname(song.audioKey || '.mp3') || '.mp3';
    const analysis = cueDetect.analyzeBuffer(audio.buffer, ext);
    const apply = req.body?.apply === true;
    if (apply && analysis.cueQuality === 'ok') {
      catalog.saveCueOverride(song.id, {
        cueStartSec: analysis.cueStartSec,
        cueQuality: 'ok',
        cueReason: analysis.reason || 'auto-onset',
      });
      await catalog.loadCatalog({ force: true });
    }
    res.json({
      ok: true,
      id: song.id,
      analysis,
      applied: !!apply && analysis.cueQuality === 'ok',
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analyse fehlgeschlagen' });
  }
});


async function postStartWarm(room, songs) {
  if (room.current?.songId) {
    const warmSong =
      songs.find((s) => s.id === room.current.songId) ||
      (room.songMeta?.[room.current.songId]
        ? { id: room.current.songId, ...room.songMeta[room.current.songId] }
        : { id: room.current.songId });
    void warmClipsForSong(warmSong, { race: game.raceOn(room) });
  }
}

io.on('connection', (socket) => {
  socket.on('room:create-solo', async (payload = {}, ack) => {
    try {
      if (payload.partyId) {
        if (typeof ack === 'function') ack({ error: 'In einer Party ist Solo gesperrt.' });
        return;
      }
      const room = rooms.createRoom(socket.id);
      room.solo = true;
      const join = rooms.joinRoom(room.code, socket.id, payload.name || 'Solo');
      if (join.error) {
        rooms.leaveSocket(socket.id, { hard: true });
        if (typeof ack === 'function') ack({ error: join.error });
        return;
      }
      if (payload.rounds) game.setRounds(room, socket.id, payload.rounds);
      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: rooms.getPublicState(room, socket.id),
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

      const room = rooms.getOrCreatePartyRoom(partyId, socket.id);
      room.solo = false;
      room.partyId = partyId;

      const join = rooms.joinRoom(room.code, socket.id, name);
      if (join.error) {
        if (typeof ack === 'function') ack({ error: join.error });
        return;
      }

      const isLead = hubParty.leadId && memberId && hubParty.leadId === memberId;
      if (isLead || !room.hostId) {
        room.hostId = socket.id;
        room.hostSocketId = socket.id;
      }

      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: rooms.getPublicState(room, socket.id),
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
      const room = rooms.getRoomForSocket(socket.id);
      if (!room) {
        if (typeof ack === 'function') ack({ error: 'Keine Session.' });
        return;
      }
      const partyId = room.partyId;
      const code = room.code;
      rooms.leaveSocket(socket.id, { hard: true });
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
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setRounds(room, socket.id, payload.rounds);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: rooms.getPublicState(room, socket.id) });
  });

  socket.on('lobby:set-sync-reveal', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setSyncReveal(room, socket.id, payload.syncReveal);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, syncReveal: result.syncReveal, state: rooms.getPublicState(room, socket.id) });
    }
  });

  socket.on('lobby:set-mode', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setMode(room, socket.id, payload.mode);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, mode: result.mode, state: rooms.getPublicState(room, socket.id) });
    }
  });

  socket.on('clock:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ serverNow: Date.now() });
  });

  socket.on('race:armed', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    if (!game.raceOn(room) || !room.current) {
      return typeof ack === 'function' && ack({ error: 'Kein Race.' });
    }
    if (payload.songId && payload.songId !== room.current.songId) {
      return typeof ack === 'function' && ack({ error: 'Falscher Song.' });
    }
    const result = game.markRaceArmed(room, socket.id);
    if (result.error) return typeof ack === 'function' && ack(result);
    if (result.allArmed) fireRaceGo(room);
    else broadcastRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, ...result, state: rooms.getPublicState(room, socket.id) });
    }
  });

  // Kept for older clients; Ready is no longer required to start.
  socket.on('lobby:ready', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.setReady(room, socket.id, payload.ready !== false);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('game:start', async (_payload, ack) => {
    try {
      const room = rooms.getRoomForSocket(socket.id);
      if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
      if (room.hostId !== socket.id) {
        return typeof ack === 'function' && ack({ error: 'Nur der Host startet.' });
      }
      clearRaceTimers(room);
      const songs = await catalog.listPlayableSongs();
      const result = game.startMatch(room, songs);
      if (result.error) return typeof ack === 'function' && ack(result);
      // Refine cues for match tracks (sync: current; async: whole playlist).
      const ids = room.current?.songId
        ? [room.current.songId]
        : [...(room.trackIds || [])];
      for (const songId of ids) {
        const base = songs.find((s) => s.id === songId);
        if (!base) continue;
        const refined = await catalog.ensureAudibleCue(base);
        const cue = Number(refined.cueStartSec) || 0;
        if (room.songMeta?.[songId]) room.songMeta[songId].cueStartSec = cue;
        if (room.current?.songId === songId) room.current.cueStartSec = cue;
      }
      await postStartWarm(room, songs);
      if (game.raceOn(room) && room.current) {
        armRaceRound(room);
      } else {
        broadcastRoom(room);
      }
      if (typeof ack === 'function') ack({ ok: true, state: rooms.getPublicState(room, socket.id) });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Start fehlgeschlagen.' });
    }
  });

  socket.on('game:restart', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    if (room.hostId !== socket.id) {
      return typeof ack === 'function' && ack({ error: 'Nur der Host startet eine neue Runde.' });
    }
    clearRaceTimers(room);
    const result = game.restartSession(room);
    if (result.error) return typeof ack === 'function' && ack(result);
    broadcastRoom(room);
    if (typeof ack === 'function') ack({ ok: true, state: rooms.getPublicState(room, socket.id) });
  });

  socket.on('round:guess', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.submitGuess(room, socket.id, payload.text || '');
    if (result.error) return typeof ack === 'function' && ack(result);
    if (result.correct && game.raceOn(room) && room.phase === 'reveal') {
      clearRaceTimers(room);
    }
    broadcastRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, ...result, state: rooms.getPublicState(room, socket.id) });
    }
  });

  socket.on('round:skip', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
    const result = game.skipStage(room, socket.id);
    if (result.error) return typeof ack === 'function' && ack(result);
    if (game.raceOn(room) && room.phase === 'reveal') clearRaceTimers(room);
    broadcastRoom(room);
    if (typeof ack === 'function') {
      ack({ ok: true, ...result, state: rooms.getPublicState(room, socket.id) });
    }
  });

  socket.on('round:next', async (_payload, ack) => {
    try {
      const room = rooms.getRoomForSocket(socket.id);
      if (!room) return typeof ack === 'function' && ack({ error: 'Keine Session.' });
      if (room.hostId !== socket.id) {
        return typeof ack === 'function' && ack({ error: 'Nur der Host.' });
      }
      clearRaceTimers(room);
      const songs = await catalog.listPlayableSongs();
      const result = game.nextRound(room, songs);
      if (result.error) return typeof ack === 'function' && ack(result);
      if (room.current?.songId) {
        const base = songs.find((s) => s.id === room.current.songId);
        if (base) {
          const refined = await catalog.ensureAudibleCue(base);
          room.current.cueStartSec = Number(refined.cueStartSec) || 0;
          void warmClipsForSong(refined, { race: game.raceOn(room) });
        }
      }
      if (result.finished) {
        broadcastRoom(room);
      } else if (game.raceOn(room) && room.current) {
        armRaceRound(room);
      } else {
        broadcastRoom(room);
      }
      if (typeof ack === 'function') {
        ack({ ok: true, ...result, state: rooms.getPublicState(room, socket.id) });
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Weiter fehlgeschlagen.' });
    }
  });

  socket.on('disconnect', () => {
    const result = rooms.leaveSocket(socket.id, { hard: false });
    if (result?.room && !result.empty) {
      if (game.raceOn(result.room) && result.room.phase === 'playing') {
        game.maybeReveal(result.room);
      }
      broadcastRoom(result.room);
    } else if (result?.room && result.empty) {
      clearRaceTimers(result.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`MJ Headle listening on :${PORT}`);
  console.log(
    `R2: ${r2.isEnabled() ? `enabled (${r2.bucket()})` : 'disabled — local data/audio fallback'}`
  );
});
