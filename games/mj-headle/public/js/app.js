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

  function filterSongs(query) {
    const q = String(query || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (!q) return catalog.slice();
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
    if (!open) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const hits = filterSongs(query);
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
    if (!input || !box) return;
    input.addEventListener('input', () => renderGuessResults(input.value, { open: true }));
    input.addEventListener('focus', () => renderGuessResults(input.value, { open: true }));
    input.addEventListener('keydown', (e) => {
      const items = [...box.querySelectorAll('li[data-title]')];
      if (!items.length) return;
      const idx = items.findIndex((el) => el.classList.contains('active'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = items[(idx + 1) % items.length];
        items.forEach((el) => el.classList.remove('active'));
        next.classList.add('active');
        next.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = items[(idx - 1 + items.length) % items.length];
        items.forEach((el) => el.classList.remove('active'));
        next.classList.add('active');
        next.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const active = items.find((el) => el.classList.contains('active'));
        if (active && box.hidden === false) {
          e.preventDefault();
          input.value = active.dataset.title || active.textContent;
          renderGuessResults('', { open: false });
        }
      } else if (e.key === 'Escape') {
        renderGuessResults('', { open: false });
      }
    });
    box.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-title]');
      if (!li) return;
      e.preventDefault();
      input.value = li.dataset.title || li.textContent;
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
        if (ptsEl) ptsEl.textContent = `Start · max ${raceMeta.maxPoints || 100} P`;
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
      const list = $('raceStandings');
      if (list) {
        const rows = cur.standings || [];
        list.innerHTML = rows
          .map((r) => {
            const ms = r.reactionMs != null ? `${(r.reactionMs / 1000).toFixed(1).replace('.', ',')}s` : '—';
            const bonus = r.firstBonus ? '<span class="bonus">Ersttipp</span>' : '';
            return `<li><span>${escapeHtml(r.name)}${bonus}</span><span>${ms} · +${r.points}</span></li>`;
          })
          .join('');
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
      return;
    }
    stopAudio({ expected: true });
    const token = audioToken;
    // Full song from the start (not from cue) on reveal.
    const url = `${GB}/api/audio/${encodeURIComponent(cur.songId)}?t=${Date.now()}`;
    const el = new Audio(url);
    audio = el;
    el.preload = 'auto';
    const btn = $('btnRevealPlay');
    if (btn) btn.textContent = 'Lädt…';

    const start = () => {
      if (token !== audioToken || audio !== el) return;
      try {
        el.currentTime = 0;
      } catch { /* seek best-effort */ }
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

    el.addEventListener('ended', () => {
      if (token !== audioToken) return;
      revealPlaying = false;
      if (btn) btn.textContent = '▶ Song anhören';
    });
    el.addEventListener('error', () => {
      if (token !== audioToken) return;
      revealPlaying = false;
      if (btn) btn.textContent = '▶ Audio fehlt';
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
    racePlayScheduled = false;
    clearRaceCountdown();
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
    if (modal) modal.hidden = false;
  }

  function closeLeaveModal() {
    const modal = $('leaveModal');
    if (modal) modal.hidden = true;
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
    const modeField = $('modeField');
    const modeToggle = $('modeRaceToggle');
    if (modeField && modeToggle) {
      modeField.hidden = false;
      modeToggle.checked = race;
      modeToggle.disabled = !isHost() || state.phase !== 'lobby';
    }
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
          : 'Party-Host — starte direkt. Ohne Zwischenstand: unabhängig spielen, Scoreboard erst am Ende.';
      }
    } else {
      $('lobbyHint').textContent = race
        ? 'Party — Race-Modus. Warte, bis der Host startet.'
        : 'Party — warte, bis der Host startet.';
    }
  }

  function renderPlay() {
    show('play');
    maybeResetRoundUi();
    const cur = state.current;
    const race = raceModeOn();
    $('roundLabel').textContent = `Runde ${cur?.round || 1}/${cur?.totalRounds || state.totalRounds}`;
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
    const submit = $('guessForm').querySelector('button[type="submit"]');
    if (submit) submit.disabled = done || (race && !cur?.raceGoFired);
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
    $('waitHint').textContent =
      `Du hast alle Runden gespielt (${done}/${total} fertig). Kein Zwischenstand — das Scoreboard kommt, wenn alle durch sind.`;
    renderPlayers($('waitList'), 'scores');
  }

  function renderRevealView() {
    show('reveal');
    const cur = state.current;
    $('revealTitle').textContent = cur?.title || '—';
    $('revealSub').textContent = cur?.artist || '';
    renderPlayers($('revealList'), 'scores');
    $('btnNext').hidden = !(isHost() && seesSharedReveal());
    const wait = $('revealWaitHint');
    if (wait) wait.hidden = true;
    const autoKey = `${state.roundIndex}:${cur?.songId || ''}`;
    if (seesSharedReveal() && cur?.songId && autoKey !== lastRevealAutoKey) {
      lastRevealAutoKey = autoKey;
      playRevealTrack({ auto: true });
    }
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
            const pts = r.points > 0 ? `+${r.points}` : r.giveUp ? '0 (Skip)' : '0';
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

  function renderFinished() {
    show('finished');
    stopAudio({ expected: true });
    $('leaderboard').innerHTML = (state.leaderboard || [])
      .map((p) => `<li><span>${escapeHtml(p.name)}</span><strong>${p.score || 0}</strong></li>`)
      .join('');
    renderRoundRecap();
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

  $('btnSolo').addEventListener('click', () => {
    if (!$('nameInput').value) $('nameInput').value = prefillName || 'Solo';
    startSolo();
  });

  $('roundsInput').addEventListener('change', async () => {
    if (!isHost()) return;
    await emit('lobby:set-rounds', { rounds: Number($('roundsInput').value) || 5 });
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

  $('modeRaceToggle')?.addEventListener('change', async () => {
    if (!isHost()) return;
    const race = !!$('modeRaceToggle').checked;
    const res = await emit('lobby:set-mode', { mode: race ? 'race' : 'classic' });
    if (res.error) {
      $('lobbyHint').textContent = res.error;
      $('modeRaceToggle').checked = raceModeOn();
      return;
    }
    if (res.state) {
      state = res.state;
      render();
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
      clearGuessInput();
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

  $('btnAgain').addEventListener('click', () => {
    state = null;
    playerId = null;
    lastRoundKey = null;
    lastRevealAutoKey = null;
    lastRaceArmKey = null;
    lastRaceGoKey = null;
    racePlayScheduled = false;
    clearRaceCountdown();
    leaving = false;
    show('home');
    startSolo();
  });
  $('btnLeave')?.addEventListener('click', () => openLeaveModal());
  $('btnFinishedLeave')?.addEventListener('click', () => openLeaveModal());
  $('btnLeaveCancel')?.addEventListener('click', () => closeLeaveModal());
  $('btnLeaveConfirm')?.addEventListener('click', () => confirmLeave());
  $('leaveModal')?.addEventListener('click', (e) => {
    if (e.target === $('leaveModal')) closeLeaveModal();
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
    $('btnSolo').hidden = true;
  }

  loadCatalog()
    .then(() => bindGuessSearch())
    .catch((err) => {
      $('catalogMeta').textContent = `Katalog-Fehler: ${err.message}`;
    });

  if (partyId) joinPartyFlow();
  else show('home');
})();
