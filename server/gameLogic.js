const { loadPack, listPacks } = require('./packLoader');

function createEmptyRoom(code, hostSocketId) {
  const packs = listPacks();
  const defaultPackId = packs[0]?.id || null;
  let pack = null;
  if (defaultPackId) {
    try {
      pack = loadPack(defaultPackId);
    } catch {
      pack = null;
    }
  }

  return {
    code,
    phase: 'lobby', // lobby | casting | dubbing | review
    hostId: hostSocketId,
    hostSocketId,
    solo: false,
    players: [],
    packId: pack?.id || null,
    pack: packPublic(pack),
    casting: {}, // character -> playerId
    sceneIndex: 0,
    takes: {}, // sceneId -> { playerId, playerName, audioBase64, mimeType, durationMs }
    sync: {
      playing: false,
      mediaTime: 0,
      updatedAt: Date.now(),
    },
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function packPublic(pack) {
  if (!pack) return null;
  return {
    id: pack.id,
    title: pack.title,
    iconUrl: pack.iconUrl,
    videoUrl: pack.videoUrl,
    backingTrackUrl: pack.backingTrackUrl,
    characters: pack.characters,
    scenes: pack.scenes.map((s) => ({
      id: s.id,
      caption: s.caption,
      character: s.character,
      timestamp: s.timestamp,
      endTimestamp: s.endTimestamp,
      duration: s.duration,
      referenceDuration: s.referenceDuration ?? null,
      imageUrl: s.imageUrl,
      referenceUrl: s.referenceUrl,
    })),
  };
}

function publicState(room) {
  const scenes = room.pack?.scenes || [];
  const currentScene = scenes[room.sceneIndex] || null;
  const takeStatus = {};
  const takeMeta = {};
  for (const scene of scenes) {
    const take = room.takes[scene.id];
    takeStatus[scene.id] = !!take;
    if (take) {
      takeMeta[scene.id] = {
        playerId: take.playerId,
        playerName: take.playerName,
        submittedAt: take.submittedAt,
      };
    }
  }

  const doneCount = Object.keys(room.takes).length;
  const total = scenes.length;

  const byCharacter = {};
  for (const scene of scenes) {
    if (!byCharacter[scene.character]) {
      byCharacter[scene.character] = { total: 0, done: 0 };
    }
    byCharacter[scene.character].total += 1;
    if (takeStatus[scene.id]) byCharacter[scene.character].done += 1;
  }

  const progressBoard = scenes.map((scene) => ({
    id: scene.id,
    caption: scene.caption,
    character: scene.character,
    timestamp: scene.timestamp,
    done: !!takeStatus[scene.id],
    playerName: takeMeta[scene.id]?.playerName || null,
  }));

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: !!p.ready,
      premiereReady: !!p.premiereReady,
      connected: p.connected !== false,
      characters: Object.entries(room.casting)
        .filter(([, pid]) => pid === p.id)
        .map(([ch]) => ch),
    })),
    availablePacks: listPacks(),
    packId: room.packId,
    pack: room.pack,
    casting: { ...room.casting },
    sceneIndex: room.sceneIndex,
    currentScene,
    takeStatus,
    takeMeta,
    progressBoard,
    byCharacter,
    doneCount,
    totalScenes: total,
    percentDone: total ? Math.round((doneCount / total) * 100) : 0,
    allDone: total > 0 && doneCount >= total,
    solo: !!room.solo,
    lobby: lobbyStatus(room),
    premiere: premiereStatus(room),
    sync: {
      playing: !!room.sync?.playing,
      mediaTime: room.sync?.mediaTime || 0,
      updatedAt: room.sync?.updatedAt || Date.now(),
      serverNow: Date.now(),
    },
  };
}

function premiereVoters(room) {
  const castIds = new Set(Object.values(room.casting || {}));
  const withCast = (room.players || []).filter((p) => castIds.has(p.id));
  const pool = withCast.length ? withCast : room.players || [];
  // Offline seats don't block the team
  return pool.filter((p) => p.connected !== false);
}

function premiereStatus(room) {
  const voters = premiereVoters(room);
  const readyCount = voters.filter((p) => p.premiereReady).length;
  const waitingFor = voters.filter((p) => !p.premiereReady).map((p) => p.name);
  const allReady = voters.length > 0 && waitingFor.length === 0;
  return {
    readyCount,
    playerCount: voters.length,
    allReady,
    canStart: allReady,
    waitingFor,
  };
}

