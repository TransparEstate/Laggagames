/**
 * Terminal checks for mj-headle UX: async rounds, syncReveal, recap, leave.
 * Run: node games/mj-headle/tools/ux-smoke-test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const game = require(path.join(root, 'server', 'gameLogic'));
const RoomManager = require(path.join(root, 'server', 'roomManager'));

const songs = [
  { id: 's1', title: 'Billie Jean', artist: 'Michael Jackson', cueStartSec: 1, hasAudio: true },
  { id: 's2', title: 'Beat It', artist: 'Michael Jackson', cueStartSec: 0, hasAudio: true },
  { id: 's3', title: 'Thriller', artist: 'Michael Jackson', cueStartSec: 2, hasAudio: true },
];

function roomWithTwo() {
  const room = game.createEmptyRoom('TEST01', 'host');
  game.addPlayer(room, 'host', 'Host');
  game.addPlayer(room, 'guest', 'Guest');
  return room;
}

function section(title) {
  console.log(`\n== ${title}`);
}

function drainSkips(room, socketId) {
  let guard = 0;
  while (guard++ < 40) {
    const run = room.playerRuns[socketId];
    if (!run || run.matchDone) break;
    const before = run.roundIndex;
    const r = game.skipStage(room, socketId);
    assert.ok(r.ok || r.error, r.error || 'skip ok');
    if (r.error) break;
    if (run.roundIndex > before || run.matchDone) {
      // advanced or finished match
      if (run.matchDone) break;
      // finished one round; continue until match done for drain helpers that want full match
    }
  }
}

section('async skip: stages independent (syncReveal on)');
{
  const room = roomWithTwo();
  room.settings.syncReveal = true;
  const start = game.startMatch(room, songs);
  assert.ok(start.ok, start.error);
  assert.strictEqual(room.phase, 'playing');

  const skipHost = game.skipStage(room, 'host');
  assert.ok(skipHost.ok, skipHost.error);
  assert.strictEqual(skipHost.stageIndex, 1);

  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.strictEqual(stHost.current.stageIndex, 1, 'host advanced');
  assert.strictEqual(stGuest.current.stageIndex, 0, 'guest still at 0');
  assert.strictEqual(stHost.current.stageSeconds, 0.5);
  assert.strictEqual(stGuest.current.stageSeconds, 0.1);
  console.log('ok: host stage 1, guest stage 0');
}

section('winner + restartSession → lobby');
{
  const room = roomWithTwo();
  room.settings.syncReveal = true;
  game.startMatch(room, songs);
  room.phase = 'finished';
  room.players[0].score = 20;
  room.players[1].score = 80;
  room.scores = { host: 20, guest: 80 };
  const finished = game.publicState(room, 'host');
  assert.ok(finished.winner);
  assert.strictEqual(finished.winner.name, 'Guest');
  assert.strictEqual(finished.winner.score, 80);
  const restart = game.restartSession(room);
  assert.ok(restart.ok);
  assert.strictEqual(room.phase, 'lobby');
  assert.strictEqual(room.players[0].score, 0);
  assert.strictEqual(room.players[1].score, 0);
  assert.deepStrictEqual(room.roundRecap, []);
  const lobby = game.publicState(room, 'host');
  assert.strictEqual(lobby.phase, 'lobby');
  assert.strictEqual(lobby.winner, null);
  console.log('ok: winner Guest, restart → lobby');
}

section('wrong guess only advances own stage');
{
  const room = roomWithTwo();
  room.settings.syncReveal = true;
  game.startMatch(room, songs);
  const bad = game.submitGuess(room, 'guest', 'Definitely Wrong Title XYZ');
  assert.ok(bad.ok && bad.correct === false);
  assert.strictEqual(bad.stageIndex, 1);
  assert.strictEqual(game.publicState(room, 'host').current.stageIndex, 0);
  assert.strictEqual(game.publicState(room, 'guest').current.stageIndex, 1);
  console.log('ok: wrong guess only guest');
}

section('syncReveal ON: no early personal reveal');
{
  const room = roomWithTwo();
  room.settings.syncReveal = true;
  game.startMatch(room, songs);
  const title = room.current.title;
  const ok = game.submitGuess(room, 'host', title);
  assert.ok(ok.correct);
  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.strictEqual(stHost.current.revealedForMe, false);
  assert.strictEqual(stHost.current.title, null);
  assert.strictEqual(stGuest.current.title, null);
  assert.strictEqual(room.phase, 'playing');
  console.log('ok: host waits, answer hidden');
}

section('syncReveal OFF: independent rounds, no mid reveal, no push');
{
  const room = roomWithTwo();
  const set = game.setSyncReveal(room, 'host', false);
  assert.ok(set.ok);
  assert.strictEqual(set.syncReveal, false);
  game.startMatch(room, songs);
  assert.strictEqual(room.current, null);

  // Host finishes round 0 via skips → moves to round 1 alone
  let guard = 0;
  while (room.playerRuns.host.roundIndex === 0 && !room.playerRuns.host.matchDone && guard++ < 20) {
    const r = game.skipStage(room, 'host');
    assert.ok(r.ok, r.error);
  }
  assert.strictEqual(room.playerRuns.host.roundIndex, 1);
  assert.strictEqual(room.playerRuns.guest.roundIndex, 0);
  assert.strictEqual(room.phase, 'playing');

  const stHost = game.publicState(room, 'host');
  const stGuest = game.publicState(room, 'guest');
  assert.notStrictEqual(stHost.current.songId, stGuest.current.songId);
  assert.strictEqual(stHost.current.title, null);
  assert.strictEqual(stGuest.current.title, null);
  assert.strictEqual(stHost.current.revealedForMe, false);
  console.log('ok: host on song 2, guest still song 1, no titles');

  // Finish both matches
  while (!room.playerRuns.host.matchDone) {
    const r = game.skipStage(room, 'host');
    assert.ok(r.ok, r.error);
  }
  while (!room.playerRuns.guest.matchDone) {
    const r = game.skipStage(room, 'guest');
    assert.ok(r.ok, r.error);
  }
  assert.strictEqual(room.phase, 'finished');
  const fin = game.publicState(room, 'host');
  assert.ok(Array.isArray(fin.roundRecap));
  assert.ok(fin.roundRecap.length >= 1);
  assert.ok(fin.roundRecap[0].title);
  assert.ok(fin.roundRecap[0].results.length >= 1);
  console.log('ok: finished with roundRecap', fin.roundRecap.length);
}

section('syncReveal ON: reveal + recap after all done + next to finish');
{
  const room = roomWithTwo();
  game.setRounds(room, 'host', 1);
  room.settings.syncReveal = true;
  game.startMatch(room, songs);
  const title = room.current.title;
  assert.ok(game.submitGuess(room, 'host', title).correct);
  assert.strictEqual(room.phase, 'playing');
  while (!room.current.guesses.guest?.done) {
    assert.ok(game.skipStage(room, 'guest').ok);
  }
  assert.strictEqual(room.phase, 'reveal');
  assert.strictEqual(game.publicState(room, 'guest').current.title, title);
  const next = game.nextRound(room, songs);
  assert.ok(next.ok && next.finished);
  assert.strictEqual(room.phase, 'finished');
  assert.ok(game.publicState(room, 'host').roundRecap.length >= 1);
  console.log('ok: sync reveal + finished recap');
}

section('setSyncReveal host-only / lobby-only');
{
  const room = roomWithTwo();
  assert.ok(game.setSyncReveal(room, 'guest', false).error);
  game.startMatch(room, songs);
  assert.ok(game.setSyncReveal(room, 'host', false).error);
  console.log('ok: guarded');
}

section('race points decay + first bonus + window continues');
{
  const room = roomWithTwo();
  assert.ok(game.setMode(room, 'host', 'race').ok);
  assert.strictEqual(room.settings.mode, 'race');
  assert.strictEqual(game.syncOn(room), true);
  game.setRounds(room, 'host', 1);
  game.startMatch(room, songs);
  assert.ok(room.current);
  const go = game.applyRaceGo(room, {
    playAt: Date.now() - 1000,
    endsAt: Date.now() + 25000,
  });
  assert.ok(go.ok, go.error);
  const title = room.current.title;
  const first = game.submitGuess(room, 'host', title);
  assert.ok(first.correct, first.error);
  assert.ok(first.firstBonus);
  assert.ok(room.current.firstCorrectAt);
  const hint1 = game.buildRaceTitleHint(
    room.current.title,
    room.current.firstCorrectAt,
    room.current.firstCorrectAt,
    room.current.songId
  );
  assert.ok(hint1 && hint1.includes('·'), 'partial hint at start');
  const hintLate = game.buildRaceTitleHint(
    room.current.title,
    room.current.firstCorrectAt,
    room.current.firstCorrectAt + 60_000,
    room.current.songId
  );
  const letters = [...room.current.title].filter((c) => /[A-Za-zÄÖÜäöüß0-9]/.test(c)).length;
  const revealed = [...hintLate].filter((c) => c !== '·' && /[A-Za-zÄÖÜäöüß0-9]/.test(c)).length;
  assert.ok(revealed <= Math.ceil(letters * game.RACE_TITLE_HINT_CAP) + 1, 'hint capped');
  assert.notStrictEqual(hintLate, room.current.title, 'never full title during drip');
  assert.ok(first.basePoints != null);
  assert.strictEqual(first.bonusPoints, game.RACE_FIRST_BONUS);
  assert.strictEqual(first.points, first.basePoints + first.bonusPoints);
  assert.ok(first.points >= game.RACE_MIN_POINTS + game.RACE_FIRST_BONUS);
  assert.strictEqual(room.phase, 'playing', 'timer continues after first correct');
  const guestWrong = game.submitGuess(room, 'guest', 'Nope Not A Song');
  assert.ok(guestWrong.ok && guestWrong.correct === false);
  assert.strictEqual(room.current.guesses.guest.done, false);
  assert.ok(Array.isArray(room.current.guesses.guest.attempts));
  assert.strictEqual(room.current.guesses.guest.attempts.length, 1);
  assert.strictEqual(room.current.guesses.guest.attempts[0].text, 'Nope Not A Song');
  game.submitGuess(room, 'guest', 'Still Wrong');
  assert.strictEqual(room.current.guesses.guest.attempts.length, 2);
  const second = game.submitGuess(room, 'guest', title);
  assert.ok(second.correct);
  assert.strictEqual(second.firstBonus, false);
  assert.strictEqual(second.bonusPoints, 0);
  assert.ok(second.points < first.points);
  assert.strictEqual(room.phase, 'reveal');
  const standings = game.raceStandings(room);
  assert.ok(standings.some((r) => r.firstBonus && r.bonusPoints === game.RACE_FIRST_BONUS));
  console.log('ok: race scoring + continue after first');
}

section('race endRaceWindow marks unfinished as giveUp');
{
  const room = roomWithTwo();
  game.setMode(room, 'host', 'race');
  game.setRounds(room, 'host', 1);
  game.startMatch(room, songs);
  game.applyRaceGo(room, { playAt: Date.now() - 500, endsAt: Date.now() - 1 });
  const ended = game.endRaceWindow(room);
  assert.ok(ended.ok);
  assert.strictEqual(room.phase, 'reveal');
  assert.strictEqual(room.current.guesses.host.giveUp, true);
  assert.strictEqual(room.current.guesses.guest.giveUp, true);
  console.log('ok: race window end');
}

section('setMode host-only / race blocks syncReveal off');
{
  const room = roomWithTwo();
  assert.ok(game.setMode(room, 'guest', 'race').error);
  assert.ok(game.setMode(room, 'host', 'race').ok);
  assert.ok(game.setSyncReveal(room, 'host', false).error);
  assert.ok(game.setMode(room, 'host', 'classic').ok);
  assert.ok(game.setSyncReveal(room, 'host', false).ok);
  console.log('ok: mode guards');
}

section('racePointsForElapsed formula');
{
  assert.strictEqual(game.racePointsForElapsed(0), game.RACE_MAX_POINTS);
  assert.strictEqual(game.racePointsForElapsed(game.RACE_WINDOW_MS), game.RACE_MIN_POINTS);
  assert.ok(game.racePointsForElapsed(15000) < game.RACE_MAX_POINTS);
  console.log('ok: decay formula');
}

section('leave empties room');
{
  const rooms = new RoomManager();
  const room = rooms.createRoom('host');
  rooms.joinRoom(room.code, 'host', 'Host');
  rooms.joinRoom(room.code, 'guest', 'Guest');
  const leaveGuest = rooms.leaveSocket('guest', { hard: true });
  assert.strictEqual(leaveGuest.empty, false);
  const leaveHost = rooms.leaveSocket('host', { hard: true });
  assert.strictEqual(leaveHost.empty, true);
  assert.strictEqual(rooms.getRoom(room.code), null);
  console.log('ok: hard leave deletes empty room');
}

section('race standings empty after beginRound');
{
  const room = roomWithTwo();
  game.setMode(room, 'host', 'race');
  game.setRounds(room, 'host', 2);
  game.startMatch(room, songs);
  game.applyRaceGo(room, { playAt: Date.now() - 200, endsAt: Date.now() + 20000 });
  game.submitGuess(room, 'host', room.current.title);
  game.submitGuess(room, 'guest', room.current.title);
  assert.ok(game.raceStandings(room).length >= 1);
  assert.ok(game.nextRound(room, songs).ok);
  assert.deepStrictEqual(game.raceStandings(room), []);
  const pub = game.publicState(room, 'host');
  assert.deepStrictEqual(pub.current.standings, []);
  assert.strictEqual(pub.current.firstBonusAwarded, false);
  console.log('ok: standings reset on next race round');
}

section('race highscores buckets by rounds');
{
  const hs = require('../server/raceHighscores');
  const tmp = path.join(root, 'data', `race-highscores-test-${process.pid}.json`);
  hs.setDataFileForTests(tmp);
  try {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    const a = hs.submitScore({ name: 'Alpha', score: 100, rounds: 5, solo: true });
    assert.ok(a.ok);
    assert.ok(a.isNewRecord);
    const b = hs.submitScore({ name: 'Beta', score: 200, rounds: 5, solo: true });
    assert.ok(b.isNewRecord);
    const c = hs.submitScore({ name: 'Alpha', score: 90, rounds: 5, solo: true });
    assert.strictEqual(c.isNewRecord, false, 'lower score does not replace');
    const d = hs.submitScore({ name: 'Alpha', score: 250, rounds: 5, solo: true });
    assert.ok(d.isNewRecord);
    const board5 = hs.getBoard(5);
    assert.ok(board5.entries.some((e) => e.name === 'Alpha' && e.score === 250));
    assert.ok(board5.entries.some((e) => e.name === 'Beta' && e.score === 200));
    hs.submitScore({ name: 'EightKid', score: 400, rounds: 8, solo: true });
    const board8 = hs.getBoard(8);
    assert.ok(board8.entries.some((e) => e.name === 'EightKid'));
    assert.ok(!board5.entries.some((e) => e.name === 'EightKid'), '8-round score stays out of 5-round board');
    const room = roomWithTwo();
    room.settings.mode = 'race';
    room.totalRounds = 3;
    room.solo = true;
    room.phase = 'finished';
    room.players[0].score = 111;
    room.players[1].score = 222;
    room.raceHighscoreRecorded = false;
    const rec = hs.recordRaceFinish(room);
    assert.ok(rec.ok);
    assert.ok(room.raceHighscoreRecorded);
    const again = hs.recordRaceFinish(room);
    assert.ok(again.already);
    const board3 = hs.getBoard(3);
    assert.ok(board3.entries.length >= 1);
    const classic = roomWithTwo();
    classic.settings.mode = 'classic';
    classic.phase = 'finished';
    classic.players[0].score = 999;
    const skip = hs.recordRaceFinish(classic);
    assert.ok(skip.skipped);
    console.log('ok: highscore buckets + finish record');
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* ignore */ }
    hs.setDataFileForTests(path.join(root, 'data', 'race-highscores.json'));
  }
}

