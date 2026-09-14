(function () {
  const socket = CV.createSocket();
  const errorEl = document.getElementById('error');
  const lobbyPanel = document.getElementById('lobbyPanel');
  const gamePanel = document.getElementById('gamePanel');
  const roomCodeEl = document.getElementById('roomCode');
  const joinUrlEl = document.getElementById('joinUrl');
  const lanLinks = document.getElementById('lanLinks');
  const phasePill = document.getElementById('phasePill');
  const packTitle = document.getElementById('packTitle');
  const packSelect = document.getElementById('packSelect');
  const lobbyPlayerList = document.getElementById('lobbyPlayerList');
  const lobbyHint = document.getElementById('lobbyHint');
  const startHint = document.getElementById('startHint');
  const sceneInfo = document.getElementById('sceneInfo');
  const sceneList = document.getElementById('sceneList');
  const playerList = document.getElementById('playerList');
  const castList = document.getElementById('castList');
  const progressText = document.getElementById('progressText');
  const captionOverlay = document.getElementById('captionOverlay');
  const segmentStatus = document.getElementById('segmentStatus');
  const video = document.getElementById('dubVideo');
  const backing = document.getElementById('backingAudio');
  const btnStart = document.getElementById('btnStart');
  const btnOpenPlay = document.getElementById('btnOpenPlay');
  const btnReview = document.getElementById('btnReview');
  const btnRestart = document.getElementById('btnRestart');
  const btnPlaySegment = document.getElementById('btnPlaySegment');
  const btnPlayOriginal = document.getElementById('btnPlayOriginal');
  const btnPlayTake = document.getElementById('btnPlayTake');
  const exportControls = document.getElementById('exportControls');
  const exportStatus = document.getElementById('exportStatus');
  const btnExportWav = document.getElementById('btnExportWav');
  const btnExportVideo = document.getElementById('btnExportVideo');
  const btnExportJson = document.getElementById('btnExportJson');

  let state = null;
  let playerId = null;
  let segmentWatcher = null;
  let joinBase = location.origin;

  function phaseLabel(phase) {
    return (
      {
        lobby: 'Lobby',
        casting: 'Lobby',
        dubbing: 'Dubbing',
        review: 'Review',
      }[phase] || phase
    );
  }

  function isHost() {
    return playerId && state && playerId === state.hostId;
  }

  function inLobby() {
    return state?.phase === 'lobby' || state?.phase === 'casting';
  }

  function sceneEnd(scene) {
    if (!scene) return 0;
    const start = Number(scene.timestamp) || 0;
    const storedEnd = Number.isFinite(scene.endTimestamp)
      ? scene.endTimestamp
      : start + (scene.duration || 4);
    if (Number.isFinite(scene.referenceDuration) && scene.referenceDuration > 0.05) {
      const audioEnd = start + scene.referenceDuration + 0.18;
      return Math.round(Math.min(audioEnd, storedEnd) * 1000) / 1000;
    }
    return storedEnd;
  }

  function stopSegmentPlayback() {
    if (segmentWatcher) {
      video.removeEventListener('timeupdate', segmentWatcher);
      segmentWatcher = null;
    }
    video.pause();
    backing.pause();
  }

  function waitSeeked(el, target) {
    const t = Math.max(0, Number(target) || 0);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener('seeked', finish);
        resolve();
      };
      if (el.readyState >= 1 && Math.abs((el.currentTime || 0) - t) < 0.04) {
        finish();
        return;
      }
      el.addEventListener('seeked', finish);
      try {
        el.currentTime = t;
      } catch (_) {
        finish();
        return;
      }
      setTimeout(finish, 700);
    });
  }

  async function playVideoSegment(scene) {
    if (!scene || !video.src) return;
    stopSegmentPlayback();
    CVAudio.stopPlayback();
    const start = Math.max(0, scene.timestamp || 0);
    const end = sceneEnd(scene);
    captionOverlay.textContent = `${scene.character}: ${scene.caption}`;
    segmentStatus.textContent = `Vorschau ${start.toFixed(1)}s – ${end.toFixed(1)}s (mit Ton)`;
    video.muted = false;
    video.volume = 1;
    await waitSeeked(video, start);
    try {
      await video.play();
    } catch {
      segmentStatus.textContent = 'Autoplay blockiert — erneut tippen.';
      return;
    }
    segmentWatcher = () => {
      if (video.currentTime >= end - 0.03) {
        stopSegmentPlayback();
        segmentStatus.textContent = 'Abschnitt fertig';
      }
    };
    video.addEventListener('timeupdate', segmentWatcher);
  }

  async function playOriginal(scene) {
    if (!scene?.referenceUrl) {
      CV.showError(errorEl, 'Kein Original-Audio.');
      return;
    }
    stopSegmentPlayback();
    CVAudio.stopPlayback();
    segmentStatus.textContent = 'Original…';
    try {
      await CVAudio.playUrl(scene.referenceUrl);
      segmentStatus.textContent = 'Original fertig';
    } catch {
      CV.showError(errorEl, 'Original fehlgeschlagen.');
    }
  }

  async function playTake(scene) {
    if (!scene) return;
    const res = await CV.emitAck(socket, 'dub:get-take', { sceneId: scene.id });
    if (res.error) {
      CV.showError(errorEl, res.error);
      return;
    }
    stopSegmentPlayback();
    CVAudio.stopPlayback();
    segmentStatus.textContent = `Take von ${res.playerName}…`;
    try {
      await CVAudio.playBase64(res.audioBase64, res.mimeType);
      segmentStatus.textContent = 'Take fertig';
    } catch {
      CV.showError(errorEl, 'Take fehlgeschlagen.');
    }
  }

  async function loadJoinInfo() {
    try {
      const res = await fetch('/api/join-info');
      const data = await res.json();
      if (data.lan?.length) joinBase = data.lan[0];
      lanLinks.innerHTML = '';
      const urls = [...new Set([data.local, ...(data.lan || [])].filter(Boolean))];
      urls.forEach((base) => {
        const code = state?.code || '';
        const full = `${base}/play.html?code=${encodeURIComponent(code)}`;
        const p = document.createElement('p');
        p.className = 'join-url';
        p.textContent = full;
        lanLinks.appendChild(p);
      });
    } catch (_) {}
  }

  function renderPackSelect() {
    const packs = state?.availablePacks || [];
    packSelect.innerHTML = '';
    packs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.sceneCount} Szenen)`;
      if (p.id === state.packId) opt.selected = true;
      packSelect.appendChild(opt);
    });
    packSelect.disabled = !(isHost() && inLobby());
  }

  function bindMedia() {
    const pack = state?.pack;
    if (!pack) return;
    if (packTitle) packTitle.textContent = pack.title || 'Pack';
    if (pack.videoUrl && video.dataset.src !== pack.videoUrl + '?v=mp4audio') {
      video.dataset.src = pack.videoUrl + '?v=mp4audio';
      video.src = pack.videoUrl + '?v=mp4audio';
      video.muted = true;
    }
    if (pack.backingTrackUrl && backing.dataset.src !== pack.backingTrackUrl) {
      backing.dataset.src = pack.backingTrackUrl;
      backing.src = pack.backingTrackUrl;
    }
  }

  function renderLobbyPlayers() {
    lobbyPlayerList.innerHTML = '';
    const players = state.players || [];
    if (!players.length) {
      lobbyHint.textContent = 'Warte auf Beitritte…';
      return;
    }
    const lobby = state.lobby || {};
    lobbyHint.textContent = lobby.allReady
      ? 'Alle ready — du kannst starten.'
      : `Ready: ${lobby.readyCount || 0} / ${lobby.playerCount || 0}`;

    players.forEach((p) => {
      const chars = (p.characters || []).join(', ') || 'kein Charakter';
      const li = document.createElement('li');
      const readyLabel = p.ready
        ? '<span class="ready-tag ready-on">READY</span>'
        : '<span class="ready-tag">wartet</span>';
      li.innerHTML = `<span>${p.name} · ${chars}</span>${readyLabel}`;
      lobbyPlayerList.appendChild(li);
    });
  }

  function renderGameLists() {
    playerList.innerHTML = '';
    (state.players || []).forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${p.name}</span><span>${(p.characters || []).join(', ') || '—'}</span>`;
      playerList.appendChild(li);
    });

    castList.innerHTML = '';
    (state.pack?.characters || []).forEach((ch) => {
      const pid = state.casting?.[ch];
      const player = (state.players || []).find((p) => p.id === pid);
      const stats = state.byCharacter?.[ch];
      const prog = stats ? `${stats.done}/${stats.total}` : '';
      const li = document.createElement('li');
      li.innerHTML = `<span>${ch}${player ? ` · ${player.name}` : ''}</span><span>${prog}</span>`;
      castList.appendChild(li);
    });

    const percent = state.percentDone || 0;
    progressText.textContent = `${state.doneCount || 0} / ${state.totalScenes || 0} Takes · ${percent}%`;
    const fill = document.getElementById('progressBarFill');
    if (fill) fill.style.width = `${percent}%`;

    const charsEl = document.getElementById('progressChars');
    if (charsEl) {
      charsEl.innerHTML = '';
      Object.entries(state.byCharacter || {}).forEach(([ch, info]) => {
        const pill = document.createElement('span');
        pill.className = 'progress-char-pill' + (info.done >= info.total ? ' done' : '');
        pill.textContent = `${ch} ${info.done}/${info.total}`;
        charsEl.appendChild(pill);
      });
    }

    sceneList.innerHTML = '';
    (state.progressBoard || state.pack?.scenes || []).forEach((scene) => {
      const li = document.createElement('li');
      const done = scene.done ?? state.takeStatus?.[scene.id];
      const playerName = scene.playerName || state.takeMeta?.[scene.id]?.playerName;
      const caption = scene.caption || '';
      const character = scene.character || '';
      const ts = Number(scene.timestamp || 0).toFixed(1);
      if (done) li.classList.add('done');
      const check = done
        ? '<span class="clip-check">✓</span>'
        : '<span class="clip-check" style="opacity:.25">○</span>';
      const who = done
        ? `<span class="clip-who">${playerName || '?'}</span>`
        : `<span class="clip-who">${character}</span>`;
      li.innerHTML = `<span>${check}${ts}s · ${caption}</span>${who}`;
      if (isHost()) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', async () => {
          const idx = (state.pack?.scenes || []).findIndex((s) => s.id === scene.id);
          if (idx >= 0) {
            await CV.emitAck(socket, 'dub:goto', { index: idx });
            const full = state.pack.scenes[idx];
            if (full) playVideoSegment(full);
          }
        });
      }
      sceneList.appendChild(li);
    });
  }

  function applyState(next) {
    state = next;
    roomCodeEl.textContent = state.code;
    joinUrlEl.textContent = `${joinBase}/play.html?code=${encodeURIComponent(state.code)}`;
    phasePill.textContent = phaseLabel(state.phase);
    bindMedia();
    renderPackSelect();
    CV.showError(errorEl, '');
    loadJoinInfo();

    const lobby = inLobby();
    lobbyPanel.classList.toggle('hidden', !lobby);
    gamePanel.classList.toggle('hidden', lobby);

    if (lobby) {
      renderLobbyPlayers();
      const canStart = isHost() && !!state.lobby?.canStart;
      btnStart.disabled = !canStart;
      startHint.textContent = canStart
        ? 'Alle Charaktere verteilt & ready — Start drücken.'
        : state.lobby?.unassignedChars?.length
          ? `Noch nicht verteilt: ${state.lobby.unassignedChars.join(', ')}`
          : state.lobby?.waitingFor?.length
            ? `Wartet auf: ${state.lobby.waitingFor.join(', ')}`
            : 'Spieler müssen Charaktere wählen und Ready tippen.';
    } else {
      renderGameLists();
      exportControls.classList.toggle('hidden', !(isHost() && state.phase === 'review'));
      sceneInfo.innerHTML = `<p><strong>${state.pack?.title || 'Pack'}</strong></p>
        <p class="muted">Spieler nehmen auf ihren Geräten auf. Hier kannst du Abschnitte / Takes prüfen.</p>`;
    }
  }

  async function createRoom() {
    const params = new URLSearchParams(location.search);
    const preferredPack = params.get('pack') || sessionStorage.getItem('cv_preferredPack') || null;
    if (preferredPack) sessionStorage.setItem('cv_preferredPack', preferredPack);

    const existingCode = sessionStorage.getItem('cv_roomCode');
    let res;
    if (existingCode) {
      res = await CV.emitAck(socket, 'room:claim-host', { code: existingCode });
      if (res.error) {
        res = await CV.emitAck(socket, 'room:create', { packId: preferredPack || undefined });
      }
    } else {
      res = await CV.emitAck(socket, 'room:create', { packId: preferredPack || undefined });
    }
    if (res.error) {
      CV.showError(errorEl, res.error);
      return;
    }
    playerId = res.playerId;
    sessionStorage.setItem('cv_playerId', playerId);
    sessionStorage.setItem('cv_roomCode', res.state.code);
    applyState(res.state);

    if (
      preferredPack &&
      res.state.packId !== preferredPack &&
      (res.state.phase === 'lobby' || res.state.phase === 'casting')
    ) {
      const set = await CV.emitAck(socket, 'pack:set', { packId: preferredPack });
      if (set.error) CV.showError(errorEl, set.error);
    }
  }

  socket.on('state:update', applyState);

  packSelect.addEventListener('change', async () => {
    const res = await CV.emitAck(socket, 'pack:set', { packId: packSelect.value });
    if (res.error) CV.showError(errorEl, res.error);
  });

  btnStart.addEventListener('click', async () => {
    const res = await CV.emitAck(socket, 'dub:start', {});
    if (res.error) CV.showError(errorEl, res.error);
  });

  btnOpenPlay.addEventListener('click', () => {
    if (!state?.code) return;
    window.open(`/play.html?code=${encodeURIComponent(state.code)}`, '_blank');
  });

  btnReview.addEventListener('click', async () => {
    stopSegmentPlayback();
    const res = await CV.emitAck(socket, 'dub:review', {});
    if (res.error) CV.showError(errorEl, res.error);
  });

  btnRestart.addEventListener('click', async () => {
    stopSegmentPlayback();
    const res = await CV.emitAck(socket, 'game:restart', {});
    if (res.error) CV.showError(errorEl, res.error);
  });

  btnPlaySegment.addEventListener('click', () => {
    if (state?.currentScene) playVideoSegment(state.currentScene);
  });
  btnPlayOriginal.addEventListener('click', () => {
    if (state?.currentScene) playOriginal(state.currentScene);
  });
  btnPlayTake.addEventListener('click', () => {
    if (state?.currentScene) playTake(state.currentScene);
  });

  async function loadExport() {
    const res = await CV.emitAck(socket, 'dub:export', {});
    if (res.error) throw new Error(res.error);
    return res.export;
  }

  btnExportWav.addEventListener('click', async () => {
    exportStatus.textContent = 'Mische Audio…';
    try {
      await CVExport.exportWav(await loadExport());
      exportStatus.textContent = 'WAV heruntergeladen.';
    } catch (err) {
      exportStatus.textContent = '';
      CV.showError(errorEl, err.message || 'Export fehlgeschlagen.');
    }
  });

  btnExportJson.addEventListener('click', async () => {
    try {
      await CVExport.exportProjectJson(await loadExport());
      exportStatus.textContent = 'JSON heruntergeladen.';
    } catch (err) {
      CV.showError(errorEl, err.message || 'Export fehlgeschlagen.');
    }
  });

  btnExportVideo.addEventListener('click', async () => {
    exportStatus.textContent = 'Rendere Video…';
    try {
      const data = await loadExport();
      await CVExport.exportVideoWebm(video, data, (p) => {
        exportStatus.textContent = `Rendere Video… ${Math.round(p * 100)}%`;
      });
      exportStatus.textContent = 'WebM heruntergeladen.';
    } catch (err) {
      exportStatus.textContent = '';
      CV.showError(errorEl, err.message || 'Video-Export fehlgeschlagen.');
    }
  });

  createRoom();

  const btnDashboard = document.getElementById('btnDashboard');
  if (btnDashboard) {
    btnDashboard.addEventListener('click', () => {
      sessionStorage.removeItem('cv_roomCode');
      sessionStorage.removeItem('cv_playerId');
      sessionStorage.removeItem('cv_preferredPack');
    });
  }
})();
