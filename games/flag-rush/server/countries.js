const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'assets', 'countries.json');

function normalizeKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const ALL = Array.isArray(raw.countries) ? raw.countries : [];

const byIso2 = new Map();
const keyIndex = new Map(); // normalized key → iso2

for (const c of ALL) {
  const iso2 = String(c.iso2 || '').toUpperCase();
  if (!iso2) continue;
  const entry = {
    iso2,
    iso: String(c.iso || iso2.toLowerCase()).toLowerCase(),
    de: c.de,
    en: c.en,
    keys: Array.isArray(c.keys) ? c.keys.map(normalizeKey).filter(Boolean) : [],
    difficulty: c.difficulty === 'easy' || c.difficulty === 'hard' ? c.difficulty : 'medium',
  };
  byIso2.set(iso2, entry);

  const aliases = new Set([
    normalizeKey(entry.de),
    normalizeKey(entry.en),
    normalizeKey(iso2),
    ...entry.keys,
  ]);
  for (const key of aliases) {
    if (!key) continue;
    if (!keyIndex.has(key)) keyIndex.set(key, iso2);
  }
}

const DIFFICULTY_ORDER = { easy: 0, medium: 1, hard: 2 };

function poolForDifficulty(difficulty) {
  const max = DIFFICULTY_ORDER[difficulty] != null ? DIFFICULTY_ORDER[difficulty] : 1;
  return ALL.map((c) => String(c.iso2).toUpperCase()).filter((iso2) => {
    const entry = byIso2.get(iso2);
    if (!entry) return false;
    return DIFFICULTY_ORDER[entry.difficulty] <= max;
  });
}

function resolveGuess(text) {
  const key = normalizeKey(text);
  if (!key) return null;
  const iso2 = keyIndex.get(key);
  return iso2 ? byIso2.get(iso2) || null : null;
}

function suggestNames(query, limit = 8) {
  const q = normalizeKey(query);
  if (!q || q.length < 1) return [];
  const scored = [];
  for (const c of ALL) {
    const de = normalizeKey(c.de);
    const en = normalizeKey(c.en);
    let score = 0;
    if (de.startsWith(q) || en.startsWith(q)) score = 3;
    else if (de.includes(q) || en.includes(q)) score = 2;
    else if ((c.keys || []).some((k) => normalizeKey(k).startsWith(q))) score = 1;
    if (score) scored.push({ iso2: c.iso2, de: c.de, en: c.en, score });
  }
  scored.sort((a, b) => b.score - a.score || a.de.localeCompare(b.de, 'de'));
  return scored.slice(0, limit).map(({ iso2, de, en }) => ({ iso2, de, en }));
}

function publicCountry(iso2, { reveal = false } = {}) {
  const c = byIso2.get(String(iso2 || '').toUpperCase());
  if (!c) return null;
  const base = {
    iso2: c.iso2,
    iso: c.iso,
    flagUrl: `https://flagcdn.com/w320/${c.iso}.png`,
  };
  if (reveal) {
    base.de = c.de;
    base.en = c.en;
  }
  return base;
}

function difficulties() {
  const counts = { easy: 0, medium: 0, hard: 0 };
  for (const c of ALL) {
    const d = c.difficulty === 'easy' || c.difficulty === 'hard' ? c.difficulty : 'medium';
    counts[d] += 1;
  }
  return [
    { id: 'easy', label: 'Leicht', count: counts.easy },
    { id: 'medium', label: 'Mittel', count: counts.easy + counts.medium },
    { id: 'hard', label: 'Schwer', count: ALL.length },
  ];
}

module.exports = {
  ALL,
  byIso2,
  normalizeKey,
  poolForDifficulty,
  resolveGuess,
  suggestNames,
  publicCountry,
  difficulties,
  count: ALL.length,
};
