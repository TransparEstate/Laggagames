/**
 * Prove race highscores survive a "redeploy" (wipe local file) via R2 mock.
 * Run: node games/mj-headle/tools/test-highscore-r2.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const r2 = require(path.join(root, 'server', 'r2'));

const tmp = path.join(root, 'data', `race-hs-r2-mock-${process.pid}.json`);
const memory = new Map();

const origEnabled = r2.isEnabled;
const origGet = r2.getObjectBuffer;
const origPut = r2.putJson;

r2.isEnabled = () => true;
r2.getObjectBuffer = async (key) => {
  if (!memory.has(key)) {
    const err = new Error('NoSuchKey');
    err.name = 'NoSuchKey';
    err.$metadata = { httpStatusCode: 404 };
    throw err;
  }
  return { buffer: Buffer.from(memory.get(key), 'utf8'), contentType: 'application/json' };
};
r2.putJson = async (key, data) => {
  memory.set(key, JSON.stringify(data, null, 2));
};

async function main() {
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

    const hs = require(path.join(root, 'server', 'raceHighscores'));
    hs.setDataFileForTests(tmp);

    const store = {
      byRounds: {
        '5': [{ name: 'PersistMe', score: 777, at: Date.now(), solo: true }],
      },
    };
    await r2.putJson(hs.R2_KEY, store);
    assert.ok(memory.has(hs.R2_KEY), 'mock R2 has object');

    // Simulate redeploy: local disk wiped
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    assert.ok(!fs.existsSync(tmp));

    const result = await hs.hydrateFromR2();
    assert.ok(result.ok && result.loaded, JSON.stringify(result));
    assert.ok(fs.existsSync(tmp), 'local file restored from R2');
    const board = hs.getBoard(5);
    assert.ok(board.entries.some((e) => e.name === 'PersistMe' && e.score === 777));
    console.log('ok: highscores reloaded from R2 after local wipe (redeploy simulation)');

    memory.clear();
    const seed = await hs.hydrateFromR2();
    assert.ok(seed.ok && seed.seeded, JSON.stringify(seed));
    assert.ok(memory.has(hs.R2_KEY), 'local board seeded back to R2');
    console.log('ok: local board seeded to empty R2');

    console.log('\nALL R2 HIGHSCORE CHECKS PASSED');
  } finally {
    r2.isEnabled = origEnabled;
    r2.getObjectBuffer = origGet;
    r2.putJson = origPut;
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
