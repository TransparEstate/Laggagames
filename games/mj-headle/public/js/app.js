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
    wait: $('view-wait'),
    reveal: $('view-reveal'),
    finished: $('view-finished'),
  };

  let socket = null;
  let state = null;
  let playerId = null;
  let catalog = [];
  let stages = [0.1, 0.5, 1, 5, 13];
  let raceMeta = { windowMs: 30000, clipSec: 30, maxPoints: 100, minPoints: 10, firstBonus: 25 };
  let audio = null;
  let audioToken = 0;
  let stopTimer = null;
  let lastRoundKey = null;
  let lastStageAutoKey = null;
  let clipCache = new Map(); // key: `${songId}:${dur}` -> object URL
  let clipCacheSongId = null;
  let revealPlaying = false;
  let lastRevealAutoKey = null;
  let leaving = false;
  let clockOffsetMs = 0;
  let raceCountdownTimer = null;
  let lastRaceArmKey = null;
  let lastRaceGoKey = null;
  let racePlayScheduled = false;
  let finishedFanfareKey = null;
  let confettiRaf = null;
  let lastErsttippKey = null;
  let lastRevealFxKey = null;
  let lastFocusViewKey = null;
  let leaveFocusRestore = null;
  let letterRevealTimer = null;
  let countUpRafs = [];
  let highscoreCache = { rounds: null, board: null };
  const VOLUME_PLAY = 0.85; // feste Standardlautstärke beim Raten
  const VOLUME_REVEAL_KEY = 'mj-headle-volume-reveal';
  const VOLUME_LEGACY_KEY = 'mj-headle-volume';
  let seekDragging = false;

  function clampVol(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  }

  function getPlayVolume() {
    return VOLUME_PLAY;
  }

  function getRevealVolume() {
    const stored = localStorage.getItem(VOLUME_REVEAL_KEY);
    if (stored != null) return clampVol(stored, 0.55);
    // Alte Ein-Key-Einstellung → Reveal, damit niedrige Werte nicht das Raten kaputt machen
    const legacy = localStorage.getItem(VOLUME_LEGACY_KEY);
    if (legacy != null) return clampVol(legacy, 0.55);
    return 0.55;
  }

  function setRevealVolume(v) {
    const next = clampVol(v, 0.55);
    localStorage.setItem(VOLUME_REVEAL_KEY, String(next));
    if (audio && revealPlaying) {
      try {
        audio.volume = next;
      } catch { /* ignore */ }
    }
    syncRevealVolumeSlider(next);
    return next;
  }

  function syncRevealVolumeSlider(v) {
    const pct = Math.round((v != null ? v : getRevealVolume()) * 100);
    const reveal = $('audioVolumeReveal');
    if (reveal && Number(reveal.value) !== pct) reveal.value = String(pct);
  }

  function applyVolume(el, kind = 'play') {
    if (!el) return;
    try {
      el.volume = kind === 'reveal' ? getRevealVolume() : getPlayVolume();
    } catch { /* ignore */ }
  }

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function resetRevealTransport() {
    const transport = $('revealTransport');
    const seek = $('revealSeek');
    const time = $('revealTime');
    if (transport) transport.hidden = true;
    if (seek) {
      seek.value = '0';
      seek.max = '0';
    }
    if (time) time.textContent = '0:00 / 0:00';
  }

  function updateRevealTransport(el) {
    const transport = $('revealTransport');
    const seek = $('revealSeek');
    const time = $('revealTime');
    if (!el || !transport || !seek || !time) return;
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    if (dur > 0) {
      transport.hidden = false;
      seek.max = String(dur);
      if (!seekDragging) seek.value = String(el.currentTime || 0);
      time.textContent = `${fmtClock(el.currentTime)} / ${fmtClock(dur)}`;
    }
  }

  function updateRaceTitleHint(cur) {
    const el = $('raceTitleHint');
    if (!el) return;
    const done = !!cur?.myGuess?.done;
    const hint = cur?.titleHint;
    if (!raceModeOn() || done || !hint || seesSharedReveal()) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = hint;
  }

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

  function syncRevealOn() {
    return state?.settings?.syncReveal !== false;
  }

  function raceModeOn() {
    return state?.settings?.mode === 'race' || state?.current?.mode === 'race';
  }

  function serverNowApprox() {
    return Date.now() + clockOffsetMs;
  }

  function clearRaceCountdown() {
    if (raceCountdownTimer) {
      clearInterval(raceCountdownTimer);
      raceCountdownTimer = null;
    }
  }

  function clearLetterReveal() {
    if (letterRevealTimer) {
      clearTimeout(letterRevealTimer);
      letterRevealTimer = null;
    }
  }

  function clearCountUps() {
    for (const id of countUpRafs) cancelAnimationFrame(id);
    countUpRafs = [];
  }

  function focusGuessInput() {
    const input = $('guessInput');
    if (!input || input.disabled) return;
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
  }

  function renderGuessAttempts(attempts) {
    const wrap = $('guessAttempts');
    const list = $('guessAttemptsList');
    if (!wrap || !list) return;
    const rows = Array.isArray(attempts) ? attempts : [];
    if (!rows.length) {
      wrap.hidden = true;
      list.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    list.innerHTML = rows
      .map((a) => {
        const cls = a.correct ? 'ok' : '';
        return `<li class="${cls}">${escapeHtml(a.text || '')}</li>`;
      })
      .join('');
    list.scrollTop = list.scrollHeight;
  }

  function renderRaceStandingsList(rows) {
    const list = $('raceStandings');
    if (!list) return;
    const items = Array.isArray(rows) ? rows : [];
    list.innerHTML = items
      .map((r) => {
        const ms = r.reactionMs != null ? `${(r.reactionMs / 1000).toFixed(1).replace('.', ',')}s` : '—';
        const bonus = r.firstBonus ? '<span class="bonus">Ersttipp</span>' : '';
        return `<li><span>${escapeHtml(r.name)}${bonus}</span><span>${ms} · +${r.points}</span></li>`;
      })
      .join('');
  }

  function showErsttippBurst(name, bonus) {
    const el = $('ersttippBurst');
    if (!el) return;
    const nameEl = $('ersttippName');
    const bonusEl = $('ersttippBonus');
    if (nameEl) nameEl.textContent = String(name || 'Spieler');
    if (bonusEl) bonusEl.textContent = `+${bonus || raceMeta.firstBonus || 25}`;
    el.hidden = false;
    clearTimeout(showErsttippBurst._t);
    showErsttippBurst._t = setTimeout(() => {
      el.hidden = true;
    }, 1250);
  }

  function maybeShowErsttipp(cur) {
    if (!raceModeOn() || !cur) return;
    const rows = cur.standings || [];
    const first = rows.find((r) => r.firstBonus);
    if (!first) return;
    const key = `${cur.round}:${cur.songId}:${first.id}`;
    if (key === lastErsttippKey) return;
    lastErsttippKey = key;
    showErsttippBurst(first.name, first.bonusPoints || raceMeta.firstBonus || 25);
  }

  async function fetchRaceHighscores(rounds) {
    const n = Math.max(1, Math.min(20, Number(rounds) || 5));
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

  async function refreshLobbyHighscore() {
    const panel = $('lobbyHighscorePanel');
    if (!panel) return;
    const race = !!$('modeRaceToggle')?.checked || raceModeOn();
    panel.hidden = !race;
    if (!race) return;
    const rounds = Number($('roundsInput')?.value) || state?.settings?.rounds || 5;
    const roundsLabel = $('lobbyHighscoreRounds');
    if (roundsLabel) roundsLabel.textContent = String(rounds);
    const board = await fetchRaceHighscores(rounds);
    fillHighscoreList($('lobbyHighscoreList'), $('lobbyHighscoreEmpty'), board);
  }

  async function refreshHomeHighscore() {
    const panel = $('homeHighscorePanel');
    if (!panel || panel.hidden) return;
    const rounds = Number($('homeRoundsInput')?.value) || 5;
    const board = await fetchRaceHighscores(rounds);
    fillHighscoreList($('homeHighscoreList'), $('homeHighscoreEmpty'), board);
  }

  function setHomeRacePreview(on) {
    const panel = $('homeHighscorePanel');
    const raceCard = $('modeCardRace');
    const classicCard = $('modeCardClassic');
    if (raceCard) raceCard.classList.toggle('is-on', on === true);
    if (classicCard) classicCard.classList.toggle('is-on', on === false);
    if (!panel) return;
    if (on === true) {
      panel.hidden = false;
      panel.classList.add('is-visible');
      void refreshHomeHighscore();
    } else {
      panel.classList.remove('is-visible');
      panel.hidden = true;
    }
  }

  function syncLobbyModeCards() {
    const race = raceModeOn();
    const classic = $('lobbyModeClassic');
    const raceBtn = $('lobbyModeRace');
    const toggle = $('modeRaceToggle');
    if (toggle) toggle.checked = race;
    if (classic) {
      classic.classList.toggle('is-on', !race);
      classic.disabled = !isHost() || state?.phase !== 'lobby';
    }
    if (raceBtn) {
      raceBtn.classList.toggle('is-on', race);
      raceBtn.disabled = !isHost() || state?.phase !== 'lobby';
    }
  }

  async function applyLobbyMode(mode) {
    if (!isHost() || state?.phase !== 'lobby') return;
    const race = mode === 'race';
    const res = await emit('lobby:set-mode', { mode: race ? 'race' : 'classic' });
    if (res.error) {
      $('lobbyHint').textContent = res.error;
      return;
    }
    if (res.state) {
      state = res.state;
      render();
    }
  }

  async function refreshFinishedHighscore() {
    const panel = $('finishedHighscorePanel');
    const banner = $('finishedHighscoreBanner');
    if (!raceModeOn()) {
      if (panel) panel.hidden = true;
      if (banner) banner.hidden = true;
      return;
    }
    const rounds = state?.totalRounds || state?.settings?.rounds || 5;
    const board = await fetchRaceHighscores(rounds);
    if (panel) panel.hidden = false;
    const roundsLabel = $('finishedHighscoreRounds');
    if (roundsLabel) roundsLabel.textContent = String(rounds);
    fillHighscoreList($('finishedHighscoreList'), null, board);
    const self = me();
    if (banner && self) {
      const nameKey = String(self.name || '').toLowerCase();
      const rank = (board.entries || []).findIndex((e) => String(e.name || '').toLowerCase() === nameKey) + 1;
      if (rank > 0 && rank <= 10) {
        banner.hidden = false;
        banner.textContent = rank === 1 ? 'Neuer Allzeit-Rekord!' : `Allzeit Platz ${rank} · ${rounds} Runden`;
      } else {
        banner.hidden = true;
      }
    }
  }

  function animateLetterReveal(title) {
    clearLetterReveal();
    const el = $('revealTitle');
    if (!el) return;
    const text = String(title || '—');
    el.innerHTML = [...text]
      .map((ch) =>
        ch === ' '
          ? '<span class="ch space on">&nbsp;</span>'
          : `<span class="ch">${escapeHtml(ch)}</span>`
      )
      .join('');
    const chars = [...el.querySelectorAll('.ch:not(.space)')];
    let i = 0;
    const step = () => {
      if (i >= chars.length) return;
      chars[i].classList.add('on');
      i += 1;
      letterRevealTimer = setTimeout(step, 48);
    };
    step();
  }

  function countLabel(el, prefix, target, durationMs) {
    if (!el) return;
    const to = Math.max(0, Number(target) || 0);
    const start = performance.now();
    const run = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = `${prefix}${Math.round(to * eased)}`;
      if (t < 1) countUpRafs.push(requestAnimationFrame(run));
      else el.textContent = `${prefix}${to}`;
    };
    countUpRafs.push(requestAnimationFrame(run));
  }

  function renderRevealBreakdown(listEl, standings, players) {
    if (!listEl) return;
    clearCountUps();
    if (!raceModeOn()) {
      listEl.className = 'player-list';
      renderPlayers(listEl, 'scores');
      return;
    }
    listEl.className = 'score-breakdown';
    const rows = (standings && standings.length ? standings.slice() : []) || [];
    const seen = new Set(rows.map((r) => r.id));
    for (const p of players || []) {
      if (seen.has(p.id)) continue;
      rows.push({
        id: p.id,
        name: p.name,
        points: 0,
        basePoints: 0,
        bonusPoints: 0,
        reactionMs: null,
        firstBonus: false,
      });
    }

    listEl.innerHTML = rows
      .map((r, idx) => {
        const base = r.basePoints != null ? r.basePoints : r.points || 0;
        const bonus = r.bonusPoints || 0;
        const total = r.points != null ? r.points : base + bonus;
        const ms = r.reactionMs != null ? `${(r.reactionMs / 1000).toFixed(1).replace('.', ',')}s` : '—';
        return `<li class="${r.firstBonus ? 'first' : ''}" style="animation-delay:${idx * 0.06}s">
          <div class="sb-head"><span>${escapeHtml(r.name)}</span><span class="sb-total" data-count="${total}">+0</span></div>
          <div class="sb-rows">
            <span data-base="${base}">Zeit +0</span>
            ${bonus > 0 ? `<span class="sb-bonus" data-bonus="${bonus}">Ersttipp +0</span>` : ''}
            <span>${ms}</span>
          </div>
        </li>`;
      })
      .join('');

    [...listEl.querySelectorAll('li')].forEach((li, idx) => {
      const totalEl = li.querySelector('.sb-total');
      const baseEl = li.querySelector('[data-base]');
      const bonusEl = li.querySelector('[data-bonus]');
      const base = Number(baseEl?.dataset.base) || 0;
      const bonus = Number(bonusEl?.dataset.bonus) || 0;
      const total = Number(totalEl?.dataset.count) || 0;
      setTimeout(() => {
        countLabel(baseEl, 'Zeit +', base, 700);
        if (bonusEl) setTimeout(() => countLabel(bonusEl, 'Ersttipp +', bonus, 550), 280);
        countLabel(totalEl, '+', total, 900);
      }, 120 + idx * 80);
    });
  }

  async function syncClock() {
    const t0 = Date.now();
    const res = await emit('clock:ping');
    const t1 = Date.now();
    if (res?.serverNow) {
      const rtt = t1 - t0;
      clockOffsetMs = res.serverNow - (t0 + rtt / 2);
    }
    return clockOffsetMs;
  }

  function racePointsPreview(elapsedMs) {
    const windowMs = state?.current?.raceWindowMs || raceMeta.windowMs || 30000;
    const max = raceMeta.maxPoints || 100;
    const min = raceMeta.minPoints || 10;
    const t = Math.min(1, Math.max(0, elapsedMs) / windowMs);
    return Math.max(min, Math.round(max * (1 - t)));
  }

  function seesSharedReveal() {
    const cur = state?.current;
    if (!cur) return false;
    return !!(cur.revealed || state.phase === 'reveal');
  }

  function connect() {
    if (socket) return socket;
    socket = io({
      path: GB ? `${GB}/socket.io` : '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.on('state:update', (next) => {
      if (leaving) return;
      state = next;
      render();
    });
    socket.on('session:returned', () => {
      location.href = '/';
    });
    socket.on('race:arm', (msg) => {
      if (leaving) return;
      void handleRaceArm(msg);
    });
    socket.on('race:go', (msg) => {
      if (leaving) return;
      void handleRaceGo(msg);
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
    if (data.race) raceMeta = { ...raceMeta, ...data.race };
    const ping = data.r2 && data.r2.ping;
    const r2on = ping ? !!ping.ok : !!(data.r2 && data.r2.enabled);
    let meta = `${catalog.length} Titel · ${data.playableCount || 0} spielbar`;
    if (ping && !ping.ok) meta += ` · R2-Fehler: ${ping.error || 'Bucket nicht erreichbar'}`;
    else if (r2on) meta += ' · R2 an';
    else meta += ' · R2 aus (keine Clips vom Bucket)';
    $('catalogMeta').textContent = meta;
  }

  const GUESS_SUGGEST_LIMIT = 12;

  function filterSongs(query) {
    const q = String(query || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!q) return [];
    return catalog.filter((s) => {
      const t = String(s.title || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
      return t.includes(q);
    });
  }

  function renderGuessResults(query, { open } = { open: true }) {
    const box = $('guessResults');
    if (!box) return;
    const q = String(query || '').trim();
    if (!open || !q) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const hits = filterSongs(q).slice(0, GUESS_SUGGEST_LIMIT);
    if (!hits.length) {
      box.innerHTML = '<li class="empty">Kein Treffer im Katalog</li>';
      box.hidden = false;
      return;
    }
    box.innerHTML = hits
      .map(
        (s, i) =>
          `<li data-title="${escapeHtml(s.title)}" class="${i === 0 ? 'active' : ''}">${escapeHtml(s.title)}</li>`
      )
      .join('');
    box.hidden = false;
  }

  function bindGuessSearch() {
    const input = $('guessInput');
    const box = $('guessResults');
    const form = $('guessForm');
    if (!input || !box) return;

    function fillInputFromTitle(title) {
      const t = String(title || '');
      input.value = t;
      try {
        input.setSelectionRange(t.length, t.length);
      } catch {
        /* ignore */
      }
    }

    function moveActive(delta) {
      const items = [...box.querySelectorAll('li[data-title]')];
      if (!items.length || box.hidden) return false;
      let idx = items.findIndex((el) => el.classList.contains('active'));
      if (idx < 0) idx = 0;
      const current = items[idx];
      const currentTitle = current.dataset.title || current.textContent || '';

      // First Tab/arrow: put highlighted hit into the input so selection is obvious.
      if (input.value !== currentTitle) {
        items.forEach((el) => el.classList.remove('active'));
        current.classList.add('active');
        fillInputFromTitle(currentTitle);
        current.scrollIntoView({ block: 'nearest' });
        return true;
      }

      const next = items[(idx + delta + items.length) % items.length];
      items.forEach((el) => el.classList.remove('active'));
      next.classList.add('active');
      fillInputFromTitle(next.dataset.title || next.textContent || '');
      next.scrollIntoView({ block: 'nearest' });
      return true;
    }

    function openSuggestions() {
      renderGuessResults(input.value, { open: true });
    }

    input.addEventListener('input', openSuggestions);
    input.addEventListener('focus', openSuggestions);
    // Clicking an already-focused field must reopen the list (focus won't fire again).
    input.addEventListener('click', openSuggestions);
    input.addEventListener('keydown', (e) => {
      const items = [...box.querySelectorAll('li[data-title]')];
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
        // Enter = rate what's in the field (Tab/click choose the title).
        // Do not overwrite typed text with the first/active hit — that hid the list
        // feeling broken after a wrong auto-pick from a full-catalog dropdown.
        if (listOpen) {
          e.preventDefault();
          renderGuessResults('', { open: false });
          if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
          else form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
        return;
      }
      if (e.key === 'Escape') {
        renderGuessResults('', { open: false });
      }
    });
    box.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-title]');
      if (!li) return;
      e.preventDefault();
      fillInputFromTitle(li.dataset.title || li.textContent);
      renderGuessResults('', { open: false });
    });
    document.addEventListener('click', (e) => {
      if (e.target === input || box.contains(e.target)) return;
      renderGuessResults('', { open: false });
    });
  }

  function renderPlayers(listEl, mode) {
    if (!listEl) return;
    listEl.innerHTML = (state?.players || [])
      .map((p) => {
        const you = p.id === playerId ? ' (du)' : '';
        const host = p.id === state.hostId ? ' ★' : '';
        let right = `<span>${p.score || 0} P</span>`;
        if (mode === 'lobby') {
          right = p.connected === false ? '<span>offline</span>' : '<span>da</span>';
        }
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
        return `<span class="stage-step ${cls}" title="${fmtSec(sec)}"><i class="stage-bar" aria-hidden="true"></i><b class="stage-label">${fmtSec(sec)}</b></span>`;
      })
      .join('');
    $('stageLabel').textContent = cur?.stageSeconds != null ? fmtSec(cur.stageSeconds) : '—';
  }

  function clipKey(songId, dur) {
    return `${songId}:${Number(dur)}`;
  }

  function clearClipCache() {
    for (const url of clipCache.values()) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    clipCache.clear();
    clipCacheSongId = null;
  }

  function clipUrl(songId, dur) {
    return `${GB}/api/clip/${encodeURIComponent(songId)}?dur=${encodeURIComponent(dur)}`;
  }

  async function preloadRoundClips(songId, stageList) {
    if (!songId) return;
    if (clipCacheSongId && clipCacheSongId !== songId) clearClipCache();
    clipCacheSongId = songId;
    const durs = stageList && stageList.length ? stageList : stages;
    await Promise.all(
      durs.map(async (dur) => {
        const key = clipKey(songId, dur);
        if (clipCache.has(key)) return;
        try {
          const res = await fetch(clipUrl(songId, dur));
          if (!res.ok) return;
          const blob = await res.blob();
          if (clipCacheSongId !== songId) return;
          clipCache.set(key, URL.createObjectURL(blob));
        } catch {
          /* best-effort warm */
        }
      })
    );
  }

  function resolveClipSrc(songId, dur) {
    const cached = clipCache.get(clipKey(songId, dur));
    return cached || clipUrl(songId, dur);
  }

  function setPlayUi({ playing, caption, disabled }) {
    const btn = $('btnPlay');
    const core = btn?.querySelector('.play-orb-core');
    const cap = $('playCaption');
    if (btn) {
      btn.classList.toggle('playing', !!playing);
      btn.disabled = !!disabled;
    }
    if (core) core.textContent = playing ? '❚❚' : '▶';
    if (cap && caption != null) cap.textContent = caption;
  }

  function stopAudio({ expected = true } = {}) {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    audioToken += 1;
    if (audio) {
      try { audio.pause(); } catch { /* ignore */ }
      audio = null;
    }
    revealPlaying = false;
    const revealBtn = $('btnRevealPlay');
    if (revealBtn) revealBtn.textContent = '▶ Song anhören';
    resetRevealTransport();
    setPlayUi({ playing: false, caption: expected ? 'Ab Cue hören' : undefined, disabled: false });
  }

  function isBenignPlayError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('interrupted') || msg.includes('aborted') || msg.includes('the play() request was interrupted');
  }

  function playClip({ auto = false, atServerMs = null, durOverride = null } = {}) {
    const cur = state?.current;
    if (!cur?.songId || seesSharedReveal()) return;
    if (cur.matchDone || cur.waitingForOthers) return;
    stopAudio({ expected: true });
    const token = audioToken;
    const dur = durOverride != null ? Number(durOverride) : Number(cur.stageSeconds) || 0.1;
    const src = resolveClipSrc(cur.songId, dur);
    const el = new Audio(src);
    audio = el;
    el.preload = 'auto';
    applyVolume(el, 'play');
    setPlayUi({
      playing: false,
      caption: atServerMs != null ? 'Startet gleich…' : 'Lädt Clip…',
      disabled: true,
    });

    const start = () => {
      if (token !== audioToken || audio !== el) return;
      const begin = () => {
        if (token !== audioToken || audio !== el) return;
        const p = el.play();
        if (p && p.catch) {
          p.catch((err) => {
            if (token !== audioToken) return;
            if (isBenignPlayError(err)) return;
            setPlayUi({
              playing: false,
              caption: auto ? 'Tippe ▶ zum Start' : `Audio-Fehler: ${err?.message || 'play blocked'}`,
              disabled: false,
            });
          });
        }
        setPlayUi({ playing: true, caption: `Spielt ${fmtSec(dur)}…`, disabled: false });
        stopTimer = setTimeout(() => {
          if (token !== audioToken) return;
          try { el.pause(); } catch { /* ignore */ }
          setPlayUi({
            playing: false,
            caption: raceModeOn() ? 'Weiter tippen oder warten' : 'Ab Cue hören',
            disabled: false,
          });
        }, Math.max(80, dur * 1000 + 40));
      };

      if (atServerMs != null && Number.isFinite(atServerMs)) {
        const wait = Math.max(0, atServerMs - clockOffsetMs - Date.now());
        if (wait > 5) {
          setPlayUi({ playing: false, caption: `Start in ${(wait / 1000).toFixed(1).replace('.', ',')}s…`, disabled: true });
          stopTimer = setTimeout(begin, wait);
          return;
        }
      }
      begin();
    };

    el.addEventListener('error', async () => {
      if (token !== audioToken || audio !== el) return;
      const hint = $('playCaption');
      if (!hint) return;
      // Cached blob may be stale — fall back to network once.
      if (src.startsWith('blob:')) {
        try {
          const res = await fetch(clipUrl(cur.songId, dur));
          if (res.ok) {
            const blob = await res.blob();
            const fresh = URL.createObjectURL(blob);
            clipCache.set(clipKey(cur.songId, dur), fresh);
            if (token !== audioToken) return;
            playClip({ auto, atServerMs, durOverride });
            return;
          }
          const j = await res.json().catch(() => ({}));
          hint.textContent = j.error || `Clip-Fehler HTTP ${res.status}`;
        } catch {
          hint.textContent = 'Clip konnte nicht geladen werden (R2/Audio).';
        }
      } else {
        try {
          const r = await fetch(src);
          const j = await r.json().catch(() => ({}));
          hint.textContent = j.error || `Clip-Fehler HTTP ${r.status}`;
        } catch {
          hint.textContent = 'Clip konnte nicht geladen werden (R2/Audio).';
        }
      }
      setPlayUi({ playing: false, caption: hint.textContent, disabled: false });
    });

    if (el.readyState >= 2) start();
    else el.addEventListener('canplay', start, { once: true });
  }

  async function handleRaceArm(msg) {
    const songId = msg?.songId || state?.current?.songId;
    if (!songId) return;
    const key = `${songId}:${msg?.serverNow || 0}`;
    if (key === lastRaceArmKey) return;
    lastRaceArmKey = key;
    lastRaceGoKey = null;
    racePlayScheduled = false;
    await syncClock();
    const clipSec = Number(msg?.clipSec) || raceMeta.clipSec || 30;
    setPlayUi({ playing: false, caption: 'Lädt Race-Clip…', disabled: true });
    await preloadRoundClips(songId, [clipSec]);
    const res = await emit('race:armed', { songId });
    if (res.error) {
      setPlayUi({ playing: false, caption: res.error, disabled: false });
      return;
    }
    setPlayUi({ playing: false, caption: 'Bereit — warte auf Start…', disabled: true });
  }

  async function handleRaceGo(msg) {
    const songId = msg?.songId || state?.current?.songId;
    if (!songId || !msg?.playAt) return;
    const key = `${songId}:${msg.playAt}`;
    if (key === lastRaceGoKey) return;
    lastRaceGoKey = key;
    if (Number.isFinite(msg.serverNow)) {
      clockOffsetMs = msg.serverNow - Date.now();
    } else {
      await syncClock();
    }
    if (state?.current) {
      state.current.playAt = msg.playAt;
      state.current.endsAt = msg.endsAt;
      state.current.raceGoFired = true;
    }
    racePlayScheduled = true;
    const clipSec = Number(msg?.clipSec) || raceMeta.clipSec || 30;
    await preloadRoundClips(songId, [clipSec]);
    playClip({ auto: true, atServerMs: msg.playAt, durOverride: clipSec });
    startRaceCountdown();
    render();
    focusGuessInput();
  }

  function startRaceCountdown() {
    clearRaceCountdown();
    const tick = () => {
      const cur = state?.current;
      const hud = $('raceHud');
      if (!raceModeOn() || !cur || seesSharedReveal()) {
        clearRaceCountdown();
        return;
      }
      if (hud) hud.hidden = false;
      renderRaceStandingsList(cur.standings || []);
      maybeShowErsttipp(cur);
      updateRaceTitleHint(cur);
      const playAt = cur.playAt;
      const endsAt = cur.endsAt;
      const now = serverNowApprox();
      const timerEl = $('raceTimer');
      const ptsEl = $('racePointsPreview');
      if (playAt == null) {
        if (timerEl) timerEl.textContent = '…';
        if (ptsEl) ptsEl.textContent = 'Warte auf Start';
        return;
      }
      if (now < playAt) {
        const left = ((playAt - now) / 1000).toFixed(1).replace('.', ',');
        if (timerEl) timerEl.textContent = `in ${left}s`;
        if (ptsEl) {
          ptsEl.textContent =
            `Start · max ${raceMeta.maxPoints || 100} P` +
            (cur.firstBonusAwarded ? '' : ` (+${raceMeta.firstBonus || 25} Ersttipp)`);
        }
        return;
      }
      const remainMs = Math.max(0, (endsAt || playAt + (cur.raceWindowMs || raceMeta.windowMs)) - now);
      const remain = (remainMs / 1000).toFixed(1).replace('.', ',');
      if (timerEl) timerEl.textContent = `${remain}s`;
      const preview = cur.myGuess?.done
        ? cur.myGuess.points
        : racePointsPreview(now - playAt);
      if (ptsEl) {
        ptsEl.textContent = cur.myGuess?.done
          ? `Dein Ergebnis: +${preview} P`
          : `jetzt ~${preview} P` + (cur.firstBonusAwarded ? '' : ` (+${raceMeta.firstBonus || 25} Ersttipp)`);
      }
    };
    tick();
    raceCountdownTimer = setInterval(tick, 100);
  }

  function playRevealTrack({ auto = false } = {}) {
    const cur = state?.current;
    if (!cur?.songId || !seesSharedReveal()) return;
    if (!auto && revealPlaying && audio) {
      stopAudio({ expected: true });
      resetRevealTransport();
      return;
    }
    stopAudio({ expected: true });
    resetRevealTransport();
    const token = audioToken;
    // Full song from the start (not from cue) on reveal.
    const url = `${GB}/api/audio/${encodeURIComponent(cur.songId)}?t=${Date.now()}`;
    const el = new Audio(url);
    audio = el;
    el.preload = 'auto';
    applyVolume(el, 'reveal');
    const btn = $('btnRevealPlay');
    if (btn) btn.textContent = 'Lädt…';
    syncRevealVolumeSlider();

    const wireTransport = () => {
      if (token !== audioToken || audio !== el) return;
      updateRevealTransport(el);
    };

    const start = () => {
      if (token !== audioToken || audio !== el) return;
      try {
        el.currentTime = 0;
      } catch { /* seek best-effort */ }
      wireTransport();
      const p = el.play();
      if (p && p.catch) {
        p.catch((err) => {
          if (token !== audioToken) return;
          if (isBenignPlayError(err)) return;
          if (btn) btn.textContent = auto ? '▶ Tippen zum Abspielen' : `▶ Fehler: ${err?.message || 'play'}`;
          revealPlaying = false;
        });
      }
      revealPlaying = true;
      if (btn) btn.textContent = '❚❚ Pause';
    };

    el.addEventListener('loadedmetadata', wireTransport);
    el.addEventListener('timeupdate', wireTransport);
    el.addEventListener('ended', () => {
      if (token !== audioToken) return;
      revealPlaying = false;
      if (btn) btn.textContent = '▶ Song anhören';
      updateRevealTransport(el);
    });
    el.addEventListener('error', () => {
      if (token !== audioToken) return;
      revealPlaying = false;
      if (btn) btn.textContent = '▶ Audio fehlt';
      resetRevealTransport();
    });

    if (el.readyState >= 2) start();
    else el.addEventListener('canplay', start, { once: true });
  }

  function maybeResetRoundUi() {
    const cur = state?.current;
    if (!cur?.songId) return;
    const roundKey = `${cur.round}:${cur.songId}`;
    if (roundKey === lastRoundKey) return;
    lastRoundKey = roundKey;
    lastStageAutoKey = null;
    lastRaceArmKey = null;
    lastRaceGoKey = null;
    lastErsttippKey = null;
    lastRevealFxKey = null;
    racePlayScheduled = false;
    clearRaceCountdown();
    clearLetterReveal();
    clearCountUps();
    renderRaceStandingsList([]);
    updateRaceTitleHint(null);
    if (state?.current) {
      state.current.standings = [];
      state.current.firstBonusAwarded = false;
    }
    const ptsEl = $('racePointsPreview');
    if (ptsEl) ptsEl.textContent = `bis ${raceMeta.maxPoints || 100} P`;
    const input = $('guessInput');
    const feedback = $('feedback');
    if (input) {
      input.value = '';
      input.disabled = false;
    }
    if (feedback) {
      feedback.textContent = '';
      feedback.className = 'feedback';
    }
    renderGuessResults('', { open: false });
    renderGuessAttempts([]);
    stopAudio({ expected: true });
    if (raceModeOn()) {
      void preloadRoundClips(cur.songId, [cur.raceClipSec || raceMeta.clipSec || 30]);
    } else {
      void preloadRoundClips(cur.songId, cur.stages || stages);
    }
  }

  function updateLeaveButton() {
    const btn = $('btnLeave');
    if (!btn) return;
    btn.hidden = !(state && ['lobby', 'playing', 'reveal', 'finished'].includes(state.phase));
  }

  function openLeaveModal() {
    const modal = $('leaveModal');
    if (!modal) return;
    leaveFocusRestore = document.activeElement;
    modal.hidden = false;
    const cancel = $('btnLeaveCancel');
    if (cancel) {
      try {
        cancel.focus({ preventScroll: true });
      } catch {
        cancel.focus();
      }
    }
  }

  function closeLeaveModal() {
    const modal = $('leaveModal');
    if (modal) modal.hidden = true;
    const restore = leaveFocusRestore;
    leaveFocusRestore = null;
    if (restore && typeof restore.focus === 'function') {
      try {
        restore.focus({ preventScroll: true });
      } catch {
        restore.focus();
      }
    }
  }

  async function confirmLeave() {
    leaving = true;
    closeLeaveModal();
    stopAudio({ expected: true });
    clearClipCache();
    try {
      await emit('session:return-to-lobby');
    } catch { /* navigate anyway */ }
    state = null;
    playerId = null;
    lastRoundKey = null;
    lastRevealAutoKey = null;
    try {
      history.replaceState({}, '', `${GB || location.pathname}`);
    } catch { /* ignore */ }
    location.href = '/';
  }

  function renderLobby() {
    show('lobby');
    renderPlayers($('playerList'), 'lobby');
    $('btnStart').hidden = !isHost();
    $('roundsField').hidden = !isHost();
    $('roundsInput').value = state.settings?.rounds || 5;
    const race = raceModeOn();
    syncLobbyModeCards();
    const syncField = $('syncRevealField');
    const syncToggle = $('syncRevealToggle');
    if (syncField && syncToggle) {
      syncField.hidden = !!state.solo || race;
      syncToggle.checked = syncRevealOn();
      syncToggle.disabled = !isHost() || state.phase !== 'lobby' || race;
    }
    if (state.solo) {
      $('lobbyHint').textContent = race
        ? 'Solo Race — 30s Fenster, Punkte fallen mit der Zeit.'
        : 'Solo — starte direkt, wenn du bereit bist.';
    } else if (isHost()) {
      if (race) {
        $('lobbyHint').textContent = 'Party-Host — Race: synchroner Start, 30s Fenster, Ersttipp-Bonus.';
      } else {
        $('lobbyHint').textContent = syncRevealOn()
          ? 'Party-Host — starte direkt. Gemeinsames Aufdecken: an.'
          : 'Party-Host — starte direkt. Ohne Zwischenstand, Scoreboard erst am Ende.';
      }
    } else {
      $('lobbyHint').textContent = race
        ? 'Party — Race-Modus. Warte, bis der Host startet.'
        : 'Party — warte, bis der Host startet.';
    }
    void refreshLobbyHighscore();
    focusPrimaryControl('lobby');
  }

  function formatRoundChip(cur) {
    const n = cur?.round || (state?.roundIndex != null ? state.roundIndex + 1 : 1);
    const total = cur?.totalRounds || state?.totalRounds || state?.settings?.rounds || 5;
    return `Runde ${n}/${total}`;
  }

  function isLastRound(cur) {
    const n = Number(cur?.round) || (state?.roundIndex != null ? state.roundIndex + 1 : 0);
    const total = Number(cur?.totalRounds) || Number(state?.totalRounds) || 0;
    return total > 0 && n >= total;
  }

  function renderPlay() {
    show('play');
    maybeResetRoundUi();
    const cur = state.current;
    const race = raceModeOn();
    $('roundLabel').textContent = formatRoundChip(cur);
    const stageTrack = $('stageTrack');
    const raceHud = $('raceHud');
    if (race) {
      if (stageTrack) stageTrack.hidden = true;
      if (raceHud) raceHud.hidden = false;
      $('stageLabel').textContent = 'Race';
      startRaceCountdown();
    } else {
      if (stageTrack) stageTrack.hidden = false;
      if (raceHud) raceHud.hidden = true;
      clearRaceCountdown();
      renderStageTrack();
    }
    const done = !!cur?.myGuess?.done;
    $('guessInput').disabled = done || (race && !cur?.raceGoFired);
    const skipBtn = $('btnSkip');
    if (skipBtn) {
      skipBtn.textContent = race ? 'Aufgeben' : 'Skippen';
      skipBtn.disabled = done || (race && !cur?.raceGoFired);
    }
    const submit = $('btnGuess') || $('guessForm').querySelector('button[type="submit"]');
    if (submit) submit.disabled = done || (race && !cur?.raceGoFired);
    renderGuessAttempts(cur?.myGuess?.attempts || []);
    setPlayUi({
      playing: $('btnPlay')?.classList.contains('playing'),
      caption: done
        ? race || syncRevealOn()
          ? 'Runde für dich beendet'
          : 'Nächste Runde…'
        : race
          ? cur?.raceGoFired
            ? 'Race läuft'
            : 'Bereit machen…'
          : 'Ab Cue hören',
      disabled: done || (race && !cur?.raceGoFired),
    });
    if (done && (race || syncRevealOn())) {
      const bonus = cur.myGuess.firstBonus ? ' (Ersttipp-Bonus)' : '';
      $('feedback').textContent = cur.myGuess.correct
        ? `Richtig! +${cur.myGuess.points} Punkte${bonus} — warte auf die anderen…`
        : 'Runde beendet — warte auf die anderen…';
      $('feedback').className = `feedback ${cur.myGuess.correct ? 'ok' : ''}`;
    }
    if (race) {
      // Lockstep playback comes from race:go — only arm if we missed the event.
      if (!cur?.raceGoFired && cur?.songId && !racePlayScheduled) {
        const armKey = `missed:${cur.round}:${cur.songId}`;
        if (armKey !== lastRaceArmKey) {
          void handleRaceArm({ songId: cur.songId, clipSec: cur.raceClipSec || raceMeta.clipSec, serverNow: cur.serverNow });
        }
      } else if (cur?.raceGoFired && cur?.playAt && !racePlayScheduled && !done) {
        void handleRaceGo({
          songId: cur.songId,
          playAt: cur.playAt,
          endsAt: cur.endsAt,
          clipSec: cur.raceClipSec || raceMeta.clipSec,
          serverNow: cur.serverNow,
        });
      }
      maybeShowErsttipp(cur);
      updateRaceTitleHint(cur);
      return;
    }
    // Classic: Autoplay current stage once per stage (round start + after skip/wrong).
    if (!done && cur?.songId) {
      const stageKey = `${cur.round}:${cur.songId}:${cur.stageIndex ?? 0}`;
      if (stageKey !== lastStageAutoKey) {
        lastStageAutoKey = stageKey;
        const run = () => playClip({ auto: true });
        void preloadRoundClips(cur.songId, cur.stages || stages).then(run);
      }
    }
  }

  function renderWait() {
    show('wait');
    stopAudio({ expected: true });
    const done = state.current?.playersDone ?? 0;
    const total = (state.players || []).filter((p) => p.connected !== false).length;
    const waitRound = $('waitRoundLabel');
    if (waitRound) waitRound.textContent = formatRoundChip(state.current);
    $('waitHint').textContent =
      `Du hast alle Runden gespielt (${done}/${total} fertig). Kein Zwischenstand — das Scoreboard kommt, wenn alle durch sind.`;
    renderPlayers($('waitList'), 'scores');
  }

  function focusPrimaryControl(viewName) {
    const key = `${viewName}:${state?.phase || ''}:${state?.current?.round || 0}:${state?.current?.songId || ''}`;
    if (key === lastFocusViewKey) return;
    lastFocusViewKey = key;
    const focusEl = (el) => {
      if (!el || el.hidden || el.disabled) return false;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
      return true;
    };
    if (viewName === 'lobby') {
      const name = $('nameInput');
      if (name && !String(name.value || '').trim()) {
        focusEl(name);
        return;
      }
      if (isHost()) focusEl($('btnStart'));
      else focusEl($('lobbyModeClassic') || $('nameInput'));
      return;
    }
    if (viewName === 'play') {
      if (raceModeOn() && state?.current?.raceGoFired) focusGuessInput();
      else focusEl($('btnPlay'));
      return;
    }
    if (viewName === 'reveal') {
      if (isHost()) focusEl($('btnNext'));
      else focusEl($('btnRevealPlay'));
      return;
    }
    if (viewName === 'finished') {
      focusEl($('btnAgain'));
    }
  }

  function renderRevealView() {
    show('reveal');
    const cur = state.current;
    const revealRound = $('revealRoundLabel');
    if (revealRound) revealRound.textContent = formatRoundChip(cur);
    const fxKey = `${state.roundIndex}:${cur?.songId || ''}:reveal`;
    const sub = $('revealSub');
    if (sub) {
      sub.textContent = cur?.artist || '';
      sub.style.opacity = '0';
    }
    if (fxKey !== lastRevealFxKey) {
      lastRevealFxKey = fxKey;
      animateLetterReveal(cur?.title || '—');
      setTimeout(() => {
        if (sub) {
          sub.style.transition = 'opacity 0.45s ease';
          sub.style.opacity = '1';
        }
      }, Math.min(1200, String(cur?.title || '').length * 48 + 200));
      renderRevealBreakdown($('revealList'), cur?.standings || [], state.players || []);
    }
    const btnNext = $('btnNext');
    if (btnNext) {
      btnNext.hidden = !(isHost() && seesSharedReveal());
      btnNext.textContent = isLastRound(cur) ? 'Ergebnisse' : 'Nächste Runde';
    }
    const wait = $('revealWaitHint');
    if (wait) wait.hidden = true;
    const autoKey = `${state.roundIndex}:${cur?.songId || ''}`;
    if (seesSharedReveal() && cur?.songId && autoKey !== lastRevealAutoKey) {
      lastRevealAutoKey = autoKey;
      playRevealTrack({ auto: true });
    }
    focusPrimaryControl('reveal');
  }

  function renderRoundRecap() {
    const box = $('roundRecap');
    if (!box) return;
    const recap = state.roundRecap || [];
    if (!recap.length) {
      box.innerHTML = '<p class="hint">Keine Runden-Details verfügbar.</p>';
      return;
    }
    box.innerHTML = recap
      .map((entry) => {
        const rows = (entry.results || [])
          .map((r) => {
            const base = r.basePoints != null ? r.basePoints : r.points || 0;
            const bonus = r.bonusPoints || 0;
            let pts = r.points > 0 ? `+${r.points}` : r.giveUp ? '0 (Skip)' : '0';
            if (r.points > 0 && (bonus > 0 || raceModeOn())) {
              pts = bonus > 0 ? `+${base} · +${bonus} Bonus` : `+${base}`;
            }
            return `<li><span>${escapeHtml(r.name)}</span><span>${pts}</span></li>`;
          })
          .join('');
        return `<article class="recap-round">
          <header><strong>Runde ${entry.round}</strong> — ${escapeHtml(entry.title || '?')}
            <span class="recap-artist">${escapeHtml(entry.artist || '')}</span>
          </header>
          <ul class="player-list">${rows}</ul>
        </article>`;
      })
      .join('');
  }

  function playVictoryFanfare() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i === notes.length - 1 ? 'triangle' : 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03 + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35 + i * 0.09);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + 0.45 + i * 0.09);
      });
      const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const noise = ctx.createBufferSource();
      const nGain = ctx.createGain();
      noise.buffer = noiseBuf;
      nGain.gain.setValueAtTime(0.08, now + 0.15);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      noise.connect(nGain);
      nGain.connect(ctx.destination);
      noise.start(now + 0.15);
      setTimeout(() => {
        try {
          ctx.close();
        } catch { /* ignore */ }
      }, 1200);
    } catch { /* autoplay / unsupported */ }
  }

  function stopConfetti() {
    if (confettiRaf) {
      cancelAnimationFrame(confettiRaf);
      confettiRaf = null;
    }
    const canvas = $('finishedConfetti');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function burstConfetti() {
    const canvas = $('finishedConfetti');
    if (!canvas) return;
    stopConfetti();
    const parent = canvas.parentElement;
    const w = Math.max(320, parent?.clientWidth || window.innerWidth);
    const h = Math.max(400, parent?.clientHeight || 520);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const colors = ['#f0c96a', '#d4a84b', '#f3eee4', '#6fbf8a', '#e8b84a'];
    const parts = Array.from({ length: 72 }, () => ({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.35,
      r: 3 + Math.random() * 5,
      vy: 1.6 + Math.random() * 3.2,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.12 + Math.random() * 0.24,
      color: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    const tick = (t) => {
      const elapsed = t - start;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, 1 - elapsed / 3200);
        ctx.fillRect(-p.r, -p.r * 0.4, p.r * 2, p.r * 0.8);
        ctx.restore();
      }
      if (elapsed < 3200) confettiRaf = requestAnimationFrame(tick);
      else stopConfetti();
    };
    confettiRaf = requestAnimationFrame(tick);
  }

  function renderFinished() {
    show('finished');
    stopAudio({ expected: true });
    const winner = state.winner || (state.leaderboard && state.leaderboard[0]) || null;
    const nameEl = $('winnerName');
    const scoreEl = $('winnerScore');
    const labelEl = $('finishedWinLabel');
    const eyebrow = $('finishedEyebrow');
    if (eyebrow) eyebrow.textContent = state.solo ? 'Solo-Finale' : 'Party-Finale';
    if (labelEl) labelEl.textContent = winner ? 'SIEGER' : 'ENDE';
    if (nameEl) nameEl.textContent = winner ? String(winner.name || '—').toUpperCase() : 'NIEMAND';
    if (scoreEl) {
      scoreEl.textContent = winner
        ? `${winner.score || 0} Punkte über alle Runden`
        : 'Kein Scoreboard';
    }
    const standingsTitle = $('standingsTitle');
    if (standingsTitle) {
      standingsTitle.hidden = !(state.leaderboard && state.leaderboard.length);
    }
    $('leaderboard').innerHTML = (state.leaderboard || [])
      .map((p) => `<li><span>${escapeHtml(p.name)}</span><strong>${p.score || 0}</strong></li>`)
      .join('');
    renderRoundRecap();

    const btn = $('btnAgain');
    const hint = $('finishedHostHint');
    const party = !!(state.partyId || partyId) && !state.solo;
    if (party) {
      if (btn) {
        btn.hidden = !isHost();
        btn.textContent = 'Noch eine Runde';
      }
      if (hint) {
        hint.hidden = isHost();
        hint.textContent = 'Warte auf den Host — noch eine Runde…';
      }
    } else {
      if (btn) {
        btn.hidden = false;
        btn.textContent = 'Nochmal';
      }
      if (hint) hint.hidden = true;
    }

    const fanfareKey = `${state.code || 'solo'}:${(state.leaderboard || [])
      .map((p) => `${p.id}:${p.score}`)
      .join('|')}`;
    if (fanfareKey !== finishedFanfareKey) {
      finishedFanfareKey = fanfareKey;
      burstConfetti();
      playVictoryFanfare();
    }
    void refreshFinishedHighscore();
    focusPrimaryControl('finished');
  }

  function render() {
    if (!state) return;
    const self = me();
    if (self) {
      $('scoreChip').hidden = false;
      $('scoreValue').textContent = String(self.score || 0);
    }
    updateLeaveButton();

    if (state.phase === 'lobby') {
      stopAudio({ expected: true });
      clearRaceCountdown();
      stopConfetti();
      finishedFanfareKey = null;
      lastRoundKey = null;
      lastRevealAutoKey = null;
      lastRaceArmKey = null;
      lastRaceGoKey = null;
      racePlayScheduled = false;
      renderLobby();
      return;
    }

    if (state.phase === 'finished') {
      clearRaceCountdown();
      renderFinished();
      return;
    }

    if (
      !syncRevealOn() &&
      !raceModeOn() &&
      state.phase === 'playing' &&
      (state.current?.matchDone || state.current?.waitingForOthers)
    ) {
      clearRaceCountdown();
      renderWait();
      return;
    }

    if ((raceModeOn() || syncRevealOn()) && (state.phase === 'reveal' || seesSharedReveal())) {
      clearRaceCountdown();
      renderRevealView();
      return;
    }

    if (state.phase === 'playing') renderPlay();
  }

  async function startSolo({ mode = 'classic' } = {}) {
    const name = ($('nameInput').value || prefillName || 'Solo').trim() || 'Solo';
    $('nameInput').value = name;
    localStorage.setItem('mj-headle-name', name);
    const rounds = Number($('homeRoundsInput')?.value) || Number($('roundsInput')?.value) || 5;
    if ($('roundsInput')) $('roundsInput').value = String(rounds);
    connect();
    show('lobby');
    const res = await emit('room:create-solo', {
      name,
      rounds,
      mode: mode === 'race' ? 'race' : 'classic',
    });
    if (res.error) {
      $('lobbyHint').textContent = res.error;
      return;
    }
    playerId = res.playerId;
    state = res.state;
    leaving = false;
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
    leaving = false;
    render();
  }

  function bindModeCards() {
    const homeClassic = $('modeCardClassic');
    const homeRace = $('modeCardRace');
    if (homeRace) {
      homeRace.addEventListener('mouseenter', () => setHomeRacePreview(true));
      homeRace.addEventListener('focus', () => setHomeRacePreview(true));
      homeRace.addEventListener('click', () => {
        setHomeRacePreview(true);
        if (!$('nameInput').value) $('nameInput').value = prefillName || 'Solo';
        startSolo({ mode: 'race' });
      });
    }
    if (homeClassic) {
      homeClassic.addEventListener('mouseenter', () => setHomeRacePreview(false));
      homeClassic.addEventListener('focus', () => setHomeRacePreview(false));
      homeClassic.addEventListener('click', () => {
        setHomeRacePreview(false);
        if (!$('nameInput').value) $('nameInput').value = prefillName || 'Solo';
        startSolo({ mode: 'classic' });
      });
    }
    const homeLayout = document.querySelector('.home-layout');
    homeLayout?.addEventListener('mouseleave', () => {
      if (!partyId) setHomeRacePreview(false);
    });

    $('lobbyModeClassic')?.addEventListener('click', () => applyLobbyMode('classic'));
    $('lobbyModeRace')?.addEventListener('click', () => applyLobbyMode('race'));
    $('homeRoundsInput')?.addEventListener('input', () => {
      setHomeRacePreview(true);
      void refreshHomeHighscore();
    });
    $('homeRoundsInput')?.addEventListener('change', () => {
      const n = Number($('homeRoundsInput').value) || 5;
      if ($('roundsInput')) $('roundsInput').value = String(n);
      void refreshHomeHighscore();
    });
  }

  bindModeCards();

  $('roundsInput').addEventListener('change', async () => {
    if (!isHost()) return;
    await emit('lobby:set-rounds', { rounds: Number($('roundsInput').value) || 5 });
    void refreshLobbyHighscore();
  });
  $('roundsInput').addEventListener('input', () => {
    void refreshLobbyHighscore();
  });

  $('syncRevealToggle')?.addEventListener('change', async () => {
    if (!isHost()) return;
    const on = !!$('syncRevealToggle').checked;
    const res = await emit('lobby:set-sync-reveal', { syncReveal: on });
    if (res.error) {
      $('lobbyHint').textContent = res.error;
      $('syncRevealToggle').checked = syncRevealOn();
    }
  });

  $('btnStart').addEventListener('click', async () => {
    const res = await emit('game:start');
    if (res.error) {
      $('lobbyHint').textContent =
        res.error +
        (String(res.error).includes('spielbar')
          ? ' → Server braucht R2-Keys (MJ_R2_*) und Songs unter audio/.'
          : '');
    }
  });

  $('btnPlay').addEventListener('click', () => {
    if (raceModeOn()) {
      const cur = state?.current;
      if (!cur?.raceGoFired || !cur?.playAt) return;
      playClip({
        auto: false,
        atServerMs: null,
        durOverride: cur.raceClipSec || raceMeta.clipSec || 30,
      });
      return;
    }
    playClip();
  });
  $('btnRevealPlay')?.addEventListener('click', () => playRevealTrack({ auto: false }));

  function onVolumeInput(e) {
    const pct = Number(e.target.value);
    if (!Number.isFinite(pct)) return;
    setRevealVolume(pct / 100);
  }
  $('audioVolumeReveal')?.addEventListener('input', onVolumeInput);
  syncRevealVolumeSlider(getRevealVolume());

  const seekEl = $('revealSeek');
  if (seekEl) {
    seekEl.addEventListener('pointerdown', () => {
      seekDragging = true;
    });
    const endDrag = () => {
      seekDragging = false;
    };
    seekEl.addEventListener('pointerup', endDrag);
    seekEl.addEventListener('pointercancel', endDrag);
    seekEl.addEventListener('input', () => {
      if (!audio) return;
      const v = Number(seekEl.value);
      if (!Number.isFinite(v)) return;
      try {
        audio.currentTime = v;
      } catch { /* ignore */ }
      updateRevealTransport(audio);
    });
  }

  function applyAckState(res) {
    if (res?.state) {
      state = res.state;
      render();
    }
  }

  function isRevealState(s) {
    const cur = s?.current;
    if (!cur) return false;
    return !!(cur.revealed || s.phase === 'reveal');
  }

  function clearGuessInput({ keepFocus = false } = {}) {
    const input = $('guessInput');
    if (input) {
      input.value = '';
      if (!keepFocus) input.blur();
    }
    renderGuessResults('', { open: false });
  }

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
    applyAckState(res);
    if (res.correct) {
      const bonus = res.firstBonus ? ' (Ersttipp!)' : '';
      $('feedback').textContent = `Richtig! +${res.points}${bonus}`;
      $('feedback').className = 'feedback ok';
      clearGuessInput();
      // Reveal autoplay owns audio — do not stopAudio here (race with playRevealTrack).
      if (!isRevealState(state)) {
        if (!raceModeOn()) stopAudio({ expected: true });
      }
    } else {
      $('feedback').textContent = raceModeOn()
        ? 'Nicht getroffen — weiter tippen'
        : 'Nicht getroffen — nächste Stufe';
      $('feedback').className = 'feedback bad';
      clearGuessInput({ keepFocus: true });
      focusGuessInput();
    }
  });

  $('btnSkip').addEventListener('click', async () => {
    const res = await emit('round:skip');
    if (res.error) {
      $('feedback').textContent = res.error;
      $('feedback').className = 'feedback bad';
      return;
    }
    applyAckState(res);
    clearGuessInput();
  });

  $('btnNext').addEventListener('click', async () => {
    stopAudio({ expected: true });
    clearRaceCountdown();
    lastRevealAutoKey = null;
    lastRaceArmKey = null;
    lastRaceGoKey = null;
    racePlayScheduled = false;
    await emit('round:next');
  });

  $('btnAgain').addEventListener('click', async () => {
    const party = !!(state?.partyId || partyId) && !state?.solo;
    if (party || (state && !state.solo && state.phase === 'finished')) {
      if (!isHost()) return;
      try {
        await emit('game:restart');
      } catch (err) {
        const feedback = $('feedback');
        if (feedback) feedback.textContent = err?.message || 'Restart fehlgeschlagen.';
      }
      return;
    }
    const rematchMode = raceModeOn() ? 'race' : 'classic';
    state = null;
    playerId = null;
    lastRoundKey = null;
    lastRevealAutoKey = null;
    lastRaceArmKey = null;
    lastRaceGoKey = null;
    racePlayScheduled = false;
    finishedFanfareKey = null;
    stopConfetti();
    clearRaceCountdown();
    leaving = false;
    show('home');
    startSolo({ mode: rematchMode });
  });
  $('btnLeave')?.addEventListener('click', () => openLeaveModal());
  $('btnFinishedLeave')?.addEventListener('click', () => openLeaveModal());
  $('btnLeaveCancel')?.addEventListener('click', () => closeLeaveModal());
  $('btnLeaveConfirm')?.addEventListener('click', () => confirmLeave());
  $('leaveModal')?.addEventListener('click', (e) => {
    if (e.target === $('leaveModal')) closeLeaveModal();
  });

  document.addEventListener('keydown', (e) => {
    const modal = $('leaveModal');
    const modalOpen = modal && !modal.hidden;
    if (e.key === 'Escape') {
      if (modalOpen) {
        e.preventDefault();
        closeLeaveModal();
        return;
      }
      const box = $('guessResults');
      if (box && !box.hidden) {
        renderGuessResults('', { open: false });
      }
      return;
    }

    if (modalOpen) {
      if (e.key !== 'Tab') return;
      const focusables = [...modal.querySelectorAll('button, [href], input, select, textarea')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }

    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
    if (e.key === ' ' && !typing) {
      const playView = $('view-play');
      if (playView && !playView.hidden) {
        e.preventDefault();
        $('btnPlay')?.click();
      }
    }
  });

  $('hubLink')?.addEventListener('click', (e) => {
    if (!state) return;
    if (state.phase === 'lobby' && !partyId) return;
    e.preventDefault();
    openLeaveModal();
  });

  $('nameInput').value = prefillName;
  if (partyId) {
    $('homeHint').textContent = `Party ${partyId} — verbinde…`;
    const homePick = document.querySelector('.home-layout');
    if (homePick) homePick.hidden = true;
  }

  loadCatalog()
    .then(() => bindGuessSearch())
    .catch((err) => {
      $('catalogMeta').textContent = `Katalog-Fehler: ${err.message}`;
    });

  if (partyId) joinPartyFlow();
  else show('home');
})();
