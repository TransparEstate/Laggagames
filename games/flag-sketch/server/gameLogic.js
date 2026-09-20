const path = require('path');
const fs = require('fs');

const flagsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'flags.json'), 'utf8')
);
const roasts = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'assets', 'roasts.json'), 'utf8')
);

const HINT_KEYS = [
  'continent',
  'population',
  'equator',
  'landlocked',
  'area',
  'colors',
  'emblem',
  'neighbors',
  'independence',
  'capitalLetter',
  'shapeHint',
  'palette',
];

const DEFAULT_SETTINGS = {
  rounds: 3,
  drawSeconds: 60,
  hints: ['shapeHint', 'palette'],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getFlag(code) {
  return flagsData.flags[code] || null;
}

function clusterFor(code) {
  return flagsData.clusters.find((c) => c.includes(code)) || [code];
}

function lookalikeOptions(trueCode, count = 4) {
  const cluster = clusterFor(trueCode).filter((c) => getFlag(c));
  const pool = Object.keys(flagsData.flags).filter((c) => c !== trueCode);
  const opts = new Set([trueCode]);
  for (const c of shuffle(cluster)) {
    if (opts.size >= count) break;
    if (c !== trueCode) opts.add(c);
  }
  for (const c of shuffle(pool)) {
    if (opts.size >= count) break;
    opts.add(c);
  }
  return shuffle([...opts]).slice(0, count);
}

function formatHint(key, flag) {
  if (!flag || !(key in flag)) return null;
  const v = flag[key];
  const labels = {
    continent: 'Kontinent',
    population: 'Einwohner',
    equator: 'Äquator-Nähe',
    landlocked: 'Küste',
    area: 'Fläche',
    colors: 'Farben',
    emblem: 'Emblem',
    neighbors: 'Nachbarn',
    independence: 'Unabhängigkeit',
    capitalLetter: 'Hauptstadt beginnt mit',
    shapeHint: 'Form',
    palette: 'Palette',
  };
  let text = v;
  if (key === 'landlocked') text = v ? 'Binnenstaat' : 'Küstenstaat';
  if (key === 'emblem') text = v ? 'ja' : 'nein';
  if (key === 'palette' && Array.isArray(v)) text = v.join(' · ');
  return { id: key, label: labels[key] || key, text: String(text) };
}

function buildHints(flagCode, hintIds) {
  const flag = getFlag(flagCode);
  if (!flag) return [];
  return (hintIds || [])
    .map((id) => formatHint(id, flag))
    .filter(Boolean);
}

function pairPlayers(playerIds) {
  const ids = shuffle(playerIds);
  const pairs = [];
  let i = 0;
  while (i < ids.length) {
    if (i + 1 < ids.length) {
      pairs.push({ leftId: ids[i], rightId: ids[i + 1], bye: false });
      i += 2;
    } else {
      pairs.push({ leftId: ids[i], rightId: ids[i], bye: true });
      i += 1;
    }
  }
  return pairs;
}

function pickFlagsForPairs(pairCount, usedCodes) {
  const used = new Set(usedCodes || []);
  const codes = shuffle(Object.keys(flagsData.flags));
  const picked = [];
  for (const code of codes) {
    if (used.has(code)) continue;
    picked.push(code);
    used.add(code);
    if (picked.length >= pairCount) break;
  }
  while (picked.length < pairCount) {
    picked.push(pick(codes));
  }
  return picked;
}

function createRoom(roomId, { party = false } = {}) {
  return {
    id: roomId,
    party,
    phase: 'lobby',
    hostId: null,
    players: new Map(),
    settings: { ...DEFAULT_SETTINGS, hints: [...DEFAULT_SETTINGS.hints] },
    roundIndex: 0,
    totalRounds: DEFAULT_SETTINGS.rounds,
    usedFlags: [],
    mashups: [],
    scores: {},
    drawEndsAt: null,
    timers: {},
    history: [],
  };
}

function ensurePlayerScore(room, playerId) {
  if (!room.scores[playerId]) {
    room.scores[playerId] = { guess: 0, vote: 0, total: 0 };
  }
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    memberId: p.memberId || null,
    connected: p.connected !== false,
  };
}

