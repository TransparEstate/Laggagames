const CLIP_STAGES = [0.1, 0.5, 1, 5, 13];
const STAGE_POINTS = [100, 80, 60, 40, 20];
const DEFAULT_ROUNDS = 5;

function normalizeGuess(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(guess, title) {
  const g = normalizeGuess(guess);
  const t = normalizeGuess(title);
  if (!g || !t) return false;
  if (g === t) return true;
  const strip = (s) =>
    s
      .replace(
        /\b(2012 remaster|remastered version|remastered|radio edit|single version|immortal version)\b/g,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();
  const gs = strip(g);
  const ts = strip(t);
  return !!(gs && ts && (gs === ts || ts.startsWith(gs) || gs.startsWith(ts)));
}

function createEmptyRoom(code, hostSocketId) {
  return {
    code,
    partyId: null,
    solo: false,
    phase: 'lobby', // lobby | playing | reveal | finished
    hostId: hostSocketId,
    hostSocketId,
    players: [],
    settings: {
      rounds: DEFAULT_ROUNDS,
      // true = alle müssen fertig sein bevor Reveal; false = jeder sieht Reveal sofort nach eigenem Finish
      syncReveal: true,
    },
    roundIndex: 0,
    totalRounds: DEFAULT_ROUNDS,
    trackIds: [],
    current: null,
    scores: {},
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: !!p.ready,
    connected: p.connected !== false,
    score: p.score || 0,
  };
}

function ensureProgress(room, socketId) {
  if (!room.current) return null;
  if (!room.current.guesses[socketId]) {
    room.current.guesses[socketId] = {
      text: '',
      correct: false,
      points: 0,
      stageIndex: 0,
      done: false,
      giveUp: false,
      at: null,
    };
  }
  return room.current.guesses[socketId];
}

function playerSeesReveal(room, me) {
  if (!room.current) return false;
  if (room.current.revealed) return true;
  // Async mode: finished players see the answer immediately without waiting.
  if (room.settings.syncReveal === false && me?.done) return true;
  return false;
}

function publicState(room, forSocketId = null) {
  const cur = room.current;
  let currentPublic = null;
  if (cur) {
    const me = forSocketId ? ensureProgress(room, forSocketId) : null;
    const myStage = me ? Number(me.stageIndex) || 0 : 0;
    const showAnswer = playerSeesReveal(room, me);
    currentPublic = {
      round: room.roundIndex + 1,
      totalRounds: room.totalRounds,
      songId: cur.songId,
      cueStartSec: cur.cueStartSec,
      // Per-player stage — async skip/guess must not move others.
      stageIndex: myStage,
      stageSeconds: CLIP_STAGES[myStage] ?? null,
      stages: CLIP_STAGES,
      revealed: !!cur.revealed,
      revealedForMe: showAnswer,
      title: showAnswer ? cur.title : null,
      artist: showAnswer ? cur.artist : null,
      myGuess: me
        ? {
            text: me.text,
            correct: !!me.correct,
            points: me.points || 0,
            stageIndex: myStage,
            done: !!me.done,
            giveUp: !!me.giveUp,
          }
        : null,
      playersDone: Object.values(cur.guesses || {}).filter((g) => g.done).length,
    };
  }

  return {
    code: room.code,
    partyId: room.partyId,
    solo: !!room.solo,
    phase: room.phase,
    hostId: room.hostId,
    settings: {
      rounds: room.settings.rounds,
      syncReveal: room.settings.syncReveal !== false,
    },
    players: room.players.map(publicPlayer),
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    current: currentPublic,
    leaderboard: [...room.players]
      .map((p) => ({ id: p.id, name: p.name, score: p.score || 0 }))
      .sort((a, b) => b.score - a.score),
  };
}

function addPlayer(room, socketId, name) {
  const clean = String(name || '').trim().slice(0, 24) || 'Spieler';
  const reclaim = room.players.find(
    (p) => p.name.toLowerCase() === clean.toLowerCase() && p.connected === false
  );
  if (reclaim) {
    const oldId = reclaim.id;
    reclaim.id = socketId;
    reclaim.connected = true;
    reclaim.disconnectedAt = null;
    if (room.hostId === oldId) {
      room.hostId = socketId;
      room.hostSocketId = socketId;
    }
    if (room.scores[oldId] != null) {
      room.scores[socketId] = room.scores[oldId];
      delete room.scores[oldId];
    }
    reclaim.score = room.scores[socketId] || reclaim.score || 0;
    room.lastActivity = Date.now();
    return { player: reclaim, reclaimed: true };
  }
  if (room.players.some((p) => p.id === socketId)) {
    return { player: room.players.find((p) => p.id === socketId) };
  }
  const player = {
    id: socketId,
    name: clean,
    ready: false,
    connected: true,
    score: room.scores[socketId] || 0,
  };
  room.players.push(player);
  room.lastActivity = Date.now();
  return { player };
}

function removePlayer(room, socketId) {
  const idx = room.players.findIndex((p) => p.id === socketId);
  if (idx === -1) return { empty: room.players.length === 0 };
  room.players.splice(idx, 1);
  let hostLeft = false;
  if (room.hostId === socketId) {
    hostLeft = true;
    room.hostId = room.players[0]?.id || null;
    room.hostSocketId = room.hostId;
  }
  return { empty: room.players.length === 0, hostLeft };
}

function softDisconnect(room, socketId) {
  const p = room.players.find((x) => x.id === socketId);
  if (!p) return;
  p.connected = false;
  p.disconnectedAt = Date.now();
  room.lastActivity = Date.now();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startMatch(room, playableSongs) {
  if (!playableSongs.length) {
    return { error: 'Keine spielbaren Songs (Audio + gültiger Cue fehlen).' };
  }
  const rounds = Math.min(
    Math.max(1, Number(room.settings.rounds) || DEFAULT_ROUNDS),
    playableSongs.length
  );
  room.totalRounds = rounds;
  room.roundIndex = 0;
  room.trackIds = shuffle(playableSongs.map((s) => s.id)).slice(0, rounds);
  room.scores = {};
  for (const p of room.players) {
    p.score = 0;
    p.ready = false;
    room.scores[p.id] = 0;
  }
  room.phase = 'playing';
  return beginRound(room, playableSongs);
}

function beginRound(room, playableSongs) {
  const songId = room.trackIds[room.roundIndex];
  const song = playableSongs.find((s) => s.id === songId) || playableSongs[0];
  if (!song) return { error: 'Song fehlt.' };
  room.current = {
    songId: song.id,
    title: song.title,
    artist: song.artist,
    cueStartSec: Number(song.cueStartSec) || 0,
    guesses: {},
    revealed: false,
    startedAt: Date.now(),
  };
  // Seed per-player progress so everyone starts at stage 0 independently.
  for (const p of room.players) {
    if (p.connected !== false) ensureProgress(room, p.id);
  }
  room.phase = 'playing';
  room.lastActivity = Date.now();
  return { ok: true };
}

function finishPlayerRound(
  room,
  socketId,
  { text = '', correct = false, giveUp = false, points = 0, stageIndex = 0 } = {}
) {
  const progress = ensureProgress(room, socketId);
  progress.text = String(text || '').trim();
  progress.correct = !!correct;
  progress.points = Number(points) || 0;
  progress.stageIndex = Number(stageIndex) || 0;
  progress.done = true;
  progress.giveUp = !!giveUp;
  progress.at = Date.now();
  room.lastActivity = Date.now();
  maybeReveal(room);
  return {
    ok: true,
    correct: !!correct,
    points: progress.points,
    giveUp: !!giveUp,
    stageIndex: progress.stageIndex,
  };
}

function skipStage(room, socketId) {
  if (room.phase !== 'playing' || !room.current || room.current.revealed) {
    return { error: 'Keine aktive Runde.' };
  }
  const progress = ensureProgress(room, socketId);
  if (progress.done) return { error: 'Du bist in dieser Runde fertig.' };

  if (progress.stageIndex >= CLIP_STAGES.length - 1) {
    return finishPlayerRound(room, socketId, {
      text: '',
      correct: false,
      giveUp: true,
      stageIndex: progress.stageIndex,
    });
  }
  progress.stageIndex += 1;
  progress.at = Date.now();
  room.lastActivity = Date.now();
  return { ok: true, stageIndex: progress.stageIndex };
}

function submitGuess(room, socketId, text) {
  if (room.phase !== 'playing' || !room.current || room.current.revealed) {
    return { error: 'Keine aktive Runde.' };
  }
  const progress = ensureProgress(room, socketId);
  if (progress.done) return { error: 'Bereits geraten.' };

  const correct = titlesMatch(text, room.current.title);
  if (correct) {
    const stageIndex = progress.stageIndex;
    const points = STAGE_POINTS[stageIndex] ?? 0;
    const player = room.players.find((p) => p.id === socketId);
    if (player) {
      player.score = (player.score || 0) + points;
      room.scores[socketId] = player.score;
    }
    return finishPlayerRound(room, socketId, {
      text,
      correct: true,
      giveUp: false,
      points,
      stageIndex,
    });
  }

  progress.text = String(text || '').trim();
  progress.correct = false;
  progress.points = 0;
  progress.at = Date.now();

  if (progress.stageIndex >= CLIP_STAGES.length - 1) {
    return finishPlayerRound(room, socketId, {
      text,
      correct: false,
      giveUp: true,
      stageIndex: progress.stageIndex,
    });
  }
  progress.stageIndex += 1;
  room.lastActivity = Date.now();
  return { ok: true, correct: false, stageIndex: progress.stageIndex };
}

function maybeReveal(room) {
  if (!room.current) return;
  const connected = room.players.filter((p) => p.connected !== false);
  const allDone =
    connected.length > 0 && connected.every((p) => room.current.guesses[p.id]?.done);
  if (allDone) {
    room.current.revealed = true;
    room.phase = 'reveal';
  }
}

function nextRound(room, playableSongs) {
  if (room.roundIndex + 1 >= room.totalRounds) {
    room.phase = 'finished';
    room.current = room.current ? { ...room.current, revealed: true } : null;
    return { ok: true, finished: true };
  }
  room.roundIndex += 1;
  return beginRound(room, playableSongs);
}

function setReady(room, socketId, ready) {
  const p = room.players.find((x) => x.id === socketId);
  if (!p) return { error: 'Spieler nicht gefunden.' };
  p.ready = !!ready;
  room.lastActivity = Date.now();
  return { ok: true };
}

function setRounds(room, socketId, rounds) {
  if (room.hostId !== socketId) return { error: 'Nur der Host ändert die Runden.' };
  if (room.phase !== 'lobby') return { error: 'Nur in der Lobby.' };
  const n = Math.max(1, Math.min(20, Number(rounds) || DEFAULT_ROUNDS));
  room.settings.rounds = n;
  room.totalRounds = n;
  room.lastActivity = Date.now();
  return { ok: true };
}

function setSyncReveal(room, socketId, syncReveal) {
  if (room.hostId !== socketId) return { error: 'Nur der Host ändert den Reveal-Modus.' };
  if (room.phase !== 'lobby') return { error: 'Nur in der Lobby.' };
  room.settings.syncReveal = !!syncReveal;
  room.lastActivity = Date.now();
  return { ok: true, syncReveal: room.settings.syncReveal };
}

module.exports = {
  CLIP_STAGES,
  STAGE_POINTS,
  DEFAULT_ROUNDS,
  createEmptyRoom,
  publicState,
  addPlayer,
  removePlayer,
  softDisconnect,
  titlesMatch,
  normalizeGuess,
  startMatch,
  skipStage,
  submitGuess,
  finishPlayerRound,
  nextRound,
  setReady,
  setRounds,
  setSyncReveal,
};
