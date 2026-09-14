(function () {
  const STORAGE_KEY = 'lagga.party';

  const els = {
    partyGate: document.getElementById('partyGate'),
    partyLobby: document.getElementById('partyLobby'),
    partyError: document.getElementById('partyError'),
    lobbyError: document.getElementById('lobbyError'),
    createName: document.getElementById('createName'),
    joinName: document.getElementById('joinName'),
    joinCode: document.getElementById('joinCode'),
    btnCreateParty: document.getElementById('btnCreateParty'),
    btnJoinParty: document.getElementById('btnJoinParty'),
    btnLeaveParty: document.getElementById('btnLeaveParty'),
    lobbyCode: document.getElementById('lobbyCode'),
    lobbyRole: document.getElementById('lobbyRole'),
    lobbyStatus: document.getElementById('lobbyStatus'),
    memberList: document.getElementById('memberList'),
    gameGrid: document.getElementById('gameGrid'),
    catalogTitle: document.getElementById('catalogTitle'),
    catalogHint: document.getElementById('catalogHint'),
  };

  let socket = null;
  let games = [];
  let party = null;
  let memberId = null;
  let selectedSlug = null;
  let launching = false;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(el, msg) {
    if (!el) return;
    if (!msg) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function saveSession() {
    if (!party || !memberId) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const me = (party.members || []).find((m) => m.id === memberId);
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        partyId: party.id,
        memberId,
        name: me?.name || '',
      })
    );
  }

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY);
    party = null;
    memberId = null;
    selectedSlug = null;
  }

  function emitAck(event, payload = {}) {
    return new Promise((resolve) => {
      if (!socket) {
        resolve({ error: 'Kein Socket.' });
        return;
      }
      socket.emit(event, payload, (res) => resolve(res || { error: 'Keine Antwort.' }));
    });
  }

  function ensureSocket() {
    if (socket) return socket;
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
    socket.on('party:state', (state) => {
      party = state;
      saveSession();
      renderParty();
      renderGames();
    });
    socket.on('party:launch', (launch) => handleLaunch(launch));
    socket.on('party:returned', (state) => {
      party = state;
      launching = false;
      saveSession();
      renderParty();
      renderGames();
    });
    return socket;
  }

  function inParty() {
    return !!(party && memberId);
  }

  function isLead() {
    return !!(party && memberId && party.leadId === memberId);
  }

  function myName() {
    return (party?.members || []).find((m) => m.id === memberId)?.name || '';
  }

  function handleLaunch(launch) {
    if (!launch?.slug || !launch?.partyId) return;
    if (launching) return;
    launching = true;
    const url =
      `/g/${encodeURIComponent(launch.slug)}/?party=${encodeURIComponent(launch.partyId)}` +
      `&name=${encodeURIComponent(myName())}` +
      `&member=${encodeURIComponent(memberId || '')}`;
    location.href = url;
  }

  function renderParty() {
    if (!inParty()) {
      els.partyGate.classList.remove('hidden');
      els.partyLobby.classList.add('hidden');
      els.catalogTitle.textContent = 'Welches Spiel?';
      els.catalogHint.textContent =
        'Ohne Party: Solo öffnen. In der Party: nur der Lead startet ein party-fähiges Spiel für alle.';
      return;
    }

    els.partyGate.classList.add('hidden');
    els.partyLobby.classList.remove('hidden');
    els.lobbyCode.textContent = party.code || party.id;
    els.lobbyRole.textContent = isLead() ? 'Lobby-Lead' : 'Mitglied';
    els.lobbyStatus.textContent =
      party.status === 'in_game' ? `Im Spiel: ${party.currentGame || '…'}` : 'Lobby';
    els.catalogTitle.textContent = isLead() ? 'Spiel für die Party wählen' : 'Wartet auf den Lead';
    els.catalogHint.textContent = isLead()
      ? 'Nur party-fähige Spiele. Solo ist in der Party gesperrt.'
      : 'Der Lead startet — du bleibst in der Party und landest gemeinsam im Spiel.';

    els.memberList.innerHTML = (party.members || [])
      .map((m) => {
        const flags = [];
        if (m.isLead) flags.push('Lead');
        if (!m.connected) flags.push('offline');
        return `<li class="${m.connected ? '' : 'offline'}">
          <span>${escapeHtml(m.name)}${m.id === memberId ? ' (du)' : ''}</span>
          <span class="muted">${escapeHtml(flags.join(' · ') || 'ok')}</span>
        </li>`;
      })
      .join('');
  }

  function renderGames() {
    if (!games.length) {
      els.gameGrid.innerHTML =
        '<p class="muted">Noch keine Spiele. Lege einen Ordner unter <code>games/&lt;slug&gt;/</code> an (siehe Template).</p>';
      return;
    }

    const partyMode = inParty();
    els.gameGrid.innerHTML = games
      .map((g, i) => {
        const status = g.status || 'wip';
        const ready = status === 'playable' || status === 'ready' || status === 'live';
        const badgeClass = ready ? 'badge' : 'badge wip';
        const partyOk = !!g.partySupport;
        const selected = selectedSlug === g.slug;

        if (!partyMode) {
          return `<a class="card" href="/g/${escapeHtml(g.slug)}/" style="animation-delay:${0.05 * i}s">
            <h2>${escapeHtml(g.name || g.slug)}</h2>
            <p>${escapeHtml(g.tagline || g.description || '')}</p>
            <div class="meta">
              <span class="${badgeClass}">${escapeHtml(status)}</span>
              <span class="cta">Solo öffnen →</span>
            </div>
          </a>`;
        }

        if (!partyOk) {
          return `<div class="card party-locked" style="animation-delay:${0.05 * i}s">
            <h2>${escapeHtml(g.name || g.slug)}</h2>
            <p>${escapeHtml(g.tagline || g.description || '')}</p>
            <div class="meta">
              <span class="${badgeClass}">${escapeHtml(status)}</span>
              <span class="cta">Kein Party-Support</span>
            </div>
          </div>`;
        }

        if (!isLead()) {
          return `<div class="card party-locked" style="animation-delay:${0.05 * i}s">
            <h2>${escapeHtml(g.name || g.slug)}</h2>
            <p>${escapeHtml(g.tagline || g.description || '')}</p>
            <div class="meta">
              <span class="${badgeClass}">${escapeHtml(status)}</span>
              <span class="cta">${party.selectedGame === g.slug ? 'Ausgewählt' : 'Nur Lead startet'}</span>
            </div>
          </div>`;
        }

        return `<div class="card party-pick ${selected ? 'selected' : ''}" data-slug="${escapeHtml(g.slug)}" style="animation-delay:${0.05 * i}s">
          <h2>${escapeHtml(g.name || g.slug)}</h2>
          <p>${escapeHtml(g.tagline || g.description || '')}</p>
          <div class="meta">
            <span class="${badgeClass}">${escapeHtml(status)}</span>
            <span class="cta">Party-Spiel</span>
          </div>
          <div class="card-actions">
            <button class="btn btn-sm" type="button" data-start="${escapeHtml(g.slug)}">Für alle starten</button>
          </div>
        </div>`;
      })
      .join('');
  }

  async function loadGames() {
    try {
      const res = await fetch('/api/games');
      const data = await res.json();
      games = data.games || [];
      renderGames();
    } catch (e) {
      els.gameGrid.innerHTML = `<p class="muted">Katalog konnte nicht geladen werden: ${escapeHtml(
        e.message || e
      )}</p>`;
    }
  }

  async function afterPartyJoin(res) {
    if (res.error) throw new Error(res.error);
    party = res.party;
    memberId = res.memberId;
    selectedSlug = party.selectedGame || null;
    saveSession();
    showError(els.partyError, '');
    showError(els.lobbyError, '');
    renderParty();
    renderGames();
  }

  els.btnCreateParty.addEventListener('click', async () => {
    showError(els.partyError, '');
    ensureSocket();
    try {
      await afterPartyJoin(await emitAck('party:create', { name: els.createName.value }));
    } catch (e) {
      showError(els.partyError, e.message);
    }
  });

  els.btnJoinParty.addEventListener('click', async () => {
    showError(els.partyError, '');
    ensureSocket();
    try {
      await afterPartyJoin(
        await emitAck('party:join', {
          code: String(els.joinCode.value || '').trim().toUpperCase(),
          name: els.joinName.value,
        })
      );
    } catch (e) {
      showError(els.partyError, e.message);
    }
  });

  els.btnLeaveParty.addEventListener('click', async () => {
    ensureSocket();
    await emitAck('party:leave', {});
    clearSession();
    renderParty();
    renderGames();
  });

  els.gameGrid.addEventListener('click', async (e) => {
    const startBtn = e.target.closest('[data-start]');
    if (startBtn) {
      e.preventDefault();
      if (!isLead()) return;
      showError(els.lobbyError, '');
      const slug = startBtn.getAttribute('data-start');
      ensureSocket();
      const select = await emitAck('party:selectGame', { slug });
      if (select.error) {
        showError(els.lobbyError, select.error);
        return;
      }
      selectedSlug = slug;
      const start = await emitAck('party:startGame', { slug });
      if (start.error) {
        showError(els.lobbyError, start.error);
        return;
      }
      if (start.launch) handleLaunch(start.launch);
      return;
    }

    const card = e.target.closest('.party-pick[data-slug]');
    if (card && isLead()) {
      selectedSlug = card.getAttribute('data-slug');
      ensureSocket();
      const res = await emitAck('party:selectGame', { slug: selectedSlug });
      if (res.error) showError(els.lobbyError, res.error);
      else {
        party = res.party || party;
        renderGames();
      }
    }
  });

  async function tryReconnect() {
    const saved = loadSession();
    if (!saved?.partyId || !saved?.memberId) {
      renderParty();
      return;
    }
    ensureSocket();
    await new Promise((r) => {
      if (socket.connected) r();
      else socket.once('connect', r);
    });
    const res = await emitAck('party:reconnect', {
      partyId: saved.partyId,
      memberId: saved.memberId,
    });
    if (res.error) {
      clearSession();
      renderParty();
      return;
    }
    party = res.party;
    memberId = res.memberId;
    selectedSlug = party.selectedGame || null;
    saveSession();
    renderParty();
    renderGames();

    if (party.status === 'in_game' && party.currentGame) {
      handleLaunch({
        slug: party.currentGame,
        partyId: party.id,
        leadId: party.leadId,
        members: party.members,
      });
    }
  }

  loadGames().then(tryReconnect);
})();