function publicMashup(m, { revealTruth = false } = {}) {
  const out = {
    id: m.id,
    leftName: m.leftName,
    rightName: m.rightName,
    leftId: m.leftId,
    rightId: m.rightId,
    composite: m.composite || null,
    roast: m.roast || null,
    votes: { chaos: 0, almost: 0, art: 0, ...(m.voteCounts || {}) },
  };
  if (revealTruth) {
    out.flagId = m.flagId;
    out.flagName = getFlag(m.flagId)?.nameDe || m.flagId;
    out.flagImage = `https://flagcdn.com/w320/${m.flagId.toLowerCase()}.png`;
  }
  return out;
}

function getPublicState(room, viewerId) {
  const players = [...room.players.values()].map(publicPlayer);
  const me = room.players.get(viewerId);
  const revealTruth = room.phase === 'round_score' || room.phase === 'finished';
  const allowOwnGuess = room.players.size <= 2;

  const state = {
    roomId: room.id,
    party: room.party,
    phase: room.phase,
    hostId: room.hostId,
    you: viewerId,
    isHost: room.hostId === viewerId,
    players,
    settings: room.settings,
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    drawEndsAt: room.drawEndsAt,
    scores: Object.fromEntries(
      [...room.players.values()].map((p) => {
        ensurePlayerScore(room, p.id);
        return [p.id, { name: p.name, ...room.scores[p.id] }];
      })
    ),
    draw: null,
    mashups: [],
    guess: null,
    vote: null,
    tonfalle: null,
    allowOwnGuess,
  };

  if (room.phase === 'drawing' && me?.assignment) {
    state.draw = {
      side: me.assignment.side,
      brief: me.assignment.brief,
      hints: me.assignment.hints,
      mashupId: me.assignment.mashupId,
      byeSecond: !!me.assignment.byeSecond,
      submitted: !!me.assignment.submitted,
    };
  }

  if (['reveal', 'guessing', 'voting', 'round_score', 'finished'].includes(room.phase)) {
    state.mashups = room.mashups.map((m) => publicMashup(m, { revealTruth }));
  }

  if (room.phase === 'guessing' && me) {
    const targets = room.mashups.filter((m) => {
      if (allowOwnGuess) return true;
      return m.leftId !== viewerId && m.rightId !== viewerId;
    });
    const current = targets.find((m) => !me.guessed?.[m.id]);
    if (current) {
      state.guess = {
        mashupId: current.id,
        options: (current.options || []).map((code) => ({
          id: code,
          name: getFlag(code)?.nameDe || code,
        })),
        remaining: targets.filter((m) => !me.guessed?.[m.id]).length,
      };
    } else {
      state.guess = { done: true };
    }
  }

  if (room.phase === 'voting') {
    state.vote = {
      labels: [
        { id: 'chaos', label: 'Chaos' },
        { id: 'almost', label: 'Fast richtig' },
        { id: 'art', label: 'Kunst' },
      ],
      submitted: !!(me && me.voted),
    };
  }

  if (me?.lastTonfalle) {
    state.tonfalle = me.lastTonfalle;
  }

  return state;
}

function startMatch(room) {
  room.totalRounds = room.settings.rounds || 3;
  room.roundIndex = 0;
  room.usedFlags = [];
  room.history = [];
  room.scores = {};
  for (const p of room.players.values()) {
    ensurePlayerScore(room, p.id);
    p.guessed = {};
    p.voted = false;
    p.assignment = null;
    p.lastTonfalle = null;
  }
  beginRound(room);
}