function lobbyStatus(room) {
  const players = room.players || [];
  const characters = room.pack?.characters || [];
  const casting = room.casting || {};
  const withChar = players.filter((p) => Object.values(casting).includes(p.id));
  const readyCount = players.filter((p) => p.ready).length;
  const unassignedChars = characters.filter((ch) => !casting[ch]);
  const allCharsAssigned =
    characters.length > 0 && unassignedChars.length === 0;
  const allReady =
    players.length >= 1 &&
    players.every((p) => p.ready) &&
    withChar.length === players.length;
  const waitingPlayers = players
    .filter((p) => !p.ready || !Object.values(casting).includes(p.id))
    .map((p) => p.name);
  return {
    playerCount: players.length,
    readyCount,
    allReady,
    allCharsAssigned,
    unassignedChars,
    canStart: allReady && allCharsAssigned && !!room.pack,
    waitingFor: waitingPlayers,
  };
}

function setPack(room, packId) {
  if (room.phase !== 'lobby' && room.phase !== 'casting') {
    return { error: 'Pack kann jetzt nicht gewechselt werden.' };
  }
  try {
    const pack = loadPack(packId);
    room.packId = pack.id;
    room.pack = packPublic(pack);
    room.casting = {};
    room.sceneIndex = 0;
    room.takes = {};
    room.lastActivity = Date.now();
    return { ok: true };
  } catch (err) {
    return { error: err.message || 'Pack laden fehlgeschlagen.' };
  }
}

function addPlayer(room, socketId, name) {
  const trimmed = String(name || '').trim().slice(0, 24);
  if (!trimmed) return { error: 'Name erforderlich.' };

  // Reclaim disconnected seat with same name (reload / Netz-Weg)
  const offline = room.players.find(
    (p) =>
      p.connected === false &&
      p.name.toLowerCase() === trimmed.toLowerCase()
  );
  if (offline) {
    const oldId = offline.id;
    offline.id = socketId;
    offline.connected = true;
    offline.disconnectedAt = null;
    for (const [ch, pid] of Object.entries(room.casting)) {
      if (pid === oldId) room.casting[ch] = socketId;
    }
    if (room.hostId === oldId) room.hostId = socketId;
    if (room.hostSocketId === oldId || !room.hostSocketId) {
      room.hostSocketId = socketId;
    }
    for (const take of Object.values(room.takes)) {
      if (take.playerId === oldId) take.playerId = socketId;
    }
    room.lastActivity = Date.now();
    return { ok: true, player: offline, reclaimed: true };
  }

  if (room.phase !== 'lobby' && room.phase !== 'casting') {
    return { error: 'Runde läuft bereits — mit dem gleichen Namen erneut beitreten zum Reconnect.' };
  }
  if (room.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    return { error: 'Name bereits vergeben.' };
  }
  if (room.players.length >= 12) return { error: 'Raum ist voll (max. 12).' };

  room.players.push({
    id: socketId,
    name: trimmed,
    ready: false,
    premiereReady: false,
    connected: true,
    disconnectedAt: null,
  });
  room.lastActivity = Date.now();
  if (room.phase === 'lobby') room.phase = 'casting';
  return { ok: true, player: room.players[room.players.length - 1] };
}

function softDisconnect(room, socketId) {
  const player = room.players.find((p) => p.id === socketId);
  if (player) {
    player.connected = false;
    player.disconnectedAt = Date.now();
    // Keep casting & ready — reconnect restores the seat
  }
  if (room.hostSocketId === socketId) {
    room.hostSocketId = null;
    // hostId stays as the player id so reconnect can reclaim host
  }
  room.lastActivity = Date.now();
  return {
    ok: true,
    soft: true,
    hostLeft: room.hostId === socketId,
    empty: false,
  };
}

function removePlayer(room, socketId) {
  const isHost = room.hostSocketId === socketId || room.hostId === socketId;
  const idx = room.players.findIndex((p) => p.id === socketId);

  if (idx !== -1) {
    room.players.splice(idx, 1);
    for (const [ch, pid] of Object.entries(room.casting)) {
      if (pid === socketId) delete room.casting[ch];
    }
  }

  if (isHost) {
    room.hostSocketId = null;
    room.hostId = null;
  }

  room.lastActivity = Date.now();
  const empty = room.players.length === 0 && !room.hostSocketId;
  return { removed: idx !== -1, hostLeft: isHost, empty };
}