section('static UI markers');
{
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(!html.includes('id="btnReady"'), 'btnReady removed');
  assert.ok(html.includes('id="syncRevealToggle"'));
  assert.ok(html.includes('id="modeRaceToggle"'));
  assert.ok(html.includes('id="modeCardClassic"'));
  assert.ok(html.includes('id="modeCardRace"'));
  assert.ok(html.includes('id="lobbyModeRace"'));
  assert.ok(html.includes('id="homeHighscorePanel"'));
  assert.ok(!html.includes('id="btnSolo"'), 'solo button removed');
  assert.ok(js.includes('startSolo({ mode:'));
  assert.ok(js.includes('function syncLobbyModeCards'));
  assert.ok(html.includes('id="raceHud"'));
  assert.ok(html.includes('Skippen'));
  assert.ok(html.includes('id="btnRevealPlay"'));
  assert.ok(html.includes('id="leaveModal"'));
  assert.ok(html.includes('id="roundRecap"'));
  assert.ok(html.includes('id="view-wait"'));
  assert.ok(html.includes('id="btnGuess"'));
  assert.ok(html.includes('id="lobbyHighscorePanel"'));
  assert.ok(html.includes('id="ersttippBurst"'));
  assert.ok(js.includes('session:return-to-lobby'));
  assert.ok(js.includes('waitingForOthers'));
  assert.ok(js.includes('roundRecap'));
  assert.ok(js.includes('lobby:set-mode'));
  assert.ok(js.includes('race:armed'));
  assert.ok(js.includes('handleRaceGo'));
  assert.ok(html.includes('id="guessAttempts"'));
  assert.ok(js.includes('function renderGuessAttempts'));
  assert.ok(html.includes('id="revealSeek"'));
  assert.ok(html.includes('id="audioVolumeReveal"'));
  assert.ok(!html.includes('id="audioVolumePlay"'), 'volume only on reveal');
  assert.ok(!html.includes('volume-field-play'));
  assert.ok(js.includes('mj-headle-volume'));
  assert.ok(css.includes('homeEnter') || css.includes('@keyframes homeEnter'));
  assert.ok(css.includes('scoreboardIn') || css.includes('@keyframes scoreboardIn'));
  assert.ok(css.includes('racePulse') || css.includes('@keyframes racePulse'));
  assert.ok(html.includes('class="brand home-enter"') || html.includes('home-enter'));
  assert.ok(js.includes("e.key === 'Tab'"));
  assert.ok(js.includes('requestSubmit'));
  assert.ok(js.includes('buildRaceTitleHint') || js.includes('titleHint') || js.includes('updateRaceTitleHint'));
  assert.ok(js.includes('function focusGuessInput'), 'targeted focus helper');
  assert.ok(js.includes('function renderRaceStandingsList'), 'standings helper clears list');
  assert.ok(js.includes('keepFocus: true'));
  assert.ok(js.includes('animateLetterReveal'));
  assert.ok(js.includes('showErsttippBurst'));
  assert.ok(js.includes('/api/race-highscores'));
  assert.ok(css.includes('line-height: 1.05') || css.includes('line-height:1.05'));
  assert.ok(css.includes('.modal'));
  assert.ok(css.includes('.btn-danger') || css.includes('btn-danger'));
  assert.ok(css.includes('min-height: 100vh'), 'viewport fill');
  assert.ok(css.includes('background-attachment: fixed'), 'fixed atmosphere');
  assert.ok(css.includes('.race-hud'));
  assert.ok(css.includes('.ersttipp-burst'));
  assert.ok(css.includes('.score-breakdown'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(js.includes('function clearGuessInput'), 'clearGuessInput helper');
  assert.ok(js.includes('el.currentTime = 0'), 'reveal plays from start');
  const revealFn = js.slice(js.indexOf('function playRevealTrack'), js.indexOf('function maybeResetRoundUi'));
  assert.ok(!revealFn.includes('cueStartSec'), 'reveal does not seek to cue');
  console.log('ok: html/js/css markers');
}

section('live catalog + socket syncReveal');
(async () => {
  const PORT = 3027;
  const child = spawn('node', ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (d) => {
    boot += d.toString();
  });
  child.stderr.on('data', (d) => {
    boot += d.toString();
  });

  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${PORT}/api/songs`, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('server did not start\n' + boot);
  };

  try {
    await waitUp();
    const data = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${PORT}/api/songs`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });
    const n = (data.songs || []).length;
    assert.ok(n > 12, `expected >12 songs, got ${n}`);
    console.log(`ok: catalog ${n} songs, playable=${data.playableCount}`);

    const hsBody = await new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${PORT}/api/race-highscores?rounds=5`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });
    assert.strictEqual(hsBody.rounds, 5);
    assert.ok(Array.isArray(hsBody.entries));
    console.log('ok: race-highscores API');

    let ioClient;
    try {
      ioClient = require('socket.io-client');
    } catch {
      ioClient = require(path.join(root, '..', '..', 'node_modules', 'socket.io-client'));
    }

    const connect = (name) =>
      new Promise((resolve, reject) => {
        const s = ioClient(`http://127.0.0.1:${PORT}`, {
          transports: ['websocket'],
          forceNew: true,
        });
        const t = setTimeout(() => reject(new Error('connect timeout ' + name)), 5000);
        s.on('connect', () => {
          clearTimeout(t);
          resolve(s);
        });
        s.on('connect_error', reject);
      });

    const emit = (s, event, payload = {}) =>
      new Promise((resolve) => s.emit(event, payload, (res) => resolve(res || {})));

    const a = await connect('a');
    const solo = await emit(a, 'room:create-solo', { name: 'A', rounds: 3 });
    assert.ok(solo.ok, solo.error);
    assert.strictEqual(solo.state.settings.syncReveal, true);
    assert.strictEqual(solo.state.settings.mode, 'classic');
    const toggled = await emit(a, 'lobby:set-sync-reveal', { syncReveal: false });
    assert.ok(toggled.ok, toggled.error);
    assert.strictEqual(toggled.syncReveal, false);
    assert.strictEqual(toggled.state.settings.syncReveal, false);

    const raceMode = await emit(a, 'lobby:set-mode', { mode: 'race' });
    assert.ok(raceMode.ok, raceMode.error);
    assert.strictEqual(raceMode.mode, 'race');
    assert.strictEqual(raceMode.state.settings.mode, 'race');
    assert.strictEqual(raceMode.state.settings.syncReveal, true);

    const left = await emit(a, 'session:return-to-lobby', {});
    assert.ok(left.ok, left.error);
    console.log('ok: socket syncReveal + race mode + leave');
    a.close();

    console.log('\nALL CHECKS PASSED');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error('\nFAILED', err);
  process.exit(1);
});
