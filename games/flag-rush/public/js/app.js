(() => {
  const params = new URLSearchParams(location.search);
  const partyId = (params.get('party') || '').toUpperCase();
  const memberId = params.get('member') || '';
  const prefillName =
    params.get('name') || localStorage.getItem('flag-rush-name') || '';

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
  let clockOffsetMs = 0;
  let tickTimer = null;
  let suggestTimer = null;
  let lastFlagKey = null;
  let highscoreCache = { rounds: null, board: null };
  let lastFinishedHsKey = null;

  function showView(name) {
    for (const [key, el] of Object.entries(views)) {
      if (el) el.hidden = key !== name;
    }
  }

  function me() {
    if (!state || !playerId) return null;
    return (state.players || []).find((p) => p.id === playerId) || null;
  }

  function myScore() {
    const p = me();
    return p ? p.score || 0 : 0;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateScoreChip() {
    const chip = $('scoreChip');
    const val = $('scoreValue');
    if (!chip || !val) return;
    if (state && (state.phase === 'playing' || state.phase === 'reveal' || state.phase === 'finished')) {
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
    val.textContent = String(myScore());
  }

  /* ── Highscores ─────────────────────────────────────────── */
  async function fetchRaceHighscores(rounds) {
    const n = Math.max(1, Math.min(20, Number(rounds) || 10));
    try {
      const res = await fetch(`${GB}/api/race-highscores?rounds=${n}`);
      const data = await res.json();
      highscoreCache = { rounds: n, board: data };
      return data;
    } catch {
      return { rounds: n, entries: [] };
    }
  }

  function fillHighscoreList(listEl, emptyEl, board) {
    const entries = board?.entries || [];
    if (listEl) {
      listEl.innerHTML = entries
        .map((e) => `<li><span>${escapeHtml(e.name)}</span><strong>${e.score || 0}</strong></li>`)
        .join('');
    }
    if (emptyEl) emptyEl.hidden = entries.length > 0;
  }

  async function refreshHomeHighscore() {
    const rounds = Number($('soloRounds')?.value) || 10;
    const label = $('homeHighscoreRounds');
    if (label) label.textContent = String(rounds);
    const board = await fetchRaceHighscores(rounds);
    fillHighscoreList($('homeHighscoreList'), $('homeHighscoreEmpty'), board);
  }

  async function refreshLobbyHighscore() {
    const rounds =
      Number($('lobbyRounds')?.value) || state?.settings?.rounds || 10;
    const label = $('lobbyHighscoreRounds');
    if (label) label.textContent = String(rounds);
    const board = await fetchRaceHighscores(rounds);
    fillHighscoreList($('lobbyHighscoreList'), $('lobbyHighscoreEmpty'), board);
  }

  async function refreshFinishedHighscore() {
    const rounds = state?.totalRounds || state?.settings?.rounds || 10;
    const label = $('finishedHighscoreRounds');
    if (label) label.textContent = String(rounds);
    const board = await fetchRaceHighscores(rounds);
    fillHighscoreList($('finishedHighscoreList'), $('finishedHighscoreEmpty'), board);

    const banner = $('finishedHighscoreBanner');
    if (!banner) return;
    const myName = (me()?.name || '').toLowerCase();
    const rank = (board.entries || []).findIndex((e) => String(e.name || '').toLowerCase() === myName) + 1;
    const key = `${rounds}:${myScore()}:${rank}`;
    if (rank > 0 && rank <= 10 && key !== lastFinishedHsKey) {
      lastFinishedHsKey = key;
      banner.hidden = false;
      banner.textContent =
        rank === 1 ? 'Neuer Allzeit-Rekord!' : `Platz ${rank} in der Allzeit-Liste`;
    } else if (!rank) {
      banner.hidden = true;
    }
  }

  /* ── Socket ─────────────────────────────────────────────── */
  function connectSocket() {
    if (socket) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      if (typeof io === 'undefined') {
        reject(new Error('socket.io Client fehlt'));
        return;
      }
      socket = io({
        path: GB ? `${GB}/socket.io` : '/socket.io',
        transports: ['websocket', 'polling'],
      });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', (err) => reject(err));
      socket.on('room:state', (next) => applyState(next));
      socket.on('session:returned', () => {
        location.href = '/';
      });
      socket.emit('clock:ping', {}, (res) => {
        if (res?.serverNow) clockOffsetMs = res.serverNow - Date.now();
      });
    });
  }

  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  function applyState(next) {
    state = next;
    updateScoreChip();
    const phase = state?.phase || 'lobby';

    if (phase === 'lobby') {
      showView('lobby');
      renderLobby();
      void refreshLobbyHighscore();
      stopTick();
      return;
    }
    if (phase === 'playing') {
      showView('play');
      renderPlay();
      startTick();
      return;
    }
    if (phase === 'reveal') {
      showView('reveal');
      renderReveal();
      stopTick();
      return;
    }
    if (phase === 'finished') {
      showView('finished');
      renderFinished();
      void refreshFinishedHighscore();
      stopTick();
    }
  }

  function renderLobby() {
    if (!state) return;
    $('lobbyEyebrow').textContent = state.solo ? 'Solo' : `Party ${state.partyId || state.code}`;
    $('lobbyTitle').textContent = state.solo ? 'Bereit?' : 'Party-Lobby';
    const list = $('lobbyPlayers');
    list.innerHTML = '';
    for (const p of state.players || []) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = p.name + (p.id === playerId ? ' (du)' : '');
      const right = document.createElement('span');
      const badges = [];
      if (p.id === state.hostId) badges.push('<span class="badge host">Host</span>');
      if (p.ready) badges.push('<span class="badge ready">Ready</span>');
      if (p.connected === false) badges.push('<span class="badge">offline</span>');
      right.innerHTML = badges.join(' ');
      li.append(left, right);
      list.appendChild(li);
    }

    const isHost = !!state.youAreHost;
    $('lobbyRounds').value = String(state.settings?.rounds || 10);
    $('lobbyDifficulty').value = state.settings?.difficulty || 'medium';
    $('lobbyRounds').disabled = !isHost;
    $('lobbyDifficulty').disabled = !isHost;
    $('btnStart').hidden = !isHost;
    $('btnLeaveLobby').hidden = !!state.solo;
    $('btnReady').hidden = !!state.solo;
    const amReady = !!me()?.ready;
    $('btnReady').textContent = amReady ? 'Nicht ready' : 'Ready';
    $('lobbyHint').textContent = state.solo
      ? 'Host (= du) kann starten.'
      : isHost
        ? 'Alle Ready? Dann Start.'
        : 'Warte auf den Host.';

    if (state.solo && isHost) {
      $('btnStart').hidden = false;
      $('btnStart').textContent = 'Runde starten';
    }
  }

  function renderStandings(el, rows) {
    if (!el) return;
    el.innerHTML = '';
    for (const row of rows || []) {
      const li = document.createElement('li');
      if (row.firstBonus) li.classList.add('first');
      const ms = row.reactionMs != null ? `${(row.reactionMs / 1000).toFixed(1)}s` : '—';
      const bonus = row.bonusPoints ? ` (+${row.bonusPoints})` : '';
      li.innerHTML = `<span>${escapeHtml(row.name)}${row.firstBonus ? ' · Ersttipp' : ''}</span><span>${row.points} P · ${ms}${bonus}</span>`;
      el.appendChild(li);
    }
  }

  function renderPlay() {
    const cur = state?.current;
    if (!cur) return;
    $('raceRound').textContent = `${cur.round} / ${cur.totalRounds}`;
    const flagKey = `${cur.round}:${cur.iso2}`;
    if (flagKey !== lastFlagKey) {
      lastFlagKey = flagKey;
      $('flagImg').src = cur.flagUrl;
      $('flagImg').alt = 'Flagge erraten';
      $('guessInput').value = '';
      $('guessFeedback').textContent = '';
      $('guessFeedback').className = 'guess-feedback';
      renderSuggest('', { open: false });
      $('guessInput').disabled = !!(cur.myGuess && cur.myGuess.done);
      $('btnGuess').disabled = !!(cur.myGuess && cur.myGuess.done);
      if (!(cur.myGuess && cur.myGuess.done)) {
        setTimeout(() => $('guessInput').focus(), 50);
      }
    }
    if (cur.myGuess?.correct) {
      $('guessFeedback').textContent = `Richtig! +${cur.myGuess.points} P`;
      $('guessFeedback').className = 'guess-feedback ok';
      $('guessInput').disabled = true;
      $('btnGuess').disabled = true;
    }
    renderStandings($('raceStandings'), cur.standings);
    tickHud();
  }

  function tickHud() {
    const cur = state?.current;
    if (!cur || state.phase !== 'playing') return;
    const left = Math.max(0, cur.endsAt - serverNow());
    const sec = (left / 1000).toFixed(1).replace('.', ',');
    const timer = $('raceTimer');
    timer.textContent = `${sec}s`;
    timer.classList.toggle('urgent', left < 5000);
    const elapsed = Math.max(0, serverNow() - cur.playAt);
    const windowMs = cur.raceWindowMs || 20000;
    const t = Math.min(1, elapsed / windowMs);
    const pts = Math.max(10, Math.round(100 * (1 - t)));
    $('racePoints').textContent =
      cur.myGuess?.done ? `${cur.myGuess.points || 0} P` : `bis ${pts} P`;
  }

  function startTick() {
    stopTick();
    tickTimer = setInterval(tickHud, 100);
  }
  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function renderReveal() {
    const cur = state?.current;
    if (!cur) return;
    $('revealFlag').src = cur.flagUrl;
    $('revealName').textContent = cur.de || '—';
    $('revealEn').textContent = cur.en && cur.en !== cur.de ? cur.en : '';
    renderStandings($('revealStandings'), cur.standings);
  }

  function renderFinished() {
    const winner = state?.winner;
    const youWin = winner && winner.id === playerId;
    $('winnerTitle').textContent = winner
      ? youWin
        ? 'Du hast gewonnen!'
        : `${winner.name} gewinnt`
      : 'Match vorbei';
    $('winnerScore').textContent = winner ? `${winner.score} Punkte` : '';
    const rank = $('finalRanking');
    rank.innerHTML = '';
    (state.ranking || []).forEach((r, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${i + 1}. ${escapeHtml(r.name)}</span><span>${r.score} P</span>`;
      rank.appendChild(li);
    });
    const recap = $('recapList');
    recap.innerHTML = '';
    for (const round of state.roundRecap || []) {
      const li = document.createElement('li');
      const top = (round.results || []).filter((x) => x.correct)[0];
      li.innerHTML = `<span><strong>R${round.round}</strong> ${escapeHtml(round.de)}</span><span>${
        top ? `${escapeHtml(top.name)} +${top.points}` : '—'
      }</span>`;
      recap.appendChild(li);
    }
    $('btnRematch').hidden = !state.youAreHost;
    $('btnLeaveFinished').hidden = !!state.solo;
  }

  async function loadMeta() {
    try {
      const res = await fetch(`${GB}/api/meta`);
      const data = await res.json();
      if (data?.ok) {
        $('homeMeta').textContent = `${data.countries} Flaggen · Race ${Math.round(
          (data.race?.windowMs || 20000) / 1000
        )}s · First-Bonus +${data.race?.firstBonus || 25}`;
      }
    } catch {
      /* ignore */
    }
  }

  /* ── Suggest / Tab-Auswahl (wie MJ Headle) ──────────────── */
  function renderSuggest(query, { open } = { open: true }) {
    const box = $('suggestList');
    if (!box) return;
    const q = String(query || '').trim();
    if (!open || !q) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    // async fill via fetchSuggest
  }

  async function fetchSuggest(q, { open } = { open: true }) {
    const box = $('suggestList');
    if (!box) return;
    const query = String(q || '').trim();
    if (!open || !query) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    try {
      const res = await fetch(`${GB}/api/suggest?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      const items = data.suggestions || [];
      if (!items.length) {
        box.innerHTML = '<li class="empty">Kein Treffer</li>';
        box.hidden = false;
        return;
      }
      box.innerHTML = items
        .map((s, i) => {
          const label = s.de === s.en ? s.de : `${s.de} / ${s.en}`;
          return `<li data-name="${escapeHtml(s.de)}" class="${i === 0 ? 'active' : ''}">${escapeHtml(label)}</li>`;
        })
        .join('');
      box.hidden = false;
    } catch {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function bindGuessSearch() {
    const input = $('guessInput');
    const box = $('suggestList');
    const form = $('guessForm');
    if (!input || !box) return;

    function fillInputFromName(name) {
      const t = String(name || '');
      input.value = t;
      try {
        input.setSelectionRange(t.length, t.length);
      } catch {
        /* ignore */
      }
    }

    function moveActive(delta) {
      const items = [...box.querySelectorAll('li[data-name]')];
      if (!items.length || box.hidden) return false;
      let idx = items.findIndex((el) => el.classList.contains('active'));
      if (idx < 0) idx = 0;
      const current = items[idx];
      const currentName = current.dataset.name || current.textContent || '';

      // Erster Tab/Pfeil: aktiven Treffer ins Feld — Auswahl sichtbar.
      if (input.value !== currentName) {
        items.forEach((el) => el.classList.remove('active'));
        current.classList.add('active');
        fillInputFromName(currentName);
        current.scrollIntoView({ block: 'nearest' });
        return true;
      }

      const next = items[(idx + delta + items.length) % items.length];
      items.forEach((el) => el.classList.remove('active'));
      next.classList.add('active');
      fillInputFromName(next.dataset.name || next.textContent || '');
      next.scrollIntoView({ block: 'nearest' });
      return true;
    }

    function openSuggestions() {
      clearTimeout(suggestTimer);
      const q = input.value.trim();
      suggestTimer = setTimeout(() => fetchSuggest(q, { open: true }), 80);
    }

    input.addEventListener('input', openSuggestions);
    input.addEventListener('focus', openSuggestions);
    input.addEventListener('click', openSuggestions);
    input.addEventListener('keydown', (e) => {
      const items = [...box.querySelectorAll('li[data-name]')];
      const listOpen = !box.hidden && items.length > 0;

      if (e.key === 'Tab' && listOpen) {
        e.preventDefault();
        moveActive(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'ArrowDown' && listOpen) {
        e.preventDefault();
        moveActive(1);
        return;
      }
      if (e.key === 'ArrowUp' && listOpen) {
        e.preventDefault();
        moveActive(-1);
        return;
      }
      if (e.key === 'Enter') {
        if (listOpen) {
          e.preventDefault();
          fetchSuggest('', { open: false });
          if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
          else form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
        return;
      }
      if (e.key === 'Escape') {
        fetchSuggest('', { open: false });
      }
    });

    box.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-name]');
      if (!li) return;
      e.preventDefault();
      fillInputFromName(li.dataset.name || li.textContent);
      fetchSuggest('', { open: false });
    });

    document.addEventListener('click', (e) => {
      if (e.target === input || box.contains(e.target)) return;
      fetchSuggest('', { open: false });
    });
  }

  function submitGuess() {
    if (!socket || !state || state.phase !== 'playing') return;
    const text = $('guessInput').value.trim();
    if (!text) return;
    fetchSuggest('', { open: false });
    socket.emit('round:guess', { text }, (res) => {
      if (res?.error && !res.correct) {
        $('guessFeedback').textContent = res.error;
        $('guessFeedback').className = 'guess-feedback bad';
        return;
      }
      if (res?.correct) {
        $('guessFeedback').textContent = `Richtig! +${res.guess?.points || 0} P`;
        $('guessFeedback').className = 'guess-feedback ok';
        $('guessInput').disabled = true;
        $('btnGuess').disabled = true;
      } else if (res && res.correct === false) {
        $('guessFeedback').textContent = 'Nicht getroffen — weiter tippen';
        $('guessFeedback').className = 'guess-feedback bad';
      }
      if (res?.state) applyState(res.state);
    });
  }

  function leaveToHubParty() {
    if (!socket) {
      location.href = '/';
      return;
    }
    socket.emit('session:return-to-lobby', {}, () => {
      location.href = '/';
    });
  }

  // Events
  $('soloName').value = prefillName;
  $('btnSoloStart').addEventListener('click', async () => {
    const name = $('soloName').value.trim() || 'Solo';
    localStorage.setItem('flag-rush-name', name);
    $('homeHint').textContent = 'Verbinde…';
    try {
      await connectSocket();
      socket.emit(
        'room:create-solo',
        {
          name,
          rounds: Number($('soloRounds').value),
          difficulty: $('soloDifficulty').value,
        },
        (res) => {
          if (res?.error) {
            $('homeHint').textContent = res.error;
            return;
          }
          playerId = res.playerId;
          applyState(res.state);
          socket.emit('game:start', {}, (startRes) => {
            if (startRes?.error) $('lobbyHint').textContent = startRes.error;
            if (startRes?.state) applyState(startRes.state);
          });
        }
      );
    } catch (err) {
      $('homeHint').textContent = err.message || 'Verbindung fehlgeschlagen';
    }
  });

  $('soloRounds').addEventListener('change', () => {
    void refreshHomeHighscore();
  });

  $('guessForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGuess();
  });

  bindGuessSearch();

  $('lobbyRounds').addEventListener('change', () => {
    if (!socket) return;
    socket.emit('lobby:set-rounds', { rounds: Number($('lobbyRounds').value) }, () => {
      void refreshLobbyHighscore();
    });
    void refreshLobbyHighscore();
  });
  $('lobbyDifficulty').addEventListener('change', () => {
    if (!socket) return;
    socket.emit('lobby:set-difficulty', { difficulty: $('lobbyDifficulty').value });
  });
  $('btnReady').addEventListener('click', () => {
    if (!socket) return;
    const ready = !me()?.ready;
    socket.emit('lobby:ready', { ready });
  });
  $('btnStart').addEventListener('click', () => {
    if (!socket) return;
    socket.emit('game:start', {}, (res) => {
      if (res?.error) $('lobbyHint').textContent = res.error;
    });
  });
  $('btnRematch').addEventListener('click', () => {
    if (!socket) return;
    lastFinishedHsKey = null;
    socket.emit('game:rematch', {});
  });
  $('btnHome').addEventListener('click', () => {
    const base = GB || location.pathname.replace(/\/?$/, '/');
    location.href = base;
  });
  $('btnLeaveLobby').addEventListener('click', leaveToHubParty);
  $('btnLeaveFinished').addEventListener('click', leaveToHubParty);

  async function boot() {
    await loadMeta();
    await refreshHomeHighscore();
    if (!partyId) {
      showView('home');
      return;
    }
    $('soloSetup').hidden = true;
    $('homeHint').textContent = 'Party wird verbunden…';
    showView('home');
    try {
      await connectSocket();
      const name = (params.get('name') || prefillName || 'Spieler').trim();
      localStorage.setItem('flag-rush-name', name);
      socket.emit(
        'session:join-party',
        { partyId, name, memberId },
        (res) => {
          if (res?.error) {
            $('homeHint').textContent = res.error;
            return;
          }
          playerId = res.playerId;
          applyState(res.state);
        }
      );
    } catch (err) {
      $('homeHint').textContent = err.message || 'Party-Join fehlgeschlagen';
    }
  }

  boot();
})();
