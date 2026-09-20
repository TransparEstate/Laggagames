const countries = require('./countries');

const DEFAULT_ROUNDS = 10;
const ROUND_OPTIONS = [5, 10, 15];
const RACE_WINDOW_MS = 20000;
const RACE_MAX_POINTS = 100;
const RACE_MIN_POINTS = 10;
const RACE_FIRST_BONUS = 25;
const BETWEEN_MS = 2500;
const REVEAL_MS = 2200;

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
      difficulty: 'medium',
    },
    roundIndex: 0,
    totalRounds: DEFAULT_ROUNDS,
    flagIds: [],
    current: null,
    scores: {},
    roundRecap: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    _timers: {},
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

function racePointsForElapsed(elapsedMs) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const t = Math.min(1, elapsed / RACE_WINDOW_MS);
  return Math.max(RACE_MIN_POINTS, Math.round(RACE_MAX_POINTS * (1 - t)));
}

function emptyGuess() {
  return {
    text: '',
    correct: false,
    points: 0,
    basePoints: 0,
    bonusPoints: 0,
    done: false,
    reactionMs: null,
    firstBonus: false,
    attempts: [],
  };
}

function pushAttempt(guess, text, correct) {
  if (!guess) return;
  if (!Array.isArray(guess.attempts)) guess.attempts = [];
  const t = String(text || '').trim().slice(0, 80);
  if (!t) return;
  const last = guess.attempts[guess.attempts.length - 1];
  if (last && last.text === t && !!last.correct === !!correct) return;
  guess.attempts.push({ text: t, correct: !!correct, at: Date.now() });
  if (guess.attempts.length > 20) guess.attempts = guess.attempts.slice(-20);
}

function connectedPlayers(room) {
  return room.players.filter((p) => p.connected !== false);
}

function addPlayer(room, socketId, name) {
  room.lastActivity = Date.now();
  const existing = room.players.find((p) => p.id === socketId);
  if (existing) {
    existing.name = String(name || existing.name || 'Spieler').slice(0, 24);
    existing.connected = true;
    return { player: existing, reclaimed: true };
  }
  // Reclaim by name if soft-disconnected
  const soft = room.players.find(
    (p) => p.connected === false && p.name === String(name || '').trim()
  );
  if (soft) {
    soft.id = socketId;
    soft.connected = true;
    soft.name = String(name || soft.name || 'Spieler').slice(0, 24);
    if (room.hostId === soft.id || room.hostSocketId === soft.id) {
      room.hostId = socketId;
      room.hostSocketId = socketId;
    }
    return { player: soft, reclaimed: true };
  }
  if (room.players.length >= 12) return { error: 'Raum voll (max. 12).' };
  const player = {
    id: socketId,
    name: String(name || 'Spieler').trim().slice(0, 24) || 'Spieler',
    ready: false,
    connected: true,
    score: room.scores[socketId] || 0,
  };
  room.players.push(player);
  if (!room.hostId) {
    room.hostId = socketId;
    room.hostSocketId = socketId;
  }
  return { player };
}

function softDisconnect(room, socketId) {
  const p = room.players.find((x) => x.id === socketId);
  if (p) p.connected = false;
  room.lastActivity = Date.now();
}

function removePlayer(room, socketId) {
  const idx = room.players.findIndex((p) => p.id === socketId);
  if (idx < 0) return { empty: room.players.length === 0 };
  const wasHost = room.hostId === socketId;
  room.players.splice(idx, 1);
  if (wasHost) {
    const next = connectedPlayers(room)[0] || room.players[0] || null;
    room.hostId = next ? next.id : null;
    room.hostSocketId = room.hostId;
  }
  return { empty: room.players.length === 0, hostLeft: wasHost };
}

