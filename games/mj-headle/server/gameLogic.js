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
    phase: 'lobby',
    hostId: hostSocketId,
    hostSocketId,
    players: [],
    settings: {
      rounds: DEFAULT_ROUNDS,
      syncReveal: true,
    },
    roundIndex: 0,
    totalRounds: DEFAULT_ROUNDS,
    trackIds: [],
    current: null,
    scores: {},
    playerRuns: {},
    roundRecap: [],
    songMeta: {},
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

function syncOn(room) {
  return room.settings.syncReveal !== false;
}

function emptyProgress() {
  return {
    text: '',
    correct: false,
    points: 0,
    stageIndex: 0,
    done: false,
    giveUp: false,
    at: null,
  };
}

function emptyRun() {
  return { roundIndex: 0, matchDone: false, progress: emptyProgress() };
}

function ensureRun(room, socketId) {
  if (!room.playerRuns[socketId]) room.playerRuns[socketId] = emptyRun();
  return room.playerRuns[socketId];
}

function ensureProgress(room, socketId) {
  if (syncOn(room)) {
    if (!room.current) return null;
    if (!room.current.guesses[socketId]) room.current.guesses[socketId] = emptyProgress();
    return room.current.guesses[socketId];
  }
  return ensureRun(room, socketId).progress;
}

function rememberSong(room, song) {
  if (!song || !song.id) return;
  room.songMeta[song.id] = {
    id: song.id,
    title: song.title,
    artist: song.artist,
    cueStartSec: Number(song.cueStartSec) || 0,
  };
}

function songAt(room, roundIndex) {
  const songId = room.trackIds[roundIndex];
  return room.songMeta[songId] || { id: songId, title: '?', artist: '', cueStartSec: 0 };
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected !== false);
}

function allMatchDone(room) {
  const connected = connectedPlayers(room);
  return connected.length > 0 && connected.every((p) => room.playerRuns[p.id] && room.playerRuns[p.id].matchDone);
}

function upsertRecap(room, roundIndex, song, playerResult) {
  let entry = room.roundRecap.find((r) => r.round === roundIndex + 1 && r.songId === song.id);
  if (!entry) {
    entry = { round: roundIndex + 1, songId: song.id, title: song.title, artist: song.artist, results: [] };
    room.roundRecap.push(entry);
  }
  const idx = entry.results.findIndex((r) => r.playerId === playerResult.playerId);
  if (idx >= 0) entry.results[idx] = playerResult;
  else entry.results.push(playerResult);
  room.roundRecap.sort((a, b) => a.round - b.round || String(a.songId).localeCompare(String(b.songId)));
}

function recordRecap(room, socketId, roundIndex, song, progress) {
  const player = room.players.find((p) => p.id === socketId);
  upsertRecap(room, roundIndex, song, {
    playerId: socketId,
    name: (player && player.name) || 'Spieler',
    points: progress.points || 0,
    correct: !!progress.correct,
    giveUp: !!progress.giveUp,
    stageIndex: progress.stageIndex || 0,
  });
}

function finalizeSyncRecap(room) {
  if (!room.current) return;
  const song = { id: room.current.songId, title: room.current.title, artist: room.current.artist };
  for (const p of connectedPlayers(room)) {
    recordRecap(room, p.id, room.roundIndex, song, room.current.guesses[p.id] || emptyProgress());
  }
}

