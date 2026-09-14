(() => {
  const params = new URLSearchParams(location.search);
  const partyId = (params.get('party') || '').toUpperCase();
  const memberId = params.get('member') || '';
  const prefillName =
    params.get('name') || localStorage.getItem('border-path-name') || '';

  const pathMatch = location.pathname.match(/^(.*?\/g\/[^/]+)/);
  const GB = pathMatch ? pathMatch[1] : '';

  const $ = (id) => document.getElementById(id);
  const views = {
    home: $('view-home'),
    play: $('view-play'),
    end: $('view-end'),
  };

  let difficulties = [];
  let difficulty = localStorage.getItem('border-path-diff') || 'medium';
  let sessionId = null;
  let state = null;
  let world = null;
  let countryEls = new Map();
  let socket = null;
  let suggestTimer = null;

  function api(path, opts = {}) {
    return fetch(`${GB}${path}`, {
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data);
      return data;
    });
  }

  function show(name) {
    Object.entries(views).forEach(([key, el]) => {
      if (el) el.hidden = key !== name;
    });
  }

  function project([lon, lat]) {
    return [((lon + 180) / 360) * 960, ((90 - lat) / 180) * 480];
  }

  function ringToPath(ring) {
    if (!ring?.length) return '';
    return (
      ring
        .map((c, i) => {
          const [x, y] = project(c);
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' ') + ' Z'
    );
  }

  function geomToPath(geom) {
    if (!geom) return '';
    if (geom.type === 'Polygon') return geom.coordinates.map(ringToPath).join(' ');
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.map((poly) => poly.map(ringToPath).join(' ')).join(' ');
    }
    return '';
  }

  function featureBBox(feature) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const walk = (coords, depth) => {
      if (depth === 0) {
        for (const c of coords) {
          const [x, y] = project(c);
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        return;
      }
      for (const c of coords) walk(c, depth - 1);
    };
    const g = feature.geometry;
    if (g?.type === 'Polygon') walk(g.coordinates, 1);
    else if (g?.type === 'MultiPolygon') walk(g.coordinates, 2);
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  async function loadWorld() {
    if (world) return world;
    const res = await fetch(`${GB}/api/world`);
    world = await res.json();
    const g = $('countries');
    g.innerHTML = '';
    countryEls = new Map();
    for (const f of world.features || []) {
      const id = f.properties?.id;
      if (!id) continue;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', geomToPath(f.geometry));
      el.setAttribute('class', 'country');
      el.dataset.id = id;
      g.appendChild(el);
      countryEls.set(id, el);
    }
    return world;
  }

  function resetMap() {
    for (const el of countryEls.values()) el.className = 'country';
  }

  function focusRoute(next) {
    const ids = new Set([next.start?.id, next.goal?.id]);
    for (const g of next.guesses || []) ids.add(g.id);
    for (const id of next.revealedHintIds || []) ids.add(id);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const f = (world?.features || []).find((x) => x.properties?.id === id);
      const b = f && featureBBox(f);
      if (!b) continue;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    const svg = $('worldMap');
    if (!Number.isFinite(minX)) {
      svg.style.transform = 'scale(1)';
      return;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = Math.max(80, maxX - minX);
    const h = Math.max(60, maxY - minY);
    const scale = Math.max(1, Math.min(3.2, 0.72 / Math.max(w / 960, h / 480)));
    const tx = (480 - cx) * (scale - 1) * 0.02;
    const ty = (240 - cy) * (scale - 1) * 0.02;
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function paintState(next) {
    if (!next) return;
    state = next;
    sessionId = next.sessionId;
    resetMap();

    countryEls.get(next.start?.id)?.classList.add('is-start');
    countryEls.get(next.goal?.id)?.classList.add('is-goal');

    for (const g of next.guesses || []) {
      const el = countryEls.get(g.id);
      if (!el) continue;
      el.classList.add(`is-${g.quality}`);
      if (g.frontier) el.classList.add('frontier');
    }
    for (const id of next.revealedHintIds || []) {
      const el = countryEls.get(id);
      if (el && !(next.guesses || []).some((g) => g.id === id)) el.classList.add('is-hint');
    }

    $('chipStart').textContent = next.start?.nameDe || '—';
    $('chipGoal').textContent = next.goal?.nameDe || '—';
    $('meterGuesses').textContent = `Versuche: ${next.guessesLeft}`;
    $('meterRemain').textContent = `Rest: ${next.remaining}`;
    $('meterHints').textContent = `Hinweise: ${next.hintsLeft}`;

    const list = $('guessList');
    list.innerHTML = '';
    for (const g of next.guesses || []) {
      const li = document.createElement('li');
      li.className = g.quality;
      li.textContent = `${g.nameDe}${g.frontier ? ' ✓' : ''}`;
      list.appendChild(li);
    }

    focusRoute(next);
    if (next.status === 'won' || next.status === 'lost') showEnd(next);
  }

  function showEnd(next) {
    show('end');
    const won = next.status === 'won';
    $('endTitle').textContent = won
      ? next.perfect
        ? 'Perfect Path'
        : 'Pfad geschlossen'
      : 'Route verloren';
    $('endText').textContent = won
      ? `Mit ${next.guessesUsed} Tipps · Budget übrig: ${next.guessesLeft} · Optimal: ${next.hops}`
      : `Optimal wären ${next.hops} Zwischenländer.`;
    const ol = $('pathList');
    ol.innerHTML = '';
    for (const c of next.optimalPath || []) {
      const li = document.createElement('li');
      li.textContent = `${c.nameDe} / ${c.nameEn}`;
      ol.appendChild(li);
      const el = countryEls.get(c.id);
      if (el && c.id !== next.start.id && c.id !== next.goal.id) el.classList.add('is-green');
    }
  }

  function renderDiffButtons() {
    const row = $('diffRow');
    row.innerHTML = '';
    for (const d of difficulties) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'diff-btn' + (d.id === difficulty ? ' active' : '');
      btn.textContent = `${d.label} · ${d.minHops}–${d.maxHops}`;
      btn.addEventListener('click', () => {
        difficulty = d.id;
        localStorage.setItem('border-path-diff', difficulty);
        renderDiffButtons();
      });
      row.appendChild(btn);
    }
  }

  async function startRound() {
    $('statusLine').textContent = '';
    await loadWorld();
    const data = await api('/api/round', {
      method: 'POST',
      body: JSON.stringify({ difficulty, sessionId }),
    });
    show('play');
    paintState(data.state);
    $('guessInput').value = '';
    $('guessInput').focus();
  }

  async function submitGuess(name) {
    if (!sessionId || !name) return;
    try {
      const data = await api('/api/guess', {
        method: 'POST',
        body: JSON.stringify({ sessionId, name }),
      });
      paintState(data.state);
      if (data.guess?.quality === 'red') {
        const flash = $('mapFlash');
        flash.hidden = false;
        flash.classList.remove('map-flash');
        void flash.offsetWidth;
        flash.classList.add('map-flash');
        setTimeout(() => {
          flash.hidden = true;
        }, 400);
      }
      $('statusLine').textContent = '';
      $('guessInput').value = '';
      $('suggestList').hidden = true;
    } catch (err) {
      $('statusLine').textContent = err.message || 'Tipp fehlgeschlagen.';
    }
  }

  async function useHint() {
    if (!sessionId) return;
    try {
      const data = await api('/api/hint', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
      paintState(data.state);
      const initials = (data.hint?.initials || []).map((x) => `${x.initial}…`).join(' · ');
      $('statusLine').textContent = initials
        ? `Hinweis: ${data.hint?.country?.nameDe || 'Umriss'} · ${initials}`
        : 'Hinweis genutzt.';
    } catch (err) {
      $('statusLine').textContent = err.message || 'Kein Hinweis.';
    }
  }

  function connectParty() {
    if (!partyId || typeof io === 'undefined') return;
    $('btnReturnParty').hidden = false;
    if (prefillName) localStorage.setItem('border-path-name', prefillName);
    socket = io({
      path: GB ? `${GB}/socket.io` : '/socket.io',
      transports: ['websocket', 'polling'],
    });
    socket.on('session:returned', () => {
      location.href = '/';
    });
    socket.emit(
      'session:join-party',
      { partyId, name: prefillName || 'Spieler', memberId },
      (res) => {
        if (res?.error) $('statusLine').textContent = res.error;
      }
    );
  }

  $('btnReturnParty').addEventListener('click', () => {
    if (!socket) {
      location.href = '/';
      return;
    }
    socket.emit('session:return-to-lobby', {}, (res) => {
      if (res?.error) $('statusLine').textContent = res.error;
      else location.href = '/';
    });
  });

  $('btnStart').addEventListener('click', () => startRound().catch((e) => alert(e.message)));
  $('btnAgain').addEventListener('click', () => startRound().catch((e) => alert(e.message)));
  $('btnHome').addEventListener('click', () => show('home'));
  $('btnHint').addEventListener('click', () => useHint());

  $('guessForm').addEventListener('submit', (e) => {
    e.preventDefault();
    submitGuess($('guessInput').value.trim());
  });

  $('guessInput').addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = $('guessInput').value.trim();
    if (q.length < 2) {
      $('suggestList').hidden = true;
      return;
    }
    suggestTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
        const ul = $('suggestList');
        ul.innerHTML = '';
        for (const s of data.suggestions || []) {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = `${s.nameDe} / ${s.nameEn}`;
          btn.addEventListener('click', () => {
            $('guessInput').value = s.nameDe;
            ul.hidden = true;
            submitGuess(s.nameDe);
          });
          li.appendChild(btn);
          ul.appendChild(li);
        }
        ul.hidden = !(data.suggestions || []).length;
      } catch (_) {
        $('suggestList').hidden = true;
      }
    }, 120);
  });

  async function init() {
    try {
      const meta = await api('/api/meta');
      difficulties = meta.difficulties || [];
      if (!difficulties.some((d) => d.id === difficulty)) difficulty = 'medium';
      renderDiffButtons();
    } catch (err) {
      console.error(err);
    }
    connectParty();
    show('home');
  }

  init();
})();
