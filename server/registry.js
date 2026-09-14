const fs = require('fs');
const path = require('path');

const GAMES_ROOT = path.join(__dirname, '..', 'games');

function listGames() {
  if (!fs.existsSync(GAMES_ROOT)) return [];
  return fs
    .readdirSync(GAMES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => {
      const dir = path.join(GAMES_ROOT, d.name);
      const metaPath = path.join(dir, 'game.json');
      let meta = {
        id: d.name,
        slug: d.name,
        name: d.name,
        status: 'wip',
        entry: 'server/index.js',
      };
      if (fs.existsSync(metaPath)) {
        try {
          meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
        } catch (e) {
          meta.parseError = e.message;
        }
      }
      meta.slug = d.name;
      meta.id = meta.id || d.name;
      meta.mountPath = `/g/${d.name}`;
      meta.dir = dir;
      meta.entry = meta.entry || 'server/index.js';
      return meta;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
}

function getGame(slug) {
  return listGames().find((g) => g.slug === slug || g.id === slug) || null;
}

module.exports = { GAMES_ROOT, listGames, getGame };