function beginRound(room) {
  room.roundIndex += 1;
  room.mashups = [];
  room.phase = 'drawing';
  const ids = [...room.players.keys()].filter((id) => room.players.get(id)?.connected !== false);
  const pairs = pairPlayers(ids.length ? ids : [...room.players.keys()]);
  const flagCodes = pickFlagsForPairs(pairs.length, room.usedFlags);
  room.usedFlags.push(...flagCodes);

  pairs.forEach((pair, idx) => {
    const flagId = flagCodes[idx];
    const flag = getFlag(flagId);
    const mashupId = `m${room.roundIndex}-${idx}`;
    const mashup = {
      id: mashupId,
      flagId,
      leftId: pair.leftId,
      rightId: pair.rightId,
      leftName: room.players.get(pair.leftId)?.name || '?',
      rightName: room.players.get(pair.rightId)?.name || '?',
      bye: pair.bye,
      leftData: null,
      rightData: null,
      composite: null,
      roast: pick(roasts.seam),
      options: lookalikeOptions(flagId, 4),
      guesses: {},
      voteCounts: { chaos: 0, almost: 0, art: 0 },
      voters: {},
    };
    room.mashups.push(mashup);

    const leftPlayer = room.players.get(pair.leftId);
    const rightPlayer = room.players.get(pair.rightId);
    const hints = buildHints(flagId, room.settings.hints);

    if (pair.bye && leftPlayer) {
      leftPlayer.assignment = {
        mashupId,
        side: 'left',
        brief: flag.brief.left,
        hints,
        submitted: false,
        bye: true,
        byeSecond: false,
        rightBrief: flag.brief.right,
      };
    } else {
      if (leftPlayer) {
        leftPlayer.assignment = {
          mashupId,
          side: 'left',
          brief: flag.brief.left,
          hints,
          submitted: false,
        };
      }
      if (rightPlayer) {
        rightPlayer.assignment = {
          mashupId,
          side: 'right',
          brief: flag.brief.right,
          hints,
          submitted: false,
        };
      }
    }
  });

  for (const p of room.players.values()) {
    p.guessed = {};
    p.voted = false;
    p.lastTonfalle = {
      kind: 'draw',
      text: pick([
        'Brief lesen. Hirn aus. Stift an.',
        'Tonfalle aktiv: glaub dem Text nicht zu sehr.',
        'Eine Hälfte. Mehr brauchst du nicht. Mehr darfst du nicht.',
      ]),
    };
  }

  const secs = Math.max(20, Number(room.settings.drawSeconds) || 60);
  room.drawEndsAt = Date.now() + secs * 1000;
}

function submitDrawing(room, playerId, { dataUrl }) {
  const player = room.players.get(playerId);
  if (!player?.assignment || room.phase !== 'drawing') {
    return { error: 'Jetzt wird nicht gezeichnet.' };
  }
  if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.length > 1_500_000) {
    return { error: 'Ungültige Zeichnung.' };
  }
  const mashup = room.mashups.find((m) => m.id === player.assignment.mashupId);
  if (!mashup) return { error: 'Mashup fehlt.' };

  const side = player.assignment.side;
  if (side === 'left') mashup.leftData = dataUrl;
  else mashup.rightData = dataUrl;
  player.assignment.submitted = true;

  // Bye player: after left, switch to right brief
  if (player.assignment.bye && side === 'left' && player.assignment.rightBrief) {
    player.assignment = {
      mashupId: mashup.id,
      side: 'right',
      brief: player.assignment.rightBrief,
      hints: player.assignment.hints,
      submitted: false,
      bye: true,
      byeSecond: true,
    };
    player.lastTonfalle = {
      kind: 'draw',
      text: 'Bye-Runde: jetzt die andere Hälfte. Frisches Chaos.',
    };
    return { ok: true, byeContinue: true };
  }

  return { ok: true, byeContinue: false };
}

function allDrawingsIn(room) {
  return room.mashups.every((m) => m.leftData && m.rightData);
}

function composeMashups(room) {
  for (const m of room.mashups) {
    m.composite = {
      left: m.leftData,
      right: m.rightData,
    };
  }
  room.phase = 'reveal';
  room.drawEndsAt = null;
  for (const p of room.players.values()) {
    p.assignment = null;
    p.lastTonfalle = { kind: 'reveal', text: pick(roasts.seam) };
  }
}

function enterGuessing(room) {
  room.phase = 'guessing';
  for (const p of room.players.values()) {
    p.guessed = {};
    p.lastTonfalle = {
      kind: 'guess',
      text: pick([
        'Lookalike-Zeit. Vertrau niemandem, der „offensichtlich“ sagt.',
        'Fremde Mashups. Eigene Verbrechen sind tabu.',
      ]),
    };
  }
}

