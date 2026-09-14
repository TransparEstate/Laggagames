/**
 * Shared helpers: clean MJ filenames → title/id + duplicate ranking.
 */
const path = require('path');

const VERSION_JUNK = [
  /\(.*?remaster.*?\)/gi,
  /\(.*?remastered.*?\)/gi,
  /\(.*?radio edit.*?\)/gi,
  /\(.*?single version.*?\)/gi,
  /\(.*?immortal.*?\)/gi,
  /\(.*?demo.*?\)/gi,
  /\(.*?original version.*?\)/gi,
  /\(.*?album version.*?\)/gi,
  /\(.*?extended.*?\)/gi,
  /\(.*?feat\..*?\)/gi,
  /\(.*?featuring.*?\)/gi,
  /\[.*?remaster.*?\]/gi,
  /\[.*?remastered.*?\]/gi,
  /\s*-\s*remastered.*$/gi,
  /\s*-\s*radio edit.*$/gi,
];

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function cleanTitle(filename) {
  let base = path.basename(String(filename || ''), path.extname(String(filename || '')));
  try {
    base = decodeURIComponent(base);
  } catch {
    /* keep raw */
  }
  base = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  for (const re of VERSION_JUNK) base = base.replace(re, '');
  base = base.replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  return base || path.basename(String(filename || ''), path.extname(String(filename || '')));
}

function versionScore(filename) {
  const n = String(filename || '').toLowerCase();
  let score = 100;
  if (/\bdemo\b/.test(n)) score -= 40;
  if (/\bimmortal\b/.test(n)) score -= 25;
  if (/\bradio edit\b/.test(n)) score -= 15;
  if (/\bextended\b/.test(n)) score -= 10;
  if (/\bremaster/.test(n)) score += 10;
  if (/\boriginal version\b/.test(n)) score += 5;
  score -= (n.match(/\(/g) || []).length * 3;
  return score;
}

/**
 * @param {{ key: string, size?: number }[]} objects
 */
function songsFromAudioObjects(objects) {
  const best = new Map();
  for (const obj of objects) {
    const key = String(obj.key || '');
    if (!key || key.endsWith('/')) continue;
    const base = path.basename(key);
    const ext = path.extname(base).toLowerCase();
    if (!['.mp3', '.m4a', '.ogg', '.wav', '.webm', '.flac', '.aac'].includes(ext)) continue;
    const title = cleanTitle(base);
    const id = slugify(title);
    if (!id) continue;
    const score = versionScore(base);
    const size = Number(obj.size) || 0;
    const cand = {
      id,
      title,
      artist: 'Michael Jackson',
      audioKey: key,
      // Provisional: playable immediately after upload. Refine later with find-cue.
      cueStartSec: 0,
      cueQuality: 'ok',
      cueReason: 'r2-upload-default',
      hasAudio: true,
      _score: score,
      _size: size,
    };
    const prev = best.get(id);
    if (
      !prev ||
      cand._score > prev._score ||
      (cand._score === prev._score && cand._size > prev._size)
    ) {
      best.set(id, cand);
    }
  }
  return [...best.values()]
    .map(({ _score, _size, ...song }) => song)
    .sort((a, b) => a.title.localeCompare(b.title, 'en'));
}

module.exports = {
  slugify,
  cleanTitle,
  versionScore,
  songsFromAudioObjects,
};