function setRounds(room, socketId, rounds) {
  if (room.hostId !== socketId) return { error: 'Nur der Host.' };
  if (room.phase !== 'lobby') return { error: 'Nur in der Lobby.' };
  const n = Number(rounds);
  if (!ROUND_OPTIONS.includes(n)) return { error: 'Ungültige Rundenzahl.' };
  room.settings.rounds = n;
  room.totalRounds = n;
  room.lastActivity = Date.now();
  return { ok: true };
}

function setDifficulty(room, socketId, difficulty) {
  if (room.hostId !== socketId) return { error: 'Nur der Host.' };
  if (room.phase !== 'lobby') return { error: 'Nur in der Lobby.' };
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return { error: 'Ungültige Schwierigkeit.' };
  }
  room.settings.difficulty = difficulty;
  room.lastActivity = Date.now();
  return { ok: true };
}

function setReady(room, socketId, ready) {
  const p = room.players.find((x) => x.id === socketId);
  if (!p) return { error: 'Spieler nicht gefunden.' };
  if (room.phase !== 'lobby') return { error: 'Nur in der Lobby.' };
  p.ready = !!ready;
  room.lastActivity = Date.now();
  return { ok: true };
}

function pickFlags(difficulty, rounds) {
  const pool = countries.poolForDifficulty(difficulty);
  if (pool.length < 1) throw new Error('Kein Länderpool.');
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = Math.min(rounds, shuffled.length);
  return shuffled.slice(0, n);
}

function beginMatch(room) {
  if (room.phase !== 'lobby' && room.phase !== 'finished') {
    return { error: 'Spiel läuft bereits.' };
  }
  const connected = connectedPlayers(room);
  if (connected.length < 1) return { error: 'Keine Spieler.' };
  if (!room.solo) {
    const notReady = connected.filter((p) => p.id !== room.hostId && !p.ready);
    if (notReady.length) {
      return { error: `Noch nicht ready: ${notReady.map((p) => p.name).join(', ')}` };
    }
  }

  const rounds = room.settings.rounds || DEFAULT_ROUNDS;
  room.totalRounds = rounds;
  room.flagIds = pickFlags(room.settings.difficulty || 'medium', rounds);
  room.roundIndex = 0;
  room.roundRecap = [];
  room.scores = {};
  for (const p of room.players) {
    p.score = 0;
    p.ready = false;
    room.scores[p.id] = 0;
  }
  room.current = null;
  room.phase = 'playing';
  room.lastActivity = Date.now();
  startRound(room);
  return { ok: true };
}

function startRound(room) {
  const iso2 = room.flagIds[room.roundIndex];
  const meta = countries.byIso2.get(iso2);
  if (!meta) throw new Error(`Unbekanntes Land: ${iso2}`);
  const now = Date.now();
  const guesses = {};
  for (const p of connectedPlayers(room)) {
    guesses[p.id] = emptyGuess();
  }
  room.current = {
    iso2,
    de: meta.de,
    en: meta.en,
    iso: meta.iso,
    playAt: now,
    endsAt: now + RACE_WINDOW_MS,
    revealed: false,
    firstCorrectId: null,
    firstCorrectAt: null,
    guesses,
  };
  room.phase = 'playing';
  room.lastActivity = now;
}

function raceStandings(room) {
  if (!room.current) return [];
  const rows = [];
  for (const p of room.players) {
    const g = room.current.guesses[p.id];
    if (!g || !g.correct) continue;
    rows.push({
      id: p.id,
      name: p.name,
      points: g.points || 0,
      basePoints: g.basePoints != null ? g.basePoints : g.points || 0,
      bonusPoints: g.bonusPoints || 0,
      reactionMs: g.reactionMs,
      firstBonus: !!g.firstBonus,
    });
  }
  rows.sort((a, b) => {
    if (a.reactionMs == null && b.reactionMs == null) return b.points - a.points;
    if (a.reactionMs == null) return 1;
    if (b.reactionMs == null) return -1;
    return a.reactionMs - b.reactionMs || b.points - a.points;
  });
  return rows;
}

