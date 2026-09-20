(function () {
  const params = new URLSearchParams(location.search);
  const partyId = (params.get('party') || '').toUpperCase();
  const memberId = params.get('member') || '';
  const prefillName = params.get('name') || '';
  const GB = document.querySelector('base')?.getAttribute('href')?.replace(/\/$/, '') || '';

  const HINT_DEFS = [
    ['continent', 'Kontinent'],
    ['population', 'Einwohner'],
    ['equator', 'Äquator'],
    ['landlocked', 'Küste'],
    ['area', 'Fläche'],
    ['colors', 'Farben'],
    ['emblem', 'Emblem'],
    ['neighbors', 'Nachbarn'],
    ['independence', 'Unabhängigkeit'],
    ['capitalLetter', 'Hauptstadt-Buchstabe'],
    ['shapeHint', 'Form'],
    ['palette', 'Palette'],
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    phasePill: $('phasePill'),
    tonfalle: $('tonfalle'),
    viewLobby: $('viewLobby'),
    viewDraw: $('viewDraw'),
    viewReveal: $('viewReveal'),
    viewGuess: $('viewGuess'),
    viewVote: $('viewVote'),
    viewScore: $('viewScore'),
    soloJoin: $('soloJoin'),
    lobbyBody: $('lobbyBody'),
    nameInput: $('nameInput'),
    btnSolo: $('btnSolo'),
    playerList: $('playerList'),
    hostSettings: $('hostSettings'),
    waitHost: $('waitHost'),
    hintToggles: $('hintToggles'),
    setRounds: $('setRounds'),
    setDrawSec: $('setDrawSec'),
    btnSaveSettings: $('btnSaveSettings'),
    btnStart: $('btnStart'),
    sideTag: $('sideTag'),
    briefText: $('briefText'),
    hintChips: $('hintChips'),
    drawTimer: $('drawTimer'),
    canvas: $('drawCanvas'),
    inkColor: $('inkColor'),
    inkSize: $('inkSize'),
    btnEraser: $('btnEraser'),
    btnClear: $('btnClear'),
    btnSubmitDraw: $('btnSubmitDraw'),
    mashupGallery: $('mashupGallery'),
    guessMashup: $('guessMashup'),
    guessOptions: $('guessOptions'),
    guessWait: $('guessWait'),
    voteGallery: $('voteGallery'),
    voteLabels: $('voteLabels'),
    scoreTitle: $('scoreTitle'),
    truthGallery: $('truthGallery'),
    scoreList: $('scoreList'),
    btnContinue: $('btnContinue'),
    btnReturnHub: $('btnReturnHub'),
  };

  let socket = null;
  let eraser = false;
  let drawing = false;
  let lastTonfalleText = '';
  let timerIv = null;
  let selectedVoteMashup = null;
  let prevAssignKey = '';

  const ctx = els.canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function clearCanvas() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  }
  clearCanvas();

  function pos(e) {
    const r = els.canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {
      x: ((t.clientX - r.left) / r.width) * els.canvas.width,
      y: ((t.clientY - r.top) / r.height) * els.canvas.height,
    };
  }

  function startDraw(e) {
    e.preventDefault();
    window.FlagSfx?.unlock();
    drawing = true;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function moveDraw(e) {
    if (!drawing) return;
    e.preventDefault();
    const p = pos(e);
    ctx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = eraser ? 'rgba(0,0,0,1)' : els.inkColor.value;
    ctx.lineWidth = Number(els.inkSize.value) * (eraser ? 1.6 : 1);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function endDraw() {
    drawing = false;
    ctx.beginPath();
  }

  els.canvas.addEventListener('mousedown', startDraw);
  els.canvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);
  els.canvas.addEventListener('touchstart', startDraw, { passive: false });
  els.canvas.addEventListener('touchmove', moveDraw, { passive: false });
  els.canvas.addEventListener('touchend', endDraw);

  HINT_DEFS.forEach(([id, label]) => {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" value="${id}" /> ${label}`;
    els.hintToggles.appendChild(lab);
  });

  function showOnly(view) {
    [
      els.viewLobby,
      els.viewDraw,
      els.viewReveal,
      els.viewGuess,
      els.viewVote,
      els.viewScore,
    ].forEach((v) => {
      v.hidden = v !== view;
    });
  }

  function setTonfalle(t) {
    if (!t?.text) {
      els.tonfalle.hidden = true;
      return;
    }
    if (t.text === lastTonfalleText && !els.tonfalle.hidden) return;
    lastTonfalleText = t.text;
    els.tonfalle.hidden = false;
    els.tonfalle.textContent = t.text;
  }

  function phaseLabel(phase) {
    return (
      {
        lobby: 'Lobby',
        drawing: 'Zeichnen',
        reveal: 'Naht-Reveal',
        guessing: 'Lookalike',
        voting: 'Vote',
        round_score: 'Score',
        finished: 'Ende',
      }[phase] || phase
    );
  }

  function renderMashupCard(m, { showTruth = false, selectable = false } = {}) {
    const div = document.createElement('div');
    div.className = 'mash';
    if (selectable) {
      div.dataset.mashupId = m.id;
      div.style.cursor = 'pointer';
    }
    const title = document.createElement('h3');
    title.textContent =
      m.leftId === m.rightId ? m.leftName : `${m.leftName} × ${m.rightName}`;
    div.appendChild(title);
    if (m.roast) {
      const roast = document.createElement('div');
      roast.className = 'roast';
      roast.textContent = m.roast;
      div.appendChild(roast);
    }
    const comp = document.createElement('div');
    comp.className = 'composite';
    const left = document.createElement('img');
    left.alt = 'links';
    left.src = m.composite?.left || '';
    const right = document.createElement('img');
    right.alt = 'rechts';
    right.src = m.composite?.right || '';
    comp.appendChild(left);
    comp.appendChild(right);
    div.appendChild(comp);
    if (showTruth && m.flagName) {
      const truth = document.createElement('div');
      truth.className = 'truth';
      if (m.flagImage) {
        const img = document.createElement('img');
        img.src = m.flagImage;
        img.alt = m.flagName;
        truth.appendChild(img);
      }
      truth.appendChild(document.createTextNode(m.flagName));
      div.appendChild(truth);
    }
    return div;
  }

  function tickTimer(endsAt) {
    if (timerIv) clearInterval(timerIv);
    function tick() {
      if (!endsAt) {
        els.drawTimer.textContent = '—';
        return;
      }
      els.drawTimer.textContent = String(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
    }
    tick();
    timerIv = setInterval(tick, 250);
  }

  function render(s) {
    if (!s) return;
    els.phasePill.textContent = phaseLabel(s.phase);
    setTonfalle(s.tonfalle);

    if (s.phase === 'drawing' && s.draw) {
      const key = `${s.draw.mashupId}:${s.draw.side}:${!!s.draw.byeSecond}`;
      if (key !== prevAssignKey) {
        prevAssignKey = key;
        clearCanvas();
      }
    } else if (s.phase !== 'drawing') {
      prevAssignKey = '';
    }

    if (s.phase === 'lobby') {
      showOnly(els.viewLobby);
      els.soloJoin.hidden = true;
      els.lobbyBody.hidden = false;
      els.playerList.innerHTML = '';
      (s.players || []).forEach((p) => {
        const chip = document.createElement('span');
        chip.className = 'player-chip' + (p.id === s.hostId ? ' host' : '');
        chip.textContent = p.name + (p.id === s.you ? ' (du)' : '');
        els.playerList.appendChild(chip);
      });
      els.hostSettings.hidden = !s.isHost;
      els.waitHost.hidden = !!s.isHost;
      if (s.isHost && s.settings) {
        els.setRounds.value = s.settings.rounds;
        els.setDrawSec.value = s.settings.drawSeconds;
        const active = new Set(s.settings.hints || []);
        els.hintToggles.querySelectorAll('input').forEach((inp) => {
          inp.checked = active.has(inp.value);
        });
      }
      return;
    }

    if (s.phase === 'drawing') {
      showOnly(els.viewDraw);
      const d = s.draw;
      if (d) {
        els.sideTag.textContent =
          (d.side === 'left' ? 'LINKS' : 'RECHTS') + (d.byeSecond ? ' · Bye #2' : '');
        els.briefText.textContent = d.brief || '';
        els.hintChips.innerHTML = '';
        (d.hints || []).forEach((h) => {
          const c = document.createElement('span');
          c.className = 'chip';
          c.textContent = `${h.label}: ${h.text}`;
          els.hintChips.appendChild(c);
        });
        els.btnSubmitDraw.disabled = !!d.submitted;
      }
      tickTimer(s.drawEndsAt);
      return;
    }

    if (s.phase === 'reveal') {
      showOnly(els.viewReveal);
      els.mashupGallery.innerHTML = '';
      (s.mashups || []).forEach((m) => els.mashupGallery.appendChild(renderMashupCard(m)));
      return;
    }

    if (s.phase === 'guessing') {
      showOnly(els.viewGuess);
      const g = s.guess;
      if (!g || g.done) {
        els.guessMashup.innerHTML = '';
        els.guessOptions.innerHTML = '';
        els.guessWait.hidden = false;
        return;
      }
      els.guessWait.hidden = true;
      const mash = (s.mashups || []).find((m) => m.id === g.mashupId);
      els.guessMashup.innerHTML = '';
      if (mash) els.guessMashup.appendChild(renderMashupCard(mash));
      els.guessOptions.innerHTML = '';
      (g.options || []).forEach((opt) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = opt.name;
        b.addEventListener('click', () => {
          window.FlagSfx?.unlock();
          socket.emit('guess:submit', { mashupId: g.mashupId, flagId: opt.id });
        });
        els.guessOptions.appendChild(b);
      });
      return;
    }

    if (s.phase === 'voting') {
      showOnly(els.viewVote);
      els.voteGallery.innerHTML = '';
      selectedVoteMashup = s.mashups?.[0]?.id || null;
      (s.mashups || []).forEach((m) => {
        const card = renderMashupCard(m, { selectable: true });
        if (m.id === selectedVoteMashup) card.style.outline = '3px solid #e85d04';
        card.addEventListener('click', () => {
          selectedVoteMashup = m.id;
          [...els.voteGallery.children].forEach((c) => {
            c.style.outline = c.dataset.mashupId === m.id ? '3px solid #e85d04' : '';
          });
        });
        els.voteGallery.appendChild(card);
      });
      els.voteLabels.innerHTML = '';
      (s.vote?.labels || []).forEach((lab) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = lab.label;
        b.disabled = !!s.vote?.submitted;
        b.addEventListener('click', () => {
          if (!selectedVoteMashup) return;
          socket.emit('vote:submit', { mashupId: selectedVoteMashup, label: lab.id });
        });
        els.voteLabels.appendChild(b);
      });
      return;
    }

    if (s.phase === 'round_score' || s.phase === 'finished') {
      showOnly(els.viewScore);
      els.scoreTitle.textContent =
        s.phase === 'finished' ? 'Endstand' : `Runde ${s.roundIndex} — Zwischenstand`;
      els.truthGallery.innerHTML = '';
      (s.mashups || []).forEach((m) =>
        els.truthGallery.appendChild(renderMashupCard(m, { showTruth: true }))
      );
      els.scoreList.innerHTML = '';
      Object.entries(s.scores || {})
        .map(([id, sc]) => ({ id, ...sc }))
        .sort((a, b) => b.total - a.total)
        .forEach((sc, i) => {
          const li = document.createElement('li');
          li.textContent = `${i + 1}. ${sc.name}: ${sc.total} (Guess ${sc.guess} · Vote ${sc.vote})`;
          els.scoreList.appendChild(li);
        });
      els.btnContinue.hidden = !s.isHost;
      els.btnContinue.textContent = s.phase === 'finished' ? 'Nochmal Lobby' : 'Nächste Runde';
      els.btnReturnHub.hidden = !s.party;
    }
  }

  function join() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    socket = io({ path: GB ? `${GB}/socket.io` : '/socket.io' });
    socket.on('state:update', render);
    socket.on('sfx', (p) => window.FlagSfx?.play(p?.id));

    const name = (els.nameInput.value || prefillName || 'Spieler').trim() || 'Spieler';
    if (partyId) {
      els.soloJoin.hidden = true;
      socket.emit('session:join-party', { partyId, name, memberId }, (ack) => {
        if (ack?.error) return alert(ack.error);
        if (ack?.state) render(ack.state);
      });
    } else {
      socket.emit('session:join', { name }, (ack) => {
        if (ack?.error) return alert(ack.error);
        if (ack?.state) render(ack.state);
      });
    }
  }

  els.nameInput.value = prefillName || '';
  els.btnSolo.addEventListener('click', () => {
    window.FlagSfx?.unlock();
    join();
  });
  els.btnSaveSettings.addEventListener('click', () => {
    const hints = [...els.hintToggles.querySelectorAll('input:checked')].map((i) => i.value);
    socket.emit('settings:update', {
      rounds: Number(els.setRounds.value),
      drawSeconds: Number(els.setDrawSec.value),
      hints,
    });
  });
  els.btnStart.addEventListener('click', () => {
    window.FlagSfx?.unlock();
    clearCanvas();
    socket.emit('match:start', {});
  });
  els.btnEraser.addEventListener('click', () => {
    eraser = !eraser;
    els.btnEraser.textContent = eraser ? 'Stift' : 'Radierer';
  });
  els.btnClear.addEventListener('click', clearCanvas);
  els.btnSubmitDraw.addEventListener('click', () => {
    window.FlagSfx?.unlock();
    socket.emit('draw:submit', { dataUrl: els.canvas.toDataURL('image/png') }, (ack) => {
      if (ack?.byeContinue) clearCanvas();
    });
  });
  els.btnContinue.addEventListener('click', () => {
    clearCanvas();
    socket.emit('round:continue', {});
  });
  els.btnReturnHub.addEventListener('click', () => {
    socket.emit('session:return-hub', {}, (ack) => {
      location.href = ack?.redirect || '/';
    });
  });

  if (partyId) join();
})();
