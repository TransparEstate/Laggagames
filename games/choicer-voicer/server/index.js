const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');
const RoomManager = require('./roomManager');
const game = require('./gameLogic');
const {
  listPacks,
  resolvePackDir,
  ensureUserPacksRoot,
  ensureMetaRoot,
  USER_PACKS_ROOT,
  BUNDLED_PACKS_ROOT,
  refreshR2Manifests,
  repairPackDurations,
} = require('./packLoader');
const { installPackFromZip, deleteUserPack } = require('./packUpload');
const r2 = require('./r2');

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_PACK_UPLOAD_MB = Number(process.env.MAX_PACK_UPLOAD_MB || 1500);
/** Long uploads + ogv→mp4 conversion can exceed default Node timeouts */
const UPLOAD_TIMEOUT_MS = Number(process.env.UPLOAD_TIMEOUT_MS || 20 * 60 * 1000);

ensureUserPacksRoot();
ensureMetaRoot();

const app = express();
const server = http.createServer(app);
server.timeout = Math.max(server.timeout || 0, UPLOAD_TIMEOUT_MS);
server.headersTimeout = Math.max(server.headersTimeout || 0, UPLOAD_TIMEOUT_MS + 60_000);
server.requestTimeout = 0; // disable Node 18+ request timeout; multer/ffmpeg handle long work
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  maxHttpBufferSize: 8e6,
});

const rooms = new RoomManager();


const HUB_INTERNAL_URL = (process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${process.env.HUB_PORT || 3000}`).replace(/\/$/, '');
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';

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


const uploadTmp = path.join(USER_PACKS_ROOT, '.tmp');
fs.mkdirSync(uploadTmp, { recursive: true });

const upload = multer({
  dest: uploadTmp,
  limits: { fileSize: MAX_PACK_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const name = (file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const okExt = name.endsWith('.zip');
    const okMime =
      !mime ||
      mime.includes('zip') ||
      mime === 'application/octet-stream' ||
      mime === 'application/x-zip-compressed';
    if (!okExt && !okMime) {
      cb(new Error('Nur .zip Voicepacks werden unterstützt.'));
      return;
    }
    if (!okExt) {
      // Some mobile browsers send zip without .zip in the name — still accept by MIME
      cb(null, true);
      return;
    }
    cb(null, true);
  },
});

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const entry of list || []) {
      const family = entry.family;
      if ((family === 'IPv4' || family === 4) && !entry.internal) {
        out.push(entry.address);
      }
    }
  }
  return out;
}

async function servePackFromR2(req, res, next) {
  if (!r2.isEnabled()) {
    next();
    return;
  }
  const packId = req.params.packId;
  const rel = String(req.path || '').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) {
    next();
    return;
  }

  const pub = r2.publicBaseUrl();
  if (pub) {
    res.redirect(302, `${pub}/packs/${packId}/${rel}`);
    return;
  }

  try {
    const key = r2.packKey(packId, rel);
    const out = await r2.getObject(key, { range: req.headers.range });
    if (!out?.Body) {
      next();
      return;
    }
    if (out.ContentType) res.setHeader('Content-Type', out.ContentType);
    else res.setHeader('Content-Type', r2.contentTypeFor(rel));
    if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
    if (out.ETag) res.setHeader('ETag', out.ETag);
    res.setHeader('Accept-Ranges', 'bytes');
    if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
    res.status(req.headers.range && out.ContentRange ? 206 : 200);
    out.Body.pipe(res);
  } catch (err) {
    console.error('R2 serve error', err.message || err);
    next();
  }
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// Local pack files, then R2 fallback
app.use('/packs/:packId', (req, res, next) => {
  const resolved = resolvePackDir(req.params.packId);
  if (resolved) {
    express.static(resolved.dir, { fallthrough: true, index: false })(req, res, (err) => {
      if (err) return next(err);
      servePackFromR2(req, res, next);
    });
    return;
  }
  servePackFromR2(req, res, next);
});

app.use('/clips', express.static(path.join(__dirname, '..', 'assets', 'clips')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, r2: r2.status() });
});

app.get('/api/packs', async (_req, res) => {
  try {
    if (r2.isEnabled()) {
      await refreshR2Manifests();
    }
  } catch (e) {
    console.warn('R2 refresh:', e.message || e);
  }
  res.json({
    packs: listPacks(),
    maxUploadMb: MAX_PACK_UPLOAD_MB,
    packsDir: USER_PACKS_ROOT,
    r2: r2.status(),
  });
});

app.post('/api/packs/upload', (req, res) => {
  // Anyone can upload — no auth gate. Keep connection alive during convert/mirror.
  req.setTimeout(UPLOAD_TIMEOUT_MS);
  res.setTimeout(UPLOAD_TIMEOUT_MS);

  upload.single('pack')(req, res, async (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Datei zu groß (max. ${MAX_PACK_UPLOAD_MB} MB).`
          : err.message || 'Upload fehlgeschlagen.';
      res.status(400).json({ error: msg });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Keine Datei empfangen.' });
      return;
    }
    try {
      const result = await installPackFromZip(req.file.path, req.file.originalname);
      res.json(result);
    } catch (e) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* ignore */
      }
      console.error('Pack-Upload fehlgeschlagen:', e.message || e);
      res.status(400).json({ error: e.message || 'Pack konnte nicht installiert werden.' });
    }
  });
});