function allGuessesDone(room) {
  if (!room.current) return false;
  const connected = connectedPlayers(room);
  if (!connected.length) return false;
  return connected.every((p) => {
    const g = room.current.guesses[p.id];
    return g && g.done;
  });
}

function recordRecap(room) {
  if (!room.current) return;
  const entry = {
    round: room.roundIndex + 1,
    iso2: room.current.iso2,
    de: room.current.de,
    en: room.current.en,
    results: [],
  };
  for (const p of room.players) {
    const g = room.current.guesses[p.id] || emptyGuess();
    entry.results.push({
      playerId: p.id,
      name: p.name,
      points: g.points || 0,
      basePoints: g.basePoints || 0,
      bonusPoints: g.bonusPoints || 0,
      correct: !!g.correct,
      reactionMs: g.reactionMs,
      firstBonus: !!g.firstBonus,
      text: g.text || '',
    });
  }
  entry.results.sort((a, b) => {
    if (a.correct !== b.correct) return a.correct ? -1 : 1;
    if (a.reactionMs == null) return 1;
    if (b.reactionMs == null) return -1;
    return a.reactionMs - b.reactionMs;
  });
  room.roundRecap.push(entry);
}

function revealRound(room) {
  if (!room.current || room.current.revealed) return;
  room.current.revealed = true;
  room.phase = 'reveal';
  for (const p of connectedPlayers(room)) {
    const g = room.current.guesses[p.id] || emptyGuess();
    g.done = true;
    room.current.guesses[p.id] = g;
  }
  recordRecap(room);
  room.lastActivity = Date.now();
}

function advanceAfterReveal(room) {
  if (room.roundIndex + 1 >= room.totalRounds) {
    room.phase = 'finished';
    room.current = room.current
      ? { ...room.current, revealed: true }
      : null;
    room.lastActivity = Date.now();
    return { finished: true };
  }
  room.roundIndex += 1;
  startRound(room);
  return { next: true };
}

function rematch(room) {
  room.phase = 'lobby';
  room.current = null;
  room.roundIndex = 0;
  room.flagIds = [];
  room.roundRecap = [];
  room.scores = {};
  for (const p of room.players) {
    p.score = 0;
    p.ready = false;
  }
  room.lastActivity = Date.now();
  return { ok: true };
}

function submitGuess(room, socketId, text) {
  if (room.phase !== 'playing' || !room.current || room.current.revealed) {
    return { error: 'Gerade nicht raten.' };
  }
  const player = room.players.find((p) => p.id === socketId);
  if (!player || player.connected === false) return { error: 'Spieler fehlt.' };

  let guess = room.current.guesses[socketId];
  if (!guess) {
    guess = emptyGuess();
    room.current.guesses[socketId] = guess;
  }
  if (guess.done || guess.correct) return { error: 'Schon fertig.', guess };

  const raw = String(text || '').trim();
  if (!raw) return { error: 'Leere Antwort.' };

  const now = Date.now();
  if (now > room.current.endsAt) {
    guess.done = true;
    return { error: 'Zeit abgelaufen.', timedOut: true };
  }

  const resolved = countries.resolveGuess(raw);
  const correct = !!(resolved && resolved.iso2 === room.current.iso2);
  pushAttempt(guess, raw, correct);
  guess.text = raw;

  if (!correct) {
    room.lastActivity = now;
    return { ok: true, correct: false, guess: publicGuess(guess) };
  }

  const elapsed = Math.max(0, now - room.current.playAt);
  const base = racePointsForElapsed(elapsed);
  let bonus = 0;
  let firstBonus = false;
  if (!room.current.firstCorrectId) {
    room.current.firstCorrectId = socketId;
    room.current.firstCorrectAt = now;
    bonus = RACE_FIRST_BONUS;
    firstBonus = true;
  }
  guess.correct = true;
  guess.done = true;
  guess.basePoints = base;
  guess.bonusPoints = bonus;
  guess.points = base + bonus;
  guess.reactionMs = elapsed;
  guess.firstBonus = firstBonus;

  player.score = (player.score || 0) + guess.points;
  room.scores[socketId] = player.score;
  room.lastActivity = now;

  return {
    ok: true,
    correct: true,
    firstBonus,
    guess: publicGuess(guess),
    allDone: allGuessesDone(room),
  };
}

