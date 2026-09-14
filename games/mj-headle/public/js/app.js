(() => {
  const params = new URLSearchParams(location.search);
  const partyId = (params.get('party') || '').toUpperCase();
  const memberId = params.get('member') || '';
  const prefillName =
    params.get('name') || localStorage.getItem('mj-headle-name') || '';

  const pathMatch = location.pathname.match(/^(.*?\/g\/[^/]+)/);
  const GB = pathMatch ? pathMatch[1] : '';

  const $ = (id) => document.getElementById(id);
  const views = {
    home: $('view-home'),
    lobby: $('view-lobby'),
    play: $('view-play'),
    reveal: $('view-reveal'),
    finished: $('view-finished'),
  };

  let socket = null;
  let state = null;
  let playerId = null;
  let ready = false;
  let catalog = [];
  let stages = [0.1, 0.5, 1, 5, 13];
  let audio = null;
  let stopTimer = null;

  function show(name) {
    Object.entries(views).forEach(([key, el]) => {
      if (el) el.hidden = key !== name;
    });
  }

  function fmtSec(s) {
    if (s == null) return '—';
    if (s < 1) return `${String(s).replace('.', ',')}s`;
    return `${s}s`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isHost() {
    return !!(state && state.hostId === playerId);
  }

  function me() {
    return (state?.players || []).find((p) => p.id === playerId) || null;
  }

  function connect() {
    if (socket) return socket;
    socket = io({
      path: GB ? `${GB}/socket.io` : '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.on('state:update', (next) => {
      state = next;
      render();
    });
    socket.on('session:returned', () => {
      location.href = '/';
    });
    return socket;
  }

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      connect().emit(event, payload, (res) => resolve(res || {}));
    });
  }

  async function loadCatalog() {
    const res = await fetch(`${GB}/api/songs`);
    const data = await res.json();
    catalog = data.songs || [];
    stages = data.stages || stages;
    $('catalogMeta').textContent =
      `${catalog.length} Titel · ${data.playableCount || 0} spielbar (Audio + Cue)`;
    $('songSuggestions').innerHTML = catalog
      .map((s) => `<option value="${escapeHtml(s.title)}"></option>`)
      .join('');
  }

  function renderPlayers(listEl, withReady) {
    listEl.innerHTML = (state?.players || [])
      .map((p) => {
        const you = p.id === playerId ? ' (du)' : '';
        const host = p.id === state.hostId ? ' ★' : '';
        const right = withReady
          ? p.ready
            ? '<span class="ready">bereit</span>'
            : '<span>wartet</span>'
          : `<span>${p.score || 0} P</span>`;
        return `<li><span>${escapeHtml(p.name)}${you}${host}</span>${right}</li>`;
      })
      .join('');
  }

  function renderStageTrack() {
    const cur = state?.current;
    const idx = cur?.stageIndex ?? 0;
    const list = cur?.stages || stages;
    $('stageTrack').innerHTML = list
      .map((sec, i) => {
        const cls = i < idx ? 'done' : i === idx ? 'on' : '';
        return `<span class="${cls}" title="${fmtSec(sec)}"></span>`;
      })
      .join('');
    $('stageLabel').textContent =
      cur?.stageSeconds != null ? fmtSec(cur.stageSeconds) : '—';
  }

  function stopAudio() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (audio) audio.pause();
    $('btnPlay').classList.remove('playing');
  }

  function playClip() {
    const cur = state?.current;
    if (!cur?.songId) return;
    stopAudio();
    const url = `${GB}/api/audio/${encodeURIComponent(cur.songId)}`;
    if (!audio || audio.dataset.songId !== cur.songId) {
      audio = new Audio(url);
      audio.dataset.songId = cur.songId;
      audio.preload = 'auto';
    }
    const cue = Number(cur.cueStartSec) || 0;
    const dur = Number(cur.stageSeconds) || 0.1;
    const start = () => {
      try {
        audio.currentTime = cue;
      } catch {
        /* ignore */
      }
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      $('btnPlay').classList.add('playing');
      stopTimer = setTimeout(() => {
        audio.pause();
        $('btnPlay').classList.remove('playing');
      }, Math.max(50, dur * 1000));
    };
    if (audio.readyState >= 1) start();
    else audio.addEventListener('loadedmetadata', start, { once: true });
  }

  function render() {
    if (!state) return;
    const self = me();
    if (self) {
      $('scoreChip').hidden = false;
      $('scoreValue').textContent = String(self.score || 0);
    }

    if (state.phase === 'lobby') {
      show('lobby');
      renderPlayers($('playerList'), true);
      $('btnStart').hidden = !isHost();
      $('roundsField').hidden = !isHost();
      $('roundsInput').value = state.settings?.rounds || 5;
      $('lobbyHint').textContent = state.solo
        ? 'Solo — starte, wenn Songs mit gültigem Cue vorhanden sind.'
        : 'Party — Host startet, wenn alle bereit sind.';
      $('btnReady').textContent = ready ? 'Nicht bereit' : 'Bereit';
      return;
    }

    if (state.phase === 'playing') {
      show('play');
      const cur = state.current;
      $('roundLabel').textContent =
        `Runde ${cur?.round || 1}/${cur?.totalRounds || state.totalRounds}`;
      renderStageTrack();
      const done = !!cur?.myGuess?.done;
      $('guessInput').disabled = done;
      $('btnSkip').disabled = done;
      $('guessForm').querySelector('button[type="submit"]').disabled = done;
      if (done) {
        $('feedback').textContent = cur.myGuess.correct
          ? `Richtig! +${cur.myGuess.points} Punkte`
          : 'Runde beendet — warte auf Reveal…';
        $('feedback').className = `feedback ${cur.myGuess.correct ? 'ok' : ''}`;
      }
      return;
    }

    if (state.phase === 'reveal') {
      show('reveal');
      const cur = state.current;
      $('revealTitle').textContent = cur?.title || '—';
      $('revealSub').textContent = cur?.artist || '';
      renderPlayers($('revealList'), false);
      $('btnNext').hidden = !isHost();
      stopAudio();
      return;
    }

    if (state.phase === 'finished') {
      show('finished');
      $('leaderboard').innerHTML = (state.leaderboard || [])
        .map(
          (p) =>
            `<li><span>${escapeHtml(p.name)}</span><strong>${p.score || 0}</strong></li>`
        )
        .join('');
      stopAudio();
    }
  }

  async function startSolo() {
    const name = ($('nameInput').value || prefillName || 'Solo').trim() || 'Solo';
    $('nameInput').value = name;
    localStorage.setItem('mj-headle-name', name);
    connect();
    show('lobby');
    const res = await emit('room:create-solo', {
      name,
      rounds: Number($('roundsInput').value) || 5,
    });
    if (res.error) {
      $('lobbyHint').textContent = res.error;
      return;
    }
    playerId = res.playerId;
    state = res.state;
    render();
  }

  async function joinPartyFlow() {
    const name = (prefillName || 'Spieler').trim() || 'Spieler';
    $('nameInput').value = name;
    localStorage.setItem('mj-headle-name', name);
    connect();
    show('lobby');
    const res = await emit('session:join-party', {
      partyId,
      name,
      memberId,
    });
    if (res.error) {
      $('homeHint').textContent = res.error;
      show('home');
      return;
    }
    playerId = res.playerId;
    state = res.state;
    render();
  }

  $('btnSolo').addEventListener('click', () => {
    if (!$('nameInput').value) $('nameInput').value = prefillName || 'Solo';
    startSolo();
  });

  $('btnReady').addEventListener('click', async () => {
    ready = !ready;
    await emit('lobby:ready', { ready });
  });

  $('roundsInput').addEventListener('change', async () => {
    if (!isHost()) return;
    await emit('lobby:set-rounds', {
      rounds: Number($('roundsInput').value) || 5,
    });
  });

  $('btnStart').addEventListener('click', async () => {
    const res = await emit('game:start');
    if (res.error) $('lobbyHint').textContent = res.error;
  });

  $('btnPlay').addEventListener('click', () => playClip());

  $('guessForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('guessInput').value.trim();
    if (!text) return;
    const res = await emit('round:guess', { text });
    if (res.error) {
      $('feedback').textContent = res.error;
      $('feedback').className = 'feedback bad';
      return;
    }
    if (res.correct) {
      $('feedback').textContent = `Richtig! +${res.points}`;
      $('feedback').className = 'feedback ok';
      stopAudio();
    } else {
      $('feedback').textContent = 'Nicht getroffen — nächste Stufe';
      $('feedback').className = 'feedback bad';
      $('guessInput').value = '';
      $('guessInput').focus();
    }
  });

  $('btnSkip').addEventListener('click', async () => {
    const res = await emit('round:skip');
    if (res.error) {
      $('feedback').textContent = res.error;
      $('feedback').className = 'feedback bad';
      return;
    }
    $('guessInput').focus();
  });

  $('btnNext').addEventListener('click', async () => {
    await emit('round:next');
  });

  $('btnAgain').addEventListener('click', () => {
    state = null;
    playerId = null;
    ready = false;
    show('home');
    startSolo();
  });

  $('nameInput').value = prefillName;
  if (partyId) {
    $('homeHint').textContent = `Party ${partyId} — verbinde…`;
    $('btnSolo').hidden = true;
  }

  loadCatalog().catch((err) => {
    $('catalogMeta').textContent = `Katalog-Fehler: ${err.message}`;
  });

  if (partyId) joinPartyFlow();
  else show('home');
})();