app.delete('/api/packs/:packId', async (req, res) => {
  try {
    const result = await deleteUserPack(req.params.packId);
    if (result.error) {
      res.status(400).json(result);
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Löschen fehlgeschlagen.' });
  }
});

app.get('/api/join-info', (req, res) => {
  const hostHeader = req.get('host') || `localhost:${PORT}`;
  const proto = req.protocol || 'http';
  const lans = lanAddresses().map((ip) => {
    const port = hostHeader.includes(':') ? hostHeader.split(':').pop() : PORT;
    return `${proto}://${ip}:${port}`;
  });
  res.json({
    local: `${proto}://${hostHeader}`,
    lan: lans,
    tip: 'Zweiter Computer: LAN-URL oder öffentliche URL öffnen, nicht localhost.',
  });
});

function broadcastRoom(room) {
  if (!room) return;
  io.to(room.code).emit('state:update', rooms.getPublicState(room));
}

function requireHost(socket, room) {
  if (!room) return 'Raum nicht gefunden.';
  if (room.hostId !== socket.id) return 'Nur der Host kann das.';
  return null;
}

function emitSync(room, sync) {
  io.to(room.code).emit('dub:sync', sync);
}

const PREMIERE_ARM_TIMEOUT_MS = 8000;
const PREMIERE_GO_LEAD_MS = 2800;

function connectedPlayerIds(room) {
  return (room.players || [])
    .filter((p) => p.connected !== false)
    .map((p) => p.id);
}

function clearPremiereArm(room) {
  if (room.premiereArm?.timer) {
    clearTimeout(room.premiereArm.timer);
  }
  room.premiereArm = null;
}

function firePremiereGo(room) {
  if (!room.premiereArm || room.premiereArm.fired) return;
  room.premiereArm.fired = true;
  if (room.premiereArm.timer) {
    clearTimeout(room.premiereArm.timer);
    room.premiereArm.timer = null;
  }
  const round = room.premiereArm.round;
  const serverNow = Date.now();
  const startAt = serverNow + PREMIERE_GO_LEAD_MS;
  room.premierePlayback = {
    playing: true,
    mediaTime: 0,
    startAt,
    updatedAt: serverNow,
    round,
  };
  io.to(room.code).emit('dub:premiere-play', {
    round,
    startAt,
    serverNow,
    mediaTime: 0,
    leadMs: PREMIERE_GO_LEAD_MS,
  });
}

function maybeFirePremiereGo(room) {
  if (!room.premiereArm || room.premiereArm.fired) return;
  const needed = connectedPlayerIds(room);
  const armed = room.premiereArm.armed;
  const allArmed = needed.length > 0 && needed.every((id) => armed.has(id));
  if (!allArmed) return;
  firePremiereGo(room);
}

function emitPremiereArm(room) {
  clearPremiereArm(room);
  const round = Date.now();
  room.premiereArm = {
    round,
    armed: new Set(),
    fired: false,
    timer: setTimeout(() => {
      if (room.premiereArm?.round === round && !room.premiereArm.fired) {
        firePremiereGo(room);
      }
    }, PREMIERE_ARM_TIMEOUT_MS),
  };
  const serverNow = Date.now();
  io.to(room.code).emit('dub:premiere-arm', { round, serverNow });
  return { round, serverNow, arming: true };
}

function emitPremiereStop(room) {
  clearPremiereArm(room);
  room.premierePlayback = {
    playing: false,
    mediaTime: 0,
    startAt: null,
    updatedAt: Date.now(),
  };
  const payload = { serverNow: Date.now() };
  io.to(room.code).emit('dub:premiere-stop', payload);
  return payload;
}

io.on('connection', (socket) => {
  socket.on('room:create-solo', (payload = {}, ack) => {
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
      const started = game.startSoloSession(room, socket.id, payload.packId);
      if (started.error) {
        rooms.leaveSocket(socket.id, { hard: true });
        if (typeof ack === 'function') ack({ error: started.error });
        return;
      }
      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: rooms.getPublicState(room),
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
      const packId = payload.packId;
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

      // First joiner / lead sets pack
      const isLead = hubParty.leadId && memberId && hubParty.leadId === memberId;
      if (packId && (isLead || !room.packId)) {
        const set = game.setPack(room, packId);
        if (set.error) {
          if (typeof ack === 'function') ack({ error: set.error });
          return;
        }
      }

      const join = rooms.joinRoom(room.code, socket.id, name);
      if (join.error) {
        if (typeof ack === 'function') ack({ error: join.error });
        return;
      }

      if (isLead || !room.hostId) {
        room.hostId = socket.id;
        room.hostSocketId = socket.id;
      }

      socket.join(room.code);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          state: rooms.getPublicState(room),
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
      if (room.hostId !== socket.id && room.hostSocketId !== socket.id) {
        if (typeof ack === 'function') ack({ error: 'Nur der Lead kehrt zur Lobby zurück.' });
        return;
      }
      const partyId = room.partyId || room.code;
      const ret = await postHubPartyReturn(partyId);
      if (ret.error) {
        if (typeof ack === 'function') ack({ error: ret.error });
        return;
      }
      io.to(room.code).emit('session:returned', { partyId, hub: '/' });
      if (typeof ack === 'function') ack({ ok: true, hub: '/' });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Return fehlgeschlagen.' });
    }
  });

  socket.on('room:reconnect', (payload = {}, ack) => {
    const result = rooms.reconnect(payload.code, payload.playerId, socket.id);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    socket.join(result.room.code);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        state: rooms.getPublicState(result.room),
        playerId: socket.id,
        isHost: result.room.hostId === socket.id,
      });
    }
    broadcastRoom(result.room);
  });

  socket.on('room:leave', (_payload, ack) => {
    const result = rooms.leaveSocket(socket.id, { hard: true });
    if (typeof ack === 'function') ack({ ok: true });
    if (result?.room && !result.empty) broadcastRoom(result.room);
  });

  socket.on('pack:set', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.setPack(room, payload.packId);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('cast:claim', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const result = game.claimCharacter(room, socket.id, payload.character);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('lobby:ready', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const result = game.setReady(room, socket.id, payload.ready !== false);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true, ready: result.ready });
    broadcastRoom(room);
  });

  socket.on('dub:start', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.startDubbing(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('time:ping', (_payload, ack) => {
    if (typeof ack === 'function') ack({ serverNow: Date.now() });
  });

  socket.on('dub:premiere-play', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    if (room.phase !== 'review') {
      if (typeof ack === 'function') ack({ error: 'Premiere nur in der Review-Phase.' });
      return;
    }
    const payload = emitPremiereArm(room);
    if (typeof ack === 'function') ack({ ok: true, ...payload });
  });

  socket.on('dub:premiere-armed', (payload = {}) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room || room.phase !== 'review') return;
    if (!room.premiereArm || room.premiereArm.fired) return;
    if (payload.round !== room.premiereArm.round) return;
    room.premiereArm.armed.add(socket.id);
    maybeFirePremiereGo(room);
  });

  socket.on('dub:premiere-stop', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    if (room.phase !== 'review') {
      if (typeof ack === 'function') ack({ error: 'Keine Premiere aktiv.' });
      return;
    }
    emitPremiereStop(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('dub:sync', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    if (room.phase !== 'dubbing' && room.phase !== 'review') {
      if (typeof ack === 'function') ack({ error: 'Sync nur während Dubbing/Review.' });
      return;
    }
    const sync = game.setSync(room, {
      playing: payload.playing,
      mediaTime: payload.mediaTime,
    }).sync;
    if (typeof ack === 'function') ack({ ok: true, sync });
    emitSync(room, sync);
  });

  socket.on('dub:play-segment', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const scene =
      (payload.sceneId && room.pack?.scenes?.find((s) => s.id === payload.sceneId)) ||
      game.currentScene(room);
    if (!scene) {
      if (typeof ack === 'function') ack({ error: 'Keine Szene.' });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    io.to(room.code).emit('dub:play-segment', {
      scene,
      mode: payload.mode || 'video',
      requestedBy: socket.id,
    });
  });

  socket.on('dub:get-take', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const sceneId = payload.sceneId || game.currentScene(room)?.id;
    const take = sceneId ? room.takes[sceneId] : null;
    if (!take) {
      if (typeof ack === 'function') ack({ error: 'Kein Take für diese Szene.' });
      return;
    }
    if (typeof ack === 'function') {
      ack({
        ok: true,
        sceneId,
        mimeType: take.mimeType,
        audioBase64: take.audioBase64,
        playerName: take.playerName,
        timingOffsetSec: Number(take.timingOffsetSec) || 0,
      });
    }
  });

  socket.on('dub:submit-take', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const result = game.submitTake(
      room,
      socket.id,
      payload.sceneId,
      payload.audioBase64,
      payload.mimeType,
      payload.durationMs,
      payload.timingOffsetSec
    );
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') {
      ack({ ok: true, timingOffsetSec: result.take.timingOffsetSec });
    }
    broadcastRoom(room);
    io.to(room.code).emit('dub:take-ready', {
      sceneId: payload.sceneId,
      mimeType: result.take.mimeType,
      audioBase64: result.take.audioBase64,
      playerName: result.take.playerName,
      timingOffsetSec: result.take.timingOffsetSec,
    });
  });

  socket.on('dub:next', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.nextScene(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true, done: !!result.done });
    broadcastRoom(room);
    if (!result.done) {
      io.to(room.code).emit('dub:scene', {
        scene: game.currentScene(room),
        index: room.sceneIndex,
      });
    }
  });

  socket.on('dub:prev', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.prevScene(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
    io.to(room.code).emit('dub:scene', {
      scene: game.currentScene(room),
      index: room.sceneIndex,
    });
  });

  socket.on('dub:goto', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    game.gotoScene(room, payload.index);
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
    io.to(room.code).emit('dub:scene', {
      scene: game.currentScene(room),
      index: room.sceneIndex,
    });
  });

  socket.on('dub:premiere-ready', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const result = game.setPremiereReady(room, socket.id, payload.ready !== false);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') {
      ack({ ok: true, ready: result.ready, premiere: result.premiere });
    }
    broadcastRoom(room);
  });

  socket.on('dub:import-project', (payload = {}, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    // Solo or host can restore a local project into the session
    if (!room.solo && room.hostId !== socket.id) {
      if (typeof ack === 'function') ack({ error: 'Nur Host/Solo kann ein Projekt laden.' });
      return;
    }
    const result = game.importProjectTakes(room, socket.id, payload.takes || {}, {
      phase: payload.phase === 'dubbing' ? 'dubbing' : 'review',
    });
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    clearPremiereArm(room);
    room.premierePlayback = {
      playing: false,
      mediaTime: 0,
      startAt: null,
      updatedAt: Date.now(),
    };
    if (typeof ack === 'function') {
      ack({
        ok: true,
        imported: result.imported,
        phase: result.phase,
        state: rooms.getPublicState(room),
      });
    }
    broadcastRoom(room);
  });

  socket.on('dub:review', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.enterReview(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    clearPremiereArm(room);
    room.premierePlayback = {
      playing: false,
      mediaTime: 0,
      startAt: null,
      updatedAt: Date.now(),
    };
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('dub:edit', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    const result = game.leaveReview(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    emitPremiereStop(room);
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('dub:export', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Raum nicht gefunden.' });
      return;
    }
    const result = game.getExportPayload(room);
    if (result.error) {
      if (typeof ack === 'function') ack({ error: result.error });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true, export: result.export });
  });

  socket.on('game:restart', (_payload, ack) => {
    const room = rooms.getRoomForSocket(socket.id);
    const hostErr = requireHost(socket, room);
    if (hostErr) {
      if (typeof ack === 'function') ack({ error: hostErr });
      return;
    }
    game.restartSession(room);
    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    // Soft leave: seat + casting + takes stay for reconnect / reload
    const result = rooms.leaveSocket(socket.id, { hard: false });
    if (!result || result.empty || !result.room) return;
    broadcastRoom(result.room);
  });
});