function claimHost(room, socketId) {
  room.hostId = socketId;
  room.hostSocketId = socketId;
  room.lastActivity = Date.now();
  return { ok: true };
}

function claimCharacter(room, playerId, character) {
  if (room.phase !== 'lobby' && room.phase !== 'casting') {
    return { error: 'Casting ist geschlossen.' };
  }
  if (!room.pack?.characters?.includes(character)) {
    return { error: 'Unbekannter Charakter.' };
  }
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { error: 'Spieler nicht gefunden.' };

  const takenBy = room.casting[character];

  // Toggle: eigene Auswahl wieder abwählen
  if (takenBy === playerId) {
    delete room.casting[character];
    player.ready = false;
    room.lastActivity = Date.now();
    return { ok: true, released: true };
  }

  if (takenBy && takenBy !== playerId) {
    return { error: 'Charakter bereits vergeben.' };
  }

  // Mehrere Charaktere pro Spieler erlaubt
  room.casting[character] = playerId;
  if (room.phase === 'lobby') room.phase = 'casting';
  player.ready = false;
  room.lastActivity = Date.now();
  return { ok: true };
}

function updatePlayerSocket(room, oldId, newId) {
  const player = room.players.find((p) => p.id === oldId);
  if (!player) return false;
  player.id = newId;
  for (const [ch, pid] of Object.entries(room.casting)) {
    if (pid === oldId) room.casting[ch] = newId;
  }
  if (room.hostId === oldId) room.hostId = newId;
  if (room.hostSocketId === oldId) room.hostSocketId = newId;
  for (const take of Object.values(room.takes)) {
    if (take.playerId === oldId) take.playerId = newId;
  }
  room.lastActivity = Date.now();
  return true;
}

function setReady(room, playerId, ready) {
  if (room.phase !== 'lobby' && room.phase !== 'casting') {
    return { error: 'Ready nur in der Lobby.' };
  }
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { error: 'Spieler nicht gefunden.' };
  const hasChar = Object.values(room.casting).includes(playerId);
  if (ready && !hasChar) {
    return { error: 'Zuerst mindestens einen Charakter wählen.' };
  }
  player.ready = !!ready;
  room.lastActivity = Date.now();
  return { ok: true, ready: player.ready };
}

function assignAllCharacters(room, playerId) {
  if (!room.pack?.characters?.length) return { error: 'Kein Pack / keine Charaktere.' };
  room.casting = {};
  for (const ch of room.pack.characters) {
    room.casting[ch] = playerId;
  }
  const player = room.players.find((p) => p.id === playerId);
  if (player) player.ready = true;
  room.lastActivity = Date.now();
  return { ok: true };
}

function startSoloSession(room, playerId, packId) {
  room.solo = true;
  if (packId) {
    const set = setPack(room, packId);
    if (set.error) return set;
  }
  if (!room.pack) return { error: 'Kein Pack geladen.' };
  const assign = assignAllCharacters(room, playerId);
  if (assign.error) return assign;
  return startDubbing(room);
}

function startDubbing(room) {
  if (!room.pack || !room.pack.scenes.length) {
    return { error: 'Kein Pack geladen.' };
  }
  if (room.players.length < 1) {
    return { error: 'Mindestens ein Spieler nötig.' };
  }

  if (!room.solo) {
    const status = lobbyStatus(room);
    if (!status.canStart) {
      if (status.unassignedChars?.length) {
        return {
          error: `Noch nicht verteilt: ${status.unassignedChars.join(', ')}`,
        };
      }
      if (status.waitingFor.length) {
        return {
          error: `Noch nicht ready: ${status.waitingFor.join(', ')}`,
        };
      }
      return { error: 'Nicht bereit zum Start.' };
    }
  }

  room.phase = 'dubbing';
  room.sceneIndex = 0;
  room.sync = {
    playing: false,
    mediaTime: 0,
    updatedAt: Date.now(),
  };
  room.lastActivity = Date.now();
  return { ok: true };
}

