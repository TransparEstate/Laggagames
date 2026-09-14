#!/usr/bin/env node
/**
 * Builds Border Path geo data from Natural Earth 110m Admin 0.
 * Downloads ne_raw.geojson if missing, then writes world/adjacency/aliases.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'assets', 'geo');
const INPUT = path.join(DATA, 'ne_raw.geojson');
const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

const SKIP_ADMIN = new Set(['Antarctica']);

const REMOVE_EDGES = [
  ['Poland', 'Russia'],
  ['Lithuania', 'Russia'],
  ['Spain', 'Morocco'],
  ['France', 'Brazil'],
  ['France', 'Suriname'],
];

const ADD_EDGES = [
  ['France', 'United Kingdom'],
  ['Denmark', 'Sweden'],
];

const EXTRA_ALIASES = {
  CN: ['China', 'PRC', "People's Republic of China", 'Volksrepublik China', 'China VR'],
  US: [
    'USA',
    'United States',
    'United States of America',
    'Vereinigte Staaten',
    'Vereinigte Staaten von Amerika',
    'Amerika',
  ],
  GB: [
    'UK',
    'Great Britain',
    'Britain',
    'Vereinigtes Königreich',
    'Grossbritannien',
    'Großbritannien',
    'England',
  ],
  RU: ['Russia', 'Russian Federation', 'Russland', 'Russische Föderation'],
  CZ: ['Czechia', 'Czech Republic', 'Tschechien', 'Tschechische Republik'],
  NL: ['Netherlands', 'Holland', 'Niederlande'],
  AE: ['UAE', 'United Arab Emirates', 'Vereinigte Arabische Emirate'],
  KR: ['South Korea', 'Korea', 'Republic of Korea', 'Südkorea'],
  KP: ['North Korea', 'DPRK', 'Nordkorea'],
  CD: [
    'DR Congo',
    'Democratic Republic of the Congo',
    'DRC',
    'Kongo',
    'Demokratische Republik Kongo',
    'Congo-Kinshasa',
  ],
  CG: ['Republic of the Congo', 'Congo', 'Congo-Brazzaville', 'Republik Kongo'],
  CI: ["Côte d'Ivoire", "Cote d'Ivoire", 'Ivory Coast', 'Elfenbeinküste'],
  MK: ['North Macedonia', 'Macedonia', 'Nordmazedonien', 'Mazedonien'],
  SZ: ['Eswatini', 'Swaziland', 'Swasiland'],
  TR: ['Turkey', 'Türkiye', 'Turkiye', 'Türkei'],
  BO: ['Bolivia', 'Bolivien'],
  VA: ['Vatican', 'Vatican City', 'Holy See', 'Vatikan', 'Vatikanstadt'],
  PS: ['Palestine', 'Palästina'],
  TZ: ['Tanzania', 'Tansania'],
  SY: ['Syria', 'Syrien'],
  MM: ['Myanmar', 'Burma', 'Birma'],
  CV: ['Cabo Verde', 'Cape Verde', 'Kap Verde'],
  SS: ['South Sudan', 'Südsudan'],
  SD: ['Sudan'],
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', reject);
  });
}

function simplifyRing(ring, minDist = 0.35) {
  if (!ring || ring.length < 4) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = ring[i];
    const dx = cur[0] - prev[0];
    const dy = cur[1] - prev[1];
    if (dx * dx + dy * dy >= minDist * minDist) out.push(cur);
  }
  out.push(ring[ring.length - 1]);
  if (out.length < 4) return ring;
  out[out.length - 1] = out[0];
  return out;
}

function mapCoords(coords, depth) {
  if (depth === 0) return simplifyRing(coords);
  return coords.map((c) => mapCoords(c, depth - 1));
}

function simplifyGeometry(geom) {
  if (!geom) return geom;
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: mapCoords(geom.coordinates, 1) };
  }
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: mapCoords(geom.coordinates, 2) };
  }
  return geom;
}

function flattenBoundaryPoints(geom, out = []) {
  if (!geom) return out;
  const walk = (coords, depth) => {
    if (depth === 0) {
      for (const p of coords) out.push(p);
      return;
    }
    for (const c of coords) walk(c, depth - 1);
  };
  if (geom.type === 'Polygon') walk(geom.coordinates, 1);
  else if (geom.type === 'MultiPolygon') walk(geom.coordinates, 2);
  return out;
}

function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function bboxesNear(a, b, pad = 0.5) {
  return !(a[2] + pad < b[0] || b[2] + pad < a[0] || a[3] + pad < b[1] || b[3] + pad < a[1]);
}

function vertexKeys(points, decimals = 4) {
  const keys = new Set();
  const f = 10 ** decimals;
  for (const [x, y] of points) keys.add(`${Math.round(x * f)}_${Math.round(y * f)}`);
  return keys;
}

function sharesBorder(keysA, keysB, minHits = 2) {
  let hits = 0;
  const [small, large] = keysA.size < keysB.size ? [keysA, keysB] : [keysB, keysA];
  for (const c of small) {
    if (large.has(c)) {
      hits += 1;
      if (hits >= minHits) return true;
    }
  }
  return false;
}

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

async function ensureInput() {
  if (fs.existsSync(INPUT) && fs.statSync(INPUT).size > 1000) return;
  console.log('Downloading Natural Earth…');
  await download(SOURCE_URL, INPUT);
}

async function main() {
  await ensureInput();
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const countries = [];

  for (const f of raw.features) {
    const p = f.properties || {};
    const admin = p.ADMIN || p.NAME || '';
    if (SKIP_ADMIN.has(admin)) continue;
    if (!f.geometry) continue;

    const neoId = String(p.ADM0_A3 || p.ISO_A3 || '').trim();
    let iso2 = String(p.ISO_A2_EH || p.ISO_A2 || '').trim();
    if (iso2 === '-99' || iso2 === '-9') iso2 = '';
    const nameEn = p.NAME_EN || p.NAME || admin;
    const nameDe = p.NAME_DE || nameEn;
    const rawPoints = flattenBoundaryPoints(f.geometry);
    if (rawPoints.length < 3) continue;

    countries.push({
      iso2,
      neoId: neoId && neoId !== '-99' ? neoId : null,
      admin,
      nameEn,
      nameDe,
      rawGeometry: f.geometry,
      rawPoints,
      bbox: bboxOf(rawPoints),
      keys: vertexKeys(rawPoints, 4),
    });
  }

  const byAdmin = new Map();
  for (const c of countries) {
    const prev = byAdmin.get(c.admin);
    if (!prev || (c.iso2 && !prev.iso2)) byAdmin.set(c.admin, c);
  }
  const list = [...byAdmin.values()];

  const used = new Set();
  for (const c of list) {
    let cid = c.iso2;
    if (!cid || used.has(cid)) cid = c.neoId;
    if (!cid || used.has(cid)) cid = c.admin.replace(/\s+/g, '_').slice(0, 16);
    if (used.has(cid)) cid = `${cid}_${used.size}`;
    used.add(cid);
    c.id = cid;
  }

  const adj = new Map(list.map((c) => [c.id, new Set()]));
  const idByAdmin = new Map(list.map((c) => [c.admin, c.id]));

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!bboxesNear(a.bbox, b.bbox, 0.5)) continue;
      if (!sharesBorder(a.keys, b.keys, 2)) continue;
      adj.get(a.id).add(b.id);
      adj.get(b.id).add(a.id);
    }
  }

  function resolveAdmin(name) {
    if (idByAdmin.has(name)) return idByAdmin.get(name);
    const hit = list.find((c) => c.nameEn === name || c.admin === name || c.nameDe === name);
    return hit ? hit.id : null;
  }

  for (const [aName, bName] of REMOVE_EDGES) {
    const a = resolveAdmin(aName);
    const b = resolveAdmin(bName);
    if (a && b) {
      adj.get(a)?.delete(b);
      adj.get(b)?.delete(a);
    }
  }

  for (const [aName, bName] of ADD_EDGES) {
    const a = resolveAdmin(aName);
    const b = resolveAdmin(bName);
    if (a && b) {
      adj.get(a).add(b);
      adj.get(b).add(a);
    }
  }

  const adjacency = {};
  for (const c of list) adjacency[c.id] = [...(adj.get(c.id) || [])].sort();

  const playable = list.filter((c) => adjacency[c.id].length > 0);
  const islands = list.filter((c) => adjacency[c.id].length === 0).map((c) => c.id);

  const aliases = {};
  const nameIndex = {};
  for (const c of list) {
    const names = new Set([c.nameEn, c.nameDe, c.admin, c.id]);
    for (const n of EXTRA_ALIASES[c.id] || []) names.add(n);
    const keys = [];
    for (const n of names) {
      const key = normalizeAlias(n);
      if (!key) continue;
      keys.push(key);
      if (!nameIndex[key]) nameIndex[key] = c.id;
    }
    aliases[c.id] = { en: c.nameEn, de: c.nameDe, keys: [...new Set(keys)] };
  }

  const world = {
    type: 'FeatureCollection',
    features: list.map((c) => ({
      type: 'Feature',
      properties: {
        id: c.id,
        nameEn: c.nameEn,
        nameDe: c.nameDe,
        playable: adjacency[c.id].length > 0,
      },
      geometry: simplifyGeometry(c.rawGeometry),
    })),
  };

  const meta = {
    countryCount: list.length,
    playableCount: playable.length,
    islandCount: islands.length,
    islands,
    edgeCount: Object.values(adjacency).reduce((n, arr) => n + arr.length, 0) / 2,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(DATA, 'world.geojson'), JSON.stringify(world));
  fs.writeFileSync(path.join(DATA, 'adjacency.json'), JSON.stringify(adjacency, null, 2));
  fs.writeFileSync(path.join(DATA, 'aliases.json'), JSON.stringify(aliases));
  fs.writeFileSync(path.join(DATA, 'nameIndex.json'), JSON.stringify(nameIndex));
  fs.writeFileSync(path.join(DATA, 'meta.json'), JSON.stringify(meta, null, 2));

  try {
    fs.unlinkSync(INPUT);
  } catch (_) {
    /* keep if locked */
  }

  console.log('Built:', meta);
  console.log('DE neighbors:', adjacency[resolveAdmin('Germany')]);
  console.log(
    'FR-UK:',
    adjacency[resolveAdmin('France')]?.includes(resolveAdmin('United Kingdom'))
  );
  console.log(
    'PL-RU removed:',
    !(adjacency[resolveAdmin('Poland')] || []).includes(resolveAdmin('Russia'))
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