function publicState(room, forSocketId) {
  if (forSocketId === undefined) forSocketId = null;
  const sync = syncOn(room);
  let currentPublic = null;

  if (sync && room.current) {
    const me = forSocketId ? ensureProgress(room, forSocketId) : null;
    const myStage = me ? Number(me.stageIndex) || 0 : 0;
    const showAnswer = !!room.current.revealed;
    currentPublic = {
      round: room.roundIndex + 1,
      totalRounds: room.totalRounds,
      songId: room.current.songId,
      cueStartSec: room.current.cueStartSec,
      stageIndex: myStage,
      stageSeconds: CLIP_STAGES[myStage] != null ? CLIP_STAGES[myStage] : null,
      stages: CLIP_STAGES,
      revealed: !!room.current.revealed,
      revealedForMe: showAnswer,
      title: showAnswer ? room.current.title : null,
      artist: showAnswer ? room.current.artist : null,
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
      playersDone: Object.values(room.current.guesses || {}).filter((g) => g.done).length,
      matchDone: false,
      waitingForOthers: false,
    };
  } else if (!sync && forSocketId && (room.phase === 'playing' || room.phase === 'finished')) {
    const run = ensureRun(room, forSocketId);
    const song = songAt(room, Math.min(run.roundIndex, Math.max(0, room.totalRounds - 1)));
    const me = run.progress;
    const myStage = Number(me.stageIndex) || 0;
    currentPublic = {
      round: Math.min(run.roundIndex + 1, room.totalRounds),
      totalRounds: room.totalRounds,
      songId: run.matchDone ? null : song.id,
      cueStartSec: run.matchDone ? 0 : song.cueStartSec,
      stageIndex: myStage,
      stageSeconds: CLIP_STAGES[myStage] != null ? CLIP_STAGES[myStage] : null,
      stages: CLIP_STAGES,
      revealed: false,
      revealedForMe: false,
      title: null,
      artist: null,
      myGuess: {
        text: me.text,
        correct: !!me.correct,
        points: me.points || 0,
        stageIndex: myStage,
        done: !!me.done,
        giveUp: !!me.giveUp,
      },
      playersDone: connectedPlayers(room).filter((p) => room.playerRuns[p.id] && room.playerRuns[p.id].matchDone).length,
      matchDone: !!run.matchDone,
      waitingForOthers: !!run.matchDone && room.phase === 'playing',
    };
  }

  return {
    code: room.code,
    partyId: room.partyId,
    solo: !!room.solo,
    phase: room.phase,
    hostId: room.hostId,
    settings: { rounds: room.settings.rounds, syncReveal: sync },
    players: room.players.map(publicPlayer),
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    current: currentPublic,
    leaderboard: room.players
      .map((p) => ({ id: p.id, name: p.name, score: p.score || 0 }))
      .slice()
      .sort((a, b) => b.score - a.score),
    roundRecap: room.phase === 'finished' ? room.roundRecap : [],
  };
}