function setSync(room, { playing, mediaTime }) {
  if (!room.sync) {
    room.sync = { playing: false, mediaTime: 0, updatedAt: Date.now() };
  }
  if (typeof playing === 'boolean') room.sync.playing = playing;
  if (Number.isFinite(mediaTime)) room.sync.mediaTime = Math.max(0, mediaTime);
  room.sync.updatedAt = Date.now();
  room.lastActivity = Date.now();
  return {
    ok: true,
    sync: {
      playing: room.sync.playing,
      mediaTime: room.sync.mediaTime,
      updatedAt: room.sync.updatedAt,
      serverNow: Date.now(),
    },
  };
}

function currentScene(room) {
  return room.pack?.scenes?.[room.sceneIndex] || null;
}

function canRecordScene(room, playerId, scene) {
  if (!scene) return { error: 'Keine Szene.' };
  const assignee = room.casting[scene.character];
  if (assignee && assignee !== playerId) {
    return { error: `Nur ${scene.character} darf diese Szene aufnehmen.` };
  }
  // If somehow unassigned, any player may record
  return { ok: true };
}

const TIMING_OFFSET_MAX_SEC = 0.6;

function clampTimingOffsetSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-TIMING_OFFSET_MAX_SEC, Math.min(TIMING_OFFSET_MAX_SEC, n));
}

function submitTake(room, playerId, sceneId, audioBase64, mimeType, durationMs, timingOffsetSec) {
  if (room.phase !== 'dubbing' && room.phase !== 'review') {
    return { error: 'Aufnahmen nur während Dubbing/Review.' };
  }
  const scene = (room.pack?.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return { error: 'Szene nicht gefunden.' };

  const gate = canRecordScene(room, playerId, scene);
  if (gate.error) return gate;

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return { error: 'Keine Audiodaten.' };
  }
  if (audioBase64.length > 6_000_000) {
    return { error: 'Aufnahme zu groß.' };
  }

  const player = room.players.find((p) => p.id === playerId);
  const prev = room.takes[sceneId];
  const offset =
    timingOffsetSec !== undefined && timingOffsetSec !== null
      ? clampTimingOffsetSec(timingOffsetSec)
      : clampTimingOffsetSec(prev?.timingOffsetSec);
  room.takes[sceneId] = {
    playerId,
    playerName: player?.name || '?',
    audioBase64,
    mimeType: mimeType || 'audio/webm',
    durationMs: Number(durationMs) || 0,
    timingOffsetSec: offset,
    submittedAt: Date.now(),
  };
  room.lastActivity = Date.now();
  return { ok: true, take: room.takes[sceneId] };
}

function nextScene(room) {
  if (room.phase !== 'dubbing') return { error: 'Falsche Phase.' };
  if (room.sceneIndex >= (room.pack?.scenes?.length || 0) - 1) {
    room.phase = 'review';
    room.lastActivity = Date.now();
    return { ok: true, done: true };
  }
  room.sceneIndex += 1;
  room.lastActivity = Date.now();
  return { ok: true, done: false };
}

function prevScene(room) {
  if (room.phase !== 'dubbing' && room.phase !== 'review') {
    return { error: 'Falsche Phase.' };
  }
  if (room.phase === 'review') {
    room.phase = 'dubbing';
  }
  room.sceneIndex = Math.max(0, room.sceneIndex - 1);
  room.lastActivity = Date.now();
  return { ok: true };
}

function gotoScene(room, index) {
  const max = (room.pack?.scenes?.length || 1) - 1;
  const i = Math.max(0, Math.min(max, Number(index) || 0));
  room.sceneIndex = i;
  if (room.phase === 'review') room.phase = 'dubbing';
  room.lastActivity = Date.now();
  return { ok: true };
}

function enterReview(room) {
  if (room.phase !== 'dubbing' && room.phase !== 'review') {
    return { error: 'Falsche Phase.' };
  }
  const scenes = room.pack?.scenes || [];
  const allDone = scenes.length > 0 && scenes.every((s) => room.takes[s.id]);
  if (!allDone) return { error: 'Noch nicht alle Clips fertig.' };
  const status = premiereStatus(room);
  if (!status.allReady) {
    const waiting = status.waitingFor?.length
      ? ` Warte auf: ${status.waitingFor.join(', ')}.`
      : '';
    return { error: `Noch nicht alle Spieler bereit.${waiting}` };
  }
  room.phase = 'review';
  room.lastActivity = Date.now();
  return { ok: true };
}

