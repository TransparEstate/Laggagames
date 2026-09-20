const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_FILE = path.join(__dirname, '..', 'data', 'race-highscores.json');
let DATA_FILE = process.env.MJ_RACE_HS_FILE
  ? path.resolve(process.env.MJ_RACE_HS_FILE)
  : DEFAULT_DATA_FILE;
const TOP_N = 10;
const MAX_NAME = 24;

function setDataFileForTests(filePath) {
  DATA_FILE = path.resolve(filePath);
}

function emptyStore() {
  return { byRounds: {} };
}

function ensureDir() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    if (!raw.byRounds || typeof raw.byRounds !== 'object') return emptyStore();
    return { byRounds: raw.byRounds };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function sanitizeName(name) {
  return String(name || 'Spieler')
    .trim()
    .slice(0, MAX_NAME) || 'Spieler';
}

function normalizeRounds(rounds) {
  const n = Math.max(1, Math.min(20, Number(rounds) || 5));
  return Math.round(n);
}

function sortEntries(entries) {
  return entries.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.at || 0) - (b.at || 0);
  });
}

function getBoard(rounds) {
  const key = String(normalizeRounds(rounds));
  const store = loadStore();
  const entries = Array.isArray(store.byRounds[key]) ? store.byRounds[key] : [];
  return {
    rounds: normalizeRounds(rounds),
    entries: sortEntries(entries).slice(0, TOP_N),
  };
}

function listBuckets() {
  const store = loadStore();
  return Object.keys(store.byRounds)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .sort((a, b) => a - b);
}

/**
 * Insert or update a race match total into the board for `rounds`.
 * Same name (case-insensitive) keeps only the better score.
 * @returns {{ ok: boolean, entry: object, rank: number|null, isNewRecord: boolean, board: object }}
 */
function submitScore({ name, score, rounds, solo = false, at = Date.now() }) {
  const roundsN = normalizeRounds(rounds);
  const key = String(roundsN);
  const entry = {
    name: sanitizeName(name),
    score: Math.max(0, Math.round(Number(score) || 0)),
    at: Number(at) || Date.now(),
    solo: !!solo,
  };

  const store = loadStore();
  const list = Array.isArray(store.byRounds[key]) ? store.byRounds[key].slice() : [];
  const nameKey = entry.name.toLowerCase();
  const existingIdx = list.findIndex((e) => String(e.name || '').toLowerCase() === nameKey);

  let changed = false;
  if (existingIdx >= 0) {
    if (entry.score > (list[existingIdx].score || 0)) {
      list[existingIdx] = entry;
      changed = true;
    } else {
      const board = getBoard(roundsN);
      const rank = board.entries.findIndex((e) => e.name.toLowerCase() === nameKey) + 1;
      return {
        ok: true,
        entry: list[existingIdx],
        rank: rank > 0 ? rank : null,
        isNewRecord: false,
        board,
      };
    }
  } else {
    list.push(entry);
    changed = true;
  }

  const sorted = sortEntries(list).slice(0, TOP_N);
  store.byRounds[key] = sorted;
  if (changed) saveStore(store);

  const board = { rounds: roundsN, entries: sorted };
  const rank = sorted.findIndex((e) => e.name.toLowerCase() === nameKey) + 1;
  const isNewRecord = rank > 0 && rank <= TOP_N && changed;
  return { ok: true, entry, rank: rank > 0 ? rank : null, isNewRecord, board };
}

/**
 * Record all player scores from a finished race room once.
 */
function recordRaceFinish(room) {
  if (!room || room.settings?.mode !== 'race') return { ok: false, skipped: true };
  if (room.raceHighscoreRecorded) return { ok: true, already: true, results: [] };
  const rounds = room.totalRounds || room.settings?.rounds || 5;
  const solo = !!room.solo;
  const results = [];
  for (const p of room.players || []) {
    if (p.connected === false) continue;
    const res = submitScore({
      name: p.name,
      score: p.score || 0,
      rounds,
      solo,
    });
    results.push({ playerId: p.id, ...res });
  }
  room.raceHighscoreRecorded = true;
  return { ok: true, results, board: getBoard(rounds) };
}

module.exports = {
  TOP_N,
  getBoard,
  listBuckets,
  submitScore,
  recordRaceFinish,
  loadStore,
  get DATA_FILE() {
    return DATA_FILE;
  },
  setDataFileForTests,
};