function submitGuess(room, playerId, { mashupId, flagId }) {
  if (room.phase !== 'guessing') return { error: 'Keine Guess-Phase.' };
  const player = room.players.get(playerId);
  if (!player) return { error: 'Spieler fehlt.' };
  const mashup = room.mashups.find((m) => m.id === mashupId);
  if (!mashup) return { error: 'Mashup fehlt.' };

  const allowOwn = room.players.size <= 2;
  if (!allowOwn && (mashup.leftId === playerId || mashup.rightId === playerId)) {
    return { error: 'Eigenes Mashup ist tabu.' };
  }
  if (player.guessed?.[mashupId]) return { error: 'Schon geraten.' };

  const correct = flagId === mashup.flagId;
  player.guessed = player.guessed || {};
  player.guessed[mashupId] = { flagId, correct };
  mashup.guesses[playerId] = { flagId, correct };

  ensurePlayerScore(room, playerId);
  if (correct) {
    room.scores[playerId].guess += 100;
    room.scores[playerId].total += 100;
    player.lastTonfalle = { kind: 'correct', text: pick(roasts.correct) };
  } else {
    player.lastTonfalle = { kind: 'wrong', text: pick(roasts.wrong) };
  }

  return { ok: true, correct };
}

function allGuessesDone(room) {
  const allowOwn = room.players.size <= 2;
  for (const p of room.players.values()) {
    if (p.connected === false) continue;
    const targets = room.mashups.filter((m) => {
      if (allowOwn) return true;
      return m.leftId !== p.id && m.rightId !== p.id;
    });
    for (const m of targets) {
      if (!p.guessed?.[m.id]) return false;
    }
  }
  return true;
}

function enterVoting(room) {
  if (room.mashups.length < 1) {
    enterRoundScore(room);
    return;
  }
  // With a single mashup and >2 players who all drew it, voting still ok on that one
  room.phase = 'voting';
  for (const p of room.players.values()) {
    p.voted = false;
    p.lastTonfalle = { kind: 'vote', text: pick(roasts.vote) };
  }
}

function submitVote(room, playerId, { mashupId, label }) {
  if (room.phase !== 'voting') return { error: 'Keine Vote-Phase.' };
  const player = room.players.get(playerId);
  if (!player) return { error: 'Spieler fehlt.' };
  if (player.voted) return { error: 'Schon gevoted.' };
  const mashup = room.mashups.find((m) => m.id === mashupId);
  if (!mashup) return { error: 'Mashup fehlt.' };
  if (!['chaos', 'almost', 'art'].includes(label)) return { error: 'Label ungültig.' };
  // Prefer not voting only-self when multiple mashups
  if (room.mashups.length > 1 && mashup.leftId === playerId && mashup.rightId === playerId) {
    return { error: 'Bitte ein fremdes Mashup wählen.' };
  }

  mashup.voteCounts[label] = (mashup.voteCounts[label] || 0) + 1;
  mashup.voters[playerId] = label;
  player.voted = true;

  // Award artists
  for (const artistId of new Set([mashup.leftId, mashup.rightId])) {
    ensurePlayerScore(room, artistId);
    const pts = label === 'chaos' ? 30 : label === 'art' ? 40 : 25;
    room.scores[artistId].vote += pts;
    room.scores[artistId].total += pts;
  }
  player.lastTonfalle = { kind: 'vote', text: pick(roasts.vote) };
  return { ok: true };
}

function allVotesDone(room) {
  for (const p of room.players.values()) {
    if (p.connected === false) continue;
    if (!p.voted) return false;
  }
  return true;
}

function enterRoundScore(room) {
  room.phase = 'round_score';
  room.history.push({
    round: room.roundIndex,
    mashups: room.mashups.map((m) => ({
      id: m.id,
      flagId: m.flagId,
      flagName: getFlag(m.flagId)?.nameDe,
    })),
  });
  for (const p of room.players.values()) {
    p.lastTonfalle = {
      kind: 'score',
      text: pick([
        'Zwischenstand. Ego checken.',
        'Nächste Runde, neue Naht.',
        'Die Wahrheit ist raus. Die Würde auch.',
      ]),
    };
  }
}

function advanceAfterScore(room) {
  if (room.roundIndex >= room.totalRounds) {
    room.phase = 'finished';
    return;
  }
  beginRound(room);
}

module.exports = {
  HINT_KEYS,
  DEFAULT_SETTINGS,
  flagsData,
  roasts,
  getFlag,
  createRoom,
  getPublicState,
  startMatch,
  beginRound,
  submitDrawing,
  allDrawingsIn,
  composeMashups,
  enterGuessing,
  submitGuess,
  allGuessesDone,
  enterVoting,
  submitVote,
  allVotesDone,
  enterRoundScore,
  advanceAfterScore,
  ensurePlayerScore,
  pick,
};