server.listen(PORT, async () => {
  console.log(`Choicer Voicer läuft auf Port ${PORT}`);
  console.log(`Bundled packs: ${BUNDLED_PACKS_ROOT}`);
  console.log(`User packs:    ${USER_PACKS_ROOT}`);
  try {
    const { spawnSync } = require('child_process');
    const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (ff.error || ff.status !== 0) {
      console.warn('ffmpeg:        fehlt — .ogv-Packs können nicht nach MP4 konvertiert werden');
    } else {
      const ver = String(ff.stdout || '').split('\n')[0] || 'ok';
      console.log(`ffmpeg:        ${ver}`);
    }
  } catch (e) {
    console.warn('ffmpeg:        nicht prüfbar', e.message || e);
  }
  const r2Info = r2.status();
  if (r2Info.enabled) {
    console.log(
      `Cloudflare R2: bucket=${r2Info.bucket} endpoint=${r2Info.endpoint || '—'} (einziger Pack-Speicher)`
    );
    if (r2Info.publicBaseUrl) console.log(`Public media:  ${r2Info.publicBaseUrl}`);
    try {
      await refreshR2Manifests();
      const remotePacks = listPacks();
      console.log(
        `R2-Packs geladen: ${remotePacks.length ? remotePacks.map((p) => p.id).join(', ') : '(noch keine — Katalog startet leer bis Uploads)'}`
      );
    } catch (e) {
      console.warn('R2-Manifeste konnten nicht geladen werden:', e.message || e);
    }
  } else {
    console.warn(
      'Cloudflare R2: AUS — Uploads sind deaktiviert. Packs werden ausschließlich in R2 gespeichert. Setze R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.'
    );
  }
  try {
    const repaired = await repairPackDurations({ uploadToR2: true });
    if (repaired.length) {
      console.log(`Clip-Dauern an Referenz-Audio angepasst (${repaired.filter((r) => r.ok).length} Packs).`);
    }
  } catch (e) {
    console.warn('Clip-Dauer-Repair:', e.message || e);
  }
  console.log(`Packs: ${listPacks().map((p) => p.id).join(', ') || '(keine)'}`);
});
