const path = require('path');
const fs = require('fs');

const DATA = path.join(__dirname, '..', 'assets', 'geo');

const adjacency = JSON.parse(fs.readFileSync(path.join(DATA, 'adjacency.json'), 'utf8'));
const aliases = JSON.parse(fs.readFileSync(path.join(DATA, 'aliases.json'), 'utf8'));
const nameIndex = JSON.parse(fs.readFileSync(path.join(DATA, 'nameIndex.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));

const DIFFICULTY = {
  easy: { id: 'easy', label: 'Leicht', minHops: 2, maxHops: 3, extraGuesses: 5, hints: 3 },
  medium: { id: 'medium', label: 'Mittel', minHops: 4, maxHops: 6, extraGuesses: 4, hints: 3 },
  hard: { id: 'hard', label: 'Schwer', minHops: 7, maxHops: 14, extraGuesses: 3, hints: 3 },
};

const HINT_STAGES = 3;

const sessions = new Map();

function normalizeAlias(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function resolveName(input) {
  const key = normalizeAlias(input);
  if (!key) return null;
  return nameIndex[key] || null;
}

function neighbors(id) {
  return adjacency[id] || [];
}

function countryLabel(id, lang = 'de') {
  const a = aliases[id];
  if (!a) return id;
  return lang === 'en' ? a.en : a.de || a.en;
}

function publicCountry(id) {
  return { id, nameDe: countryLabel(id, 'de'), nameEn: countryLabel(id, 'en') };
}

function shortestPath(start, goal) {
  if (!start || !goal) return null;
  if (start === goal) return [start];
  const queue = [start];
  const prev = new Map([[start, null]]);
  while (queue.length) {
    const cur = queue.shift();
    for (const n of neighbors(cur)) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === goal) {
        const out = [goal];
        let p = cur;
        while (p != null) {
          out.push(p);
          p = prev.get(p);
        }
        out.reverse();
        return out;
      }
      queue.push(n);
    }
  }
  return null;
}

/** Guesses still needed; start+goal free; guessed free. */
function remainingCost(start, goal, guessedSet) {
  if (start === goal) return 0;
  const unlocked = new Set(guessedSet);
  unlocked.add(start);
  unlocked.add(goal);
  const dist = new Map([[start, 0]]);
  const deque = [start];
  while (deque.length) {
    const cur = deque.shift();
    const d = dist.get(cur);
    if (cur === goal) return d;
    for (const n of neighbors(cur)) {
      const step = unlocked.has(n) ? 0 : 1;
      const nd = d + step;
      if (!dist.has(n) || nd < dist.get(n)) {
        dist.set(n, nd);
        if (step === 0) deque.unshift(n);
        else deque.push(n);
      }
    }
  }
  return Infinity;
}

/**
 * Min guesses on a path forced through `via`
 * (via itself counts as one guess if not already guessed).
 */
function costThrough(start, goal, guessedSet, via) {
  if (via === start || via === goal) return remainingCost(start, goal, guessedSet);
  const withVia = new Set(guessedSet);
  withVia.add(via);
  const payVia = guessedSet.has(via) ? 0 : 1;
  const toVia = remainingCost(start, via, guessedSet);
  const fromVia = remainingCost(via, goal, withVia);
  if (!Number.isFinite(toVia) || !Number.isFinite(fromVia)) return Infinity;
  return toVia + payVia + fromVia;
}

function startComponent(start, guessedSet) {
  const unlocked = new Set(guessedSet);
  unlocked.add(start);
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const n of neighbors(cur)) {
      if (!unlocked.has(n) || seen.has(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function playableIds() {
  return Object.keys(adjacency).filter((id) => neighbors(id).length > 0);
}

function generatePair(difficultyId) {
  const cfg = DIFFICULTY[difficultyId] || DIFFICULTY.medium;
  const ids = playableIds();
  const candidates = [];
  for (let i = 0; i < 1200 && candidates.length < 60; i++) {
    const a = pickRandom(ids);
    const b = pickRandom(ids);
    if (a === b) continue;
    const path = shortestPath(a, b);
    if (!path) continue;
    const hops = path.length - 2;
    if (hops < cfg.minHops || hops > cfg.maxHops) continue;
    candidates.push({ start: a, goal: b, path, hops });
  }
  if (!candidates.length) {
    for (let i = 0; i < 4000 && candidates.length < 25; i++) {
      const a = pickRandom(ids);
      const b = pickRandom(ids);
      if (a === b) continue;
      const path = shortestPath(a, b);
      if (!path) continue;
      const hops = path.length - 2;
      if (hops >= 2 && hops <= 14) candidates.push({ start: a, goal: b, path, hops });
    }
  }
  if (!candidates.length) throw new Error('Kein Puzzle gefunden.');
  return pickRandom(candidates);
}

function createSharedPuzzle(difficultyId) {
  const pair = generatePair(difficultyId);
  return {
    difficulty: (DIFFICULTY[difficultyId] || DIFFICULTY.medium).id,
    start: pair.start,
    goal: pair.goal,
    path: [...pair.path],
    hops: pair.hops,
  };
}

function createRoundFromPuzzle(puzzle, difficultyId) {
  const cfg = DIFFICULTY[difficultyId || puzzle.difficulty] || DIFFICULTY.medium;
  return {
    difficulty: cfg.id,
    start: puzzle.start,
    goal: puzzle.goal,
    path: [...puzzle.path],
    hops: puzzle.hops,
    guessesLeft: puzzle.hops + cfg.extraGuesses,
    hintsLeft: cfg.hints,
    hintsUsed: 0,
    hintTargetId: null,
    hintStage: 0,
    guesses: [],
    revealedHintIds: [],
    hintDisplay: null,
    status: 'playing',
    perfect: false,
    orderedOptimal: true,
    nextOptimalIndex: 1,
    startedAt: Date.now(),
    finishedAt: null,
  };
}

function createSessionId() {
  return `bp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  const id = createSessionId();
  const session = { id, round: null, createdAt: Date.now() };
  sessions.set(id, session);
  return session;
}

function hintPatternFor(id, stage) {
  const name = countryLabel(id, 'de');
  const initial = name.charAt(0).toUpperCase();
  const length = name.length;
  if (stage <= 1) {
    return { initial, length, pattern: `${initial}…`, stage: 1 };
  }
  const dots = '·'.repeat(Math.max(0, length - 1));
  return { initial, length, pattern: `${initial}${dots}`, stage: Math.min(stage, HINT_STAGES) };
}

function pickHintTarget(r) {
  const guessedSet = new Set(r.guesses.map((g) => g.id));
  const component = startComponent(r.start, guessedSet);
  const path = shortestPath(r.start, r.goal) || r.path;
  const remainers = path.filter(
    (id) => id !== r.start && id !== r.goal && !guessedSet.has(id)
  );

  for (const id of remainers) {
    if (neighbors(id).some((n) => component.has(n))) return id;
  }
  return remainers[0] || null;
}

function serializeRoundState(r, sessionId = null) {
  if (!r) return sessionId ? { sessionId, round: null } : null;
  const guessedIds = r.guesses.map((g) => g.id);
  return {
    sessionId: sessionId || null,
    difficulty: r.difficulty,
    start: publicCountry(r.start),
    goal: publicCountry(r.goal),
    hops: r.hops,
    optimalPath: r.status !== 'playing' ? r.path.map((id) => publicCountry(id)) : null,
    guessesLeft: r.guessesLeft,
    guessesUsed: r.guesses.length,
    hintsLeft: r.hintsLeft,
    hintsUsed: r.hintsUsed || 0,
    hintStage: r.hintStage || 0,
    hintTargetId: r.hintTargetId || null,
    hintDisplay: r.hintDisplay || null,
    status: r.status,
    perfect: !!r.perfect,
    remaining:
      r.status === 'playing' ? remainingCost(r.start, r.goal, new Set(guessedIds)) : 0,
    guesses: r.guesses.map((g) => ({
      id: g.id,
      nameDe: countryLabel(g.id, 'de'),
      nameEn: countryLabel(g.id, 'en'),
      quality: g.quality,
      frontier: !!g.frontier,
    })),
    revealedHintIds: [...(r.revealedHintIds || [])],
    startedAt: r.startedAt || null,
    finishedAt: r.finishedAt || null,
  };
}

function serializeRound(session) {
  const r = session.round;
  if (!r) return { sessionId: session.id, round: null };
  return serializeRoundState(r, session.id);
}

function newRound(session, difficulty = 'medium') {
  const puzzle = createSharedPuzzle(difficulty);
  session.round = createRoundFromPuzzle(puzzle, puzzle.difficulty);
  return serializeRound(session);
}

function markFinished(r) {
  if (!r.finishedAt) r.finishedAt = Date.now();
}

function applyGuessToRound(r, rawName) {
  if (!r) return { error: 'Keine Runde. Starte zuerst.' };
  if (r.status !== 'playing') return { error: 'Runde ist beendet.' };

  const id = resolveName(rawName);
  if (!id) return { error: 'Land nicht erkannt.', code: 'unknown' };
  if (id === r.start || id === r.goal) {
    return { error: 'Start und Ziel zählen nicht als Tipp.', code: 'endpoint' };
  }
  if (r.guesses.some((g) => g.id === id)) {
    return { error: 'Bereits geraten.', code: 'duplicate' };
  }
  if (!adjacency[id]) return { error: 'Land nicht spielbar.', code: 'unknown' };

  const guessedSet = new Set(r.guesses.map((g) => g.id));
  const before = remainingCost(r.start, r.goal, guessedSet);
  const after = remainingCost(r.start, r.goal, new Set([...guessedSet, id]));
  const through = costThrough(r.start, r.goal, guessedSet, id);
  const component = startComponent(r.start, guessedSet);
  const onFrontier = neighbors(id).some((n) => component.has(n));

  let quality = 'red';
  let frontier = false;
  if (after < before) {
    quality = 'green';
    frontier = onFrontier;
  } else if (Number.isFinite(through) && through <= before + 1) {
    quality = 'orange';
  }

  if (r.orderedOptimal) {
    const expected = r.path[r.nextOptimalIndex];
    if (id === expected) r.nextOptimalIndex += 1;
    else r.orderedOptimal = false;
  }

  r.guesses.push({ id, quality, frontier });
  r.guessesLeft -= 1;

  if (r.hintTargetId === id) {
    r.hintTargetId = null;
    r.hintStage = 0;
    r.hintDisplay = null;
  }
  r.revealedHintIds = (r.revealedHintIds || []).filter((hid) => hid !== id);

  const nowRemain = remainingCost(r.start, r.goal, new Set(r.guesses.map((g) => g.id)));
  if (nowRemain === 0) {
    r.status = 'won';
    r.perfect = r.orderedOptimal && r.guesses.length === r.hops;
    markFinished(r);
  } else if (r.guessesLeft <= 0) {
    r.status = 'lost';
    markFinished(r);
  }

  return {
    ok: true,
    guess: {
      id,
      nameDe: countryLabel(id, 'de'),
      nameEn: countryLabel(id, 'en'),
      quality,
      frontier,
    },
  };
}

function applyGuess(session, rawName) {
  const r = session.round;
  if (!r) return { error: 'Keine Runde. Starte zuerst.' };
  const result = applyGuessToRound(r, rawName);
  if (result.error) {
    return { ...result, state: serializeRound(session) };
  }
  return { ok: true, guess: result.guess, state: serializeRound(session) };
}

function applyHintToRound(r) {
  if (!r) return { error: 'Keine Runde.' };
  if (r.status !== 'playing') return { error: 'Runde beendet.' };
  if (r.hintsLeft <= 0) return { error: 'Keine Hinweise mehr.', code: 'no_hints' };

  const pick = pickHintTarget(r);
  if (!pick) return { error: 'Kein Hinweis möglich.', code: 'no_target' };

  if (r.hintTargetId !== pick) {
    r.hintTargetId = pick;
    r.hintStage = 0;
  }
  if (r.hintStage >= HINT_STAGES) {
    return { error: 'Maximale Hinweisstufe erreicht.', code: 'max_stage' };
  }

  r.hintsLeft -= 1;
  r.hintsUsed = (r.hintsUsed || 0) + 1;
  r.hintStage += 1;

  const display = hintPatternFor(pick, r.hintStage);
  r.hintDisplay = {
    stage: r.hintStage,
    targetId: pick,
    initial: display.initial,
    length: display.length,
    pattern: display.pattern,
  };

  if (r.hintStage >= 3) {
    if (!r.revealedHintIds.includes(pick)) r.revealedHintIds.push(pick);
  } else {
    r.revealedHintIds = (r.revealedHintIds || []).filter((id) => id !== pick);
  }

  return {
    ok: true,
    hint: {
      stage: r.hintStage,
      targetId: pick,
      revealId: r.hintStage >= 3 ? pick : null,
      initial: display.initial,
      length: display.length,
      pattern: display.pattern,
    },
  };
}

function applyHint(session) {
  const r = session.round;
  if (!r) return { error: 'Keine Runde.' };
  const result = applyHintToRound(r);
  if (result.error) {
    return { ...result, state: serializeRound(session) };
  }
  return { ok: true, hint: result.hint, state: serializeRound(session) };
}

function scoreVersusPlayer(round) {
  if (!round) return { score: 0, finishTimeMs: null };
  let score = 0;
  if (round.status === 'won') {
    score += 100;
    if (round.perfect) score += 25;
    score += Math.max(0, round.guessesLeft) * 10;
  }
  for (const g of round.guesses || []) {
    if (g.quality === 'green') score += 5;
    else if (g.quality === 'red') score -= 5;
  }
  score -= (round.hintsUsed || 0) * 8;
  score = Math.max(0, score);
  const finishTimeMs =
    round.finishedAt && round.startedAt ? round.finishedAt - round.startedAt : null;
  return { score, finishTimeMs };
}

function rankVersusPlayers(entries) {
  return [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = a.finishTimeMs == null ? Number.POSITIVE_INFINITY : a.finishTimeMs;
    const tb = b.finishTimeMs == null ? Number.POSITIVE_INFINITY : b.finishTimeMs;
    return ta - tb;
  });
}

function suggestNames(query, limit = 8) {
  const q = normalizeAlias(query);
  if (!q) return [];
  const byId = new Map();
  for (const [key, id] of Object.entries(nameIndex)) {
    if (!key.includes(q)) continue;
    const score = key.startsWith(q) ? 0 : 1;
    const prev = byId.get(id);
    if (!prev || score < prev.score) {
      byId.set(id, {
        id,
        nameDe: countryLabel(id, 'de'),
        nameEn: countryLabel(id, 'en'),
        score,
      });
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.score - b.score || a.nameDe.length - b.nameDe.length)
    .slice(0, limit)
    .map(({ id, nameDe, nameEn }) => ({ id, nameDe, nameEn }));
}

function difficulties() {
  return Object.values(DIFFICULTY).map((d) => ({
    id: d.id,
    label: d.label,
    minHops: d.minHops,
    maxHops: d.maxHops,
    hints: d.hints,
    extraGuesses: d.extraGuesses,
  }));
}

module.exports = {
  DIFFICULTY,
  HINT_STAGES,
  meta,
  adjacency,
  aliases,
  nameIndex,
  normalizeAlias,
  resolveName,
  shortestPath,
  remainingCost,
  costThrough,
  getOrCreateSession,
  newRound,
  applyGuess,
  applyHint,
  applyGuessToRound,
  applyHintToRound,
  serializeRound,
  serializeRoundState,
  createSharedPuzzle,
  createRoundFromPuzzle,
  scoreVersusPlayer,
  rankVersusPlayers,
  suggestNames,
  difficulties,
  countryLabel,
  sessions,
};