function migrateMapKey(map, oldId, newId) {
  if (!map || map[oldId] == null) return;
  map[newId] = map[oldId];
  delete map[oldId];
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
    migrateMapKey(room.scores, oldId, socketId);
    migrateMapKey(room.playerRuns, oldId, socketId);
    if (room.current && room.current.guesses && room.current.guesses[oldId]) {
      room.current.guesses[socketId] = room.current.guesses[oldId];
      delete room.current.guesses[oldId];
    }
    for (const entry of room.roundRecap || []) {
      for (const r of entry.results || []) {
        if (r.playerId === oldId) r.playerId = socketId;
      }
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
  delete room.playerRuns[socketId];
  let hostLeft = false;
  if (room.hostId === socketId) {
    hostLeft = true;
    room.hostId = room.players[0] ? room.players[0].id : null;
    room.hostSocketId = room.hostId;
  }
  if (!syncOn(room) && room.phase === 'playing' && allMatchDone(room)) room.phase = 'finished';
  return { empty: room.players.length === 0, hostLeft };
}

function softDisconnect(room, socketId) {
  const p = room.players.find((x) => x.id === socketId);
  if (!p) return;
  p.connected = false;
  p.disconnectedAt = Date.now();
  room.lastActivity = Date.now();
  if (!syncOn(room) && room.phase === 'playing' && allMatchDone(room)) room.phase = 'finished';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function beginRound(room, playableSongs) {
  const songId = room.trackIds[room.roundIndex];
  const song = playableSongs.find((s) => s.id === songId) || playableSongs[0];
  if (!song) return { error: 'Song fehlt.' };
  rememberSong(room, song);
  room.current = {
    songId: song.id,
    title: song.title,
    artist: song.artist,
    cueStartSec: Number(song.cueStartSec) || 0,
    guesses: {},
    revealed: false,
    startedAt: Date.now(),
  };
  for (const p of room.players) {
    if (p.connected !== false) ensureProgress(room, p.id);
  }
  room.phase = 'playing';
  room.lastActivity = Date.now();
  return { ok: true };
}

function startMatch(room, playableSongs) {
  if (!playableSongs.length) {
    return { error: 'Keine spielbaren Songs (Audio + gültiger Cue fehlen).' };
  }
  const rounds = Math.min(Math.max(1, Number(room.settings.rounds) || DEFAULT_ROUNDS), playableSongs.length);
  room.totalRounds = rounds;
  room.roundIndex = 0;
  room.trackIds = shuffle(playableSongs.map((s) => s.id)).slice(0, rounds);
  room.scores = {};
  room.playerRuns = {};
  room.roundRecap = [];
  room.songMeta = {};
  for (const song of playableSongs) {
    if (room.trackIds.indexOf(song.id) !== -1) rememberSong(room, song);
  }
  for (const p of room.players) {
    p.score = 0;
    p.ready = false;
    room.scores[p.id] = 0;
  }
  room.phase = 'playing';

  if (syncOn(room)) return beginRound(room, playableSongs);

  room.current = null;
  for (const p of room.players) {
    if (p.connected === false) continue;
    const run = ensureRun(room, p.id);
    run.roundIndex = 0;
    run.matchDone = false;
    run.progress = emptyProgress();
  }
  room.lastActivity = Date.now();
  return { ok: true };
}

function advanceAsyncPlayer(room, socketId) {
  const run = ensureRun(room, socketId);
  const song = songAt(room, run.roundIndex);
  recordRecap(room, socketId, run.roundIndex, song, run.progress);
  if (run.roundIndex + 1 >= room.totalRounds) {
    run.matchDone = true;
    run.progress = emptyProgress();
    run.progress.done = true;
    if (allMatchDone(room)) room.phase = 'finished';
    room.lastActivity = Date.now();
    return { ok: true, matchDone: true };
  }
  run.roundIndex += 1;
  run.progress = emptyProgress();
  room.lastActivity = Date.now();
  return { ok: true, matchDone: false, roundIndex: run.roundIndex };
}

function finishPlayerRound(room, socketId, opts) {
  opts = opts || {};
  const text = opts.text || '';
  const correct = !!opts.correct;
  const giveUp = !!opts.giveUp;
  const points = Number(opts.points) || 0;
  const stageIndex = Number(opts.stageIndex) || 0;

  if (!syncOn(room)) {
    const run = ensureRun(room, socketId);
    if (run.matchDone) return { error: 'Match bereits beendet.' };
    if (run.progress.done) return { error: 'Runde bereits beendet.' };
    run.progress.text = String(text || '').trim();
    run.progress.correct = correct;
    run.progress.points = points;
    run.progress.stageIndex = stageIndex;
    run.progress.done = true;
    run.progress.giveUp = giveUp;
    run.progress.at = Date.now();
    const advanced = advanceAsyncPlayer(room, socketId);
    return {
      ok: true,
      correct,
      points,
      giveUp,
      stageIndex,
      matchDone: !!advanced.matchDone,
      asyncAdvanced: true,
    };
  }

  const progress = ensureProgress(room, socketId);
  progress.text = String(text || '').trim();
  progress.correct = correct;
  progress.points = points;
  progress.stageIndex = stageIndex;
  progress.done = true;
  progress.giveUp = giveUp;
  progress.at = Date.now();
  room.lastActivity = Date.now();
  maybeReveal(room);
  return { ok: true, correct, points: progress.points, giveUp, stageIndex: progress.stageIndex };
}

function skipStage(room, socketId) {
  if (room.phase !== 'playing') return { error: 'Keine aktive Runde.' };

  if (!syncOn(room)) {
    const run = ensureRun(room, socketId);
    if (run.matchDone) return { error: 'Du bist durch — warte auf die anderen.' };
    const progress = run.progress;
    if (progress.done) return { error: 'Runde bereits beendet.' };
    if (progress.stageIndex >= CLIP_STAGES.length - 1) {
      return finishPlayerRound(room, socketId, { text: '', correct: false, giveUp: true, stageIndex: progress.stageIndex });
    }
    progress.stageIndex += 1;
    progress.at = Date.now();
    room.lastActivity = Date.now();
    return { ok: true, stageIndex: progress.stageIndex };
  }

  if (!room.current || room.current.revealed) return { error: 'Keine aktive Runde.' };
  const progress = ensureProgress(room, socketId);
  if (progress.done) return { error: 'Du bist in dieser Runde fertig.' };
  if (progress.stageIndex >= CLIP_STAGES.length - 1) {
    return finishPlayerRound(room, socketId, { text: '', correct: false, giveUp: true, stageIndex: progress.stageIndex });
  }
  progress.stageIndex += 1;
  progress.at = Date.now();
  room.lastActivity = Date.now();
  return { ok: true, stageIndex: progress.stageIndex };
}

function titleForPlayer(room, socketId) {
  if (syncOn(room)) return (room.current && room.current.title) || '';
  const run = ensureRun(room, socketId);
  return songAt(room, run.roundIndex).title || '';
}

function submitGuess(room, socketId, text) {
  if (room.phase !== 'playing') return { error: 'Keine aktive Runde.' };

  if (!syncOn(room)) {
    const run = ensureRun(room, socketId);
    if (run.matchDone) return { error: 'Du bist durch — warte auf die anderen.' };
    const progress = run.progress;
    if (progress.done) return { error: 'Bereits geraten.' };
    const correct = titlesMatch(text, titleForPlayer(room, socketId));
    if (correct) {
      const stageIndex = progress.stageIndex;
      const points = STAGE_POINTS[stageIndex] != null ? STAGE_POINTS[stageIndex] : 0;
      const player = room.players.find((p) => p.id === socketId);
      if (player) {
        player.score = (player.score || 0) + points;
        room.scores[socketId] = player.score;
      }
      return finishPlayerRound(room, socketId, { text, correct: true, giveUp: false, points, stageIndex });
    }
    progress.text = String(text || '').trim();
    progress.correct = false;
    progress.points = 0;
    progress.at = Date.now();
    if (progress.stageIndex >= CLIP_STAGES.length - 1) {
      return finishPlayerRound(room, socketId, { text, correct: false, giveUp: true, stageIndex: progress.stageIndex });
    }
    progress.stageIndex += 1;
    room.lastActivity = Date.now();
    return { ok: true, correct: false, stageIndex: progress.stageIndex };
  }

  if (!room.current || room.current.revealed) return { error: 'Keine aktive Runde.' };
  const progress = ensureProgress(room, socketId);
  if (progress.done) return { error: 'Bereits geraten.' };
  const correct = titlesMatch(text, room.current.title);
  if (correct) {
    const stageIndex = progress.stageIndex;
    const points = STAGE_POINTS[stageIndex] != null ? STAGE_POINTS[stageIndex] : 0;
    const player = room.players.find((p) => p.id === socketId);
    if (player) {
      player.score = (player.score || 0) + points;
      room.scores[socketId] = player.score;
    }
    return finishPlayerRound(room, socketId, { text, correct: true, giveUp: false, points, stageIndex });
  }
  progress.text = String(text || '').trim();
  progress.correct = false;
  progress.points = 0;
  progress.at = Date.now();
  if (progress.stageIndex >= CLIP_STAGES.length - 1) {
    return finishPlayerRound(room, socketId, { text, correct: false, giveUp: true, stageIndex: progress.stageIndex });
  }
  progress.stageIndex += 1;
  room.lastActivity = Date.now();
  return { ok: true, correct: false, stageIndex: progress.stageIndex };
}

function maybeReveal(room) {
  if (!room.current || !syncOn(room)) return;
  const connected = connectedPlayers(room);
  const allDone = connected.length > 0 && connected.every((p) => room.current.guesses[p.id] && room.current.guesses[p.id].done);
  if (allDone) {
    room.current.revealed = true;
    room.phase = 'reveal';
    finalizeSyncRecap(room);
  }
}

function nextRound(room, playableSongs) {
  if (!syncOn(room)) return { error: 'Im Async-Modus gibt es keine gemeinsame nächste Runde.' };
  if (room.roundIndex + 1 >= room.totalRounds) {
    room.phase = 'finished';
    room.current = room.current ? Object.assign({}, room.current, { revealed: true }) : null;
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