function publicGuess(g) {
  if (!g) return null;
  return {
    text: g.text || '',
    correct: !!g.correct,
    points: g.points || 0,
    basePoints: g.basePoints || 0,
    bonusPoints: g.bonusPoints || 0,
    done: !!g.done,
    reactionMs: g.reactionMs,
    firstBonus: !!g.firstBonus,
    attempts: Array.isArray(g.attempts) ? g.attempts : [],
  };
}

function ranking(room) {
  return [...room.players]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score || 0,
      connected: p.connected !== false,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'));
}

function publicState(room, forSocketId = null) {
  const now = Date.now();
  let currentPublic = null;
  if (room.current) {
    const me = forSocketId ? room.current.guesses[forSocketId] : null;
    const showAnswer = !!room.current.revealed || room.phase === 'finished';
    let pointsPreview = null;
    if (room.phase === 'playing' && !showAnswer && me && !me.done) {
      pointsPreview = racePointsForElapsed(Math.max(0, now - room.current.playAt));
    }
    currentPublic = {
      round: room.roundIndex + 1,
      totalRounds: room.totalRounds,
      iso2: room.current.iso2,
      iso: room.current.iso,
      flagUrl: `https://flagcdn.com/w320/${room.current.iso}.png`,
      revealed: showAnswer,
      de: showAnswer ? room.current.de : null,
      en: showAnswer ? room.current.en : null,
      myGuess: publicGuess(me),
      playersDone: Object.values(room.current.guesses || {}).filter((g) => g.done).length,
      playAt: room.current.playAt,
      endsAt: room.current.endsAt,
      raceWindowMs: RACE_WINDOW_MS,
      firstBonusAwarded: !!room.current.firstCorrectId,
      firstCorrectAt: room.current.firstCorrectAt,
      pointsPreview,
      standings: raceStandings(room),
      serverNow: now,
    };
  }

  const rank = ranking(room);
  const winner = room.phase === 'finished' && rank[0] ? rank[0] : null;

  return {
    code: room.code,
    partyId: room.partyId,
    solo: !!room.solo,
    phase: room.phase,
    hostId: room.hostId,
    youAreHost: forSocketId != null && forSocketId === room.hostId,
    players: room.players.map(publicPlayer),
    settings: { ...room.settings },
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    current: currentPublic,
    ranking: rank,
    winner,
    roundRecap: room.roundRecap,
    meta: {
      raceWindowMs: RACE_WINDOW_MS,
      maxPoints: RACE_MAX_POINTS,
      minPoints: RACE_MIN_POINTS,
      firstBonus: RACE_FIRST_BONUS,
      roundOptions: ROUND_OPTIONS,
      difficulties: countries.difficulties(),
      countryCount: countries.count,
    },
    serverNow: now,
  };
}

module.exports = {
  DEFAULT_ROUNDS,
  ROUND_OPTIONS,
  RACE_WINDOW_MS,
  RACE_MAX_POINTS,
  RACE_MIN_POINTS,
  RACE_FIRST_BONUS,
  BETWEEN_MS,
  REVEAL_MS,
  createEmptyRoom,
  addPlayer,
  softDisconnect,
  removePlayer,
  setRounds,
  setDifficulty,
  setReady,
  beginMatch,
  startRound,
  submitGuess,
  revealRound,
  advanceAfterReveal,
  rematch,
  allGuessesDone,
  publicState,
  ranking,
};