function importProjectTakes(room, playerId, takesPayload = {}, opts = {}) {
  if (!room.pack) return { error: 'Kein Pack.' };
  if (room.phase === 'lobby' || room.phase === 'casting') {
    return { error: 'Erst Pack starten.' };
  }

  const player = room.players.find((p) => p.id === playerId);
  const sceneIds = new Set((room.pack.scenes || []).map((s) => s.id));
  let imported = 0;

  for (const [sceneId, t] of Object.entries(takesPayload || {})) {
    if (!sceneIds.has(sceneId) || !t?.audioBase64) continue;
    room.takes[sceneId] = {
      playerId,
      playerName: t.playerName || player?.name || 'Projekt',
      audioBase64: t.audioBase64,
      mimeType: t.mimeType || 'audio/webm',
      durationMs: Number(t.durationMs) || 0,
      timingOffsetSec: clampTimingOffsetSec(t.timingOffsetSec),
      submittedAt: Date.now(),
    };
    imported += 1;
  }

  room.players.forEach((p) => {
    p.premiereReady = true;
  });

  const goReview = opts.phase !== 'dubbing';
  if (goReview) {
    room.phase = 'review';
  } else {
    room.phase = 'dubbing';
  }
  room.lastActivity = Date.now();
  return { ok: true, imported, phase: room.phase };
}

function leaveReview(room) {
  if (room.phase !== 'review') return { error: 'Nicht in der Premiere.' };
  room.phase = 'dubbing';
  room.players.forEach((p) => {
    p.premiereReady = false;
  });
  room.lastActivity = Date.now();
  return { ok: true };
}

function setPremiereReady(room, playerId, ready) {
  if (room.phase !== 'dubbing') return { error: 'Falsche Phase.' };
  const scenes = room.pack?.scenes || [];
  const allDone = scenes.length > 0 && scenes.every((s) => room.takes[s.id]);
  if (!allDone) return { error: 'Noch nicht alle Clips fertig.' };
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { error: 'Spieler nicht gefunden.' };
  player.premiereReady = !!ready;
  room.lastActivity = Date.now();
  return { ok: true, ready: player.premiereReady, premiere: premiereStatus(room) };
}

function clearPremiereReady(room) {
  room.players.forEach((p) => {
    p.premiereReady = false;
  });
}

function restartSession(room) {
  room.phase = 'lobby';
  room.sceneIndex = 0;
  room.takes = {};
  room.casting = {};
  room.players.forEach((p) => {
    p.ready = false;
    p.premiereReady = false;
  });
  room.sync = { playing: false, mediaTime: 0, updatedAt: Date.now() };
  room.lastActivity = Date.now();
  return { ok: true };
}

function getExportPayload(room) {
  if (!room.pack) return { error: 'Kein Pack.' };
  const takes = {};
  for (const [sceneId, take] of Object.entries(room.takes)) {
    takes[sceneId] = {
      playerName: take.playerName,
      mimeType: take.mimeType,
      audioBase64: take.audioBase64,
      durationMs: take.durationMs,
      timingOffsetSec: clampTimingOffsetSec(take.timingOffsetSec),
    };
  }
  return {
    ok: true,
    export: {
      packId: room.pack.id,
      title: room.pack.title,
      videoUrl: room.pack.videoUrl,
      backingTrackUrl: room.pack.backingTrackUrl,
      scenes: room.pack.scenes,
      takes,
      casting: { ...room.casting },
      exportedAt: new Date().toISOString(),
    },
  };
}

module.exports = {
  createEmptyRoom,
  publicState,
  setPack,
  addPlayer,
  removePlayer,
  softDisconnect,
  claimHost,
  updatePlayerSocket,
  claimCharacter,
  setReady,
  assignAllCharacters,
  startSoloSession,
  startDubbing,
  setSync,
  currentScene,
  submitTake,
  nextScene,
  prevScene,
  gotoScene,
  enterReview,
  leaveReview,
  setPremiereReady,
  clearPremiereReady,
  importProjectTakes,
  restartSession,
  getExportPayload,
  canRecordScene,
};
