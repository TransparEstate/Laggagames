#!/usr/bin/env node
const path = require('path');
const { spawn } = require('child_process');
const { getGame, listGames } = require('../server/registry');

const slug = process.argv[2];
if (!slug) {
  const games = listGames();
  console.error('Usage: npm run game -- <slug>');
  console.error('Available:', games.map((g) => g.slug).join(', ') || '(none)');
  process.exit(1);
}
const game = getGame(slug);
if (!game) {
  console.error(`Unknown game: ${slug}`);
  process.exit(1);
}
const entry = path.join(game.dir, game.entry || 'server/index.js');
const child = spawn(process.execPath, [entry], {
  cwd: game.dir,
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code || 0));
