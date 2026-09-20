#!/usr/bin/env node
/**
 * Logic smoke (no socket.io-client): solo bye round through guess/vote/score.
 */
const assert = require('assert');
const game = require('../server/gameLogic');

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC';

const room = game.createRoom('smoke', { party: false });
room.players.set('p1', { id: 'p1', name: 'Smoke', connected: true });
room.hostId = 'p1';
room.settings.rounds = 1;
room.settings.drawSeconds = 30;
room.settings.hints = ['shapeHint'];

game.startMatch(room);
assert.strictEqual(room.phase, 'drawing');
assert.ok(room.mashups.length === 1);
assert.ok(room.players.get('p1').assignment.brief);
assert.ok(!/flagId/.test(JSON.stringify(game.getPublicState(room, 'p1').draw)));

let pub = game.getPublicState(room, 'p1');
assert.ok(pub.draw.brief);
assert.ok(!('flagId' in pub.draw));

let r = game.submitDrawing(room, 'p1', { dataUrl: tinyPng });
assert.ok(r.ok);
assert.ok(r.byeContinue, 'solo should continue to right half');

r = game.submitDrawing(room, 'p1', { dataUrl: tinyPng });
assert.ok(r.ok);
assert.ok(game.allDrawingsIn(room));

game.composeMashups(room);
assert.strictEqual(room.phase, 'reveal');
pub = game.getPublicState(room, 'p1');
assert.ok(!pub.mashups[0].flagId, 'no truth at reveal');

game.enterGuessing(room);
pub = game.getPublicState(room, 'p1');
assert.ok(pub.guess.mashupId);
assert.ok(pub.guess.options.length >= 2);

const trueId = room.mashups[0].flagId;
const wrong = pub.guess.options.find((o) => o.id !== trueId)?.id || pub.guess.options[0].id;
game.submitGuess(room, 'p1', { mashupId: pub.guess.mashupId, flagId: wrong });
assert.ok(game.allGuessesDone(room));

game.enterVoting(room);
game.submitVote(room, 'p1', { mashupId: room.mashups[0].id, label: 'chaos' });
assert.ok(game.allVotesDone(room));

game.enterRoundScore(room);
pub = game.getPublicState(room, 'p1');
assert.strictEqual(room.phase, 'round_score');
assert.ok(pub.mashups[0].flagId, 'truth at score');
assert.ok(pub.mashups[0].roast);

// data integrity
for (const cluster of game.flagsData.clusters) {
  for (const code of cluster) {
    assert.ok(game.getFlag(code), `cluster member missing: ${code}`);
  }
}
for (const [code, flag] of Object.entries(game.flagsData.flags)) {
  assert.ok(flag.brief?.left && flag.brief?.right, `briefs missing ${code}`);
  assert.ok(!flag.brief.left.includes(flag.nameDe), `left brief spoils name ${code}`);
  assert.ok(!flag.brief.right.includes(flag.nameDe), `right brief spoils name ${code}`);
}

console.log('SMOKE OK', {
  flags: Object.keys(game.flagsData.flags).length,
  truth: pub.mashups[0].flagName,
  score: pub.scores.p1,
});
