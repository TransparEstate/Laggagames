(function () {
  const packGrid = document.getElementById('packGrid');
  const uploadDrop = document.getElementById('uploadDrop');
  const packFile = document.getElementById('packFile');
  const btnPickZip = document.getElementById('btnPickZip');
  const uploadProgressWrap = document.getElementById('uploadProgressWrap');
  const uploadProgressFill = document.getElementById('uploadProgressFill');
  const uploadProgressText = document.getElementById('uploadProgressText');
  const uploadError = document.getElementById('uploadError');
  const uploadOk = document.getElementById('uploadOk');
  const storageHint = document.getElementById('storageHint');
  const btnJoin = document.getElementById('btnJoin');
  const joinCode = document.getElementById('joinCode');
  const joinName = document.getElementById('joinName');
  const mpName = document.getElementById('mpName');
  const mpPack = document.getElementById('mpPack');
  const btnMultiplayer = document.getElementById('btnMultiplayer');
  const btnOpenMp = document.getElementById('btnOpenMp');
  const btnOpenJoin = document.getElementById('btnOpenJoin');
  const modalMp = document.getElementById('modalMp');
  const modalJoin = document.getElementById('modalJoin');
  const projectList = document.getElementById('projectList');
  const projectPackFilter = document.getElementById('projectPackFilter');
  const btnImportProjectFile = document.getElementById('btnImportProjectFile');
  const projectFileInput = document.getElementById('projectFileInput');

  let maxUploadMb = 1500;
  let processPulse = null;
  let cachedPacks = [];
  let cachedProjects = [];

  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').toUpperCase();
  if (code && joinCode) joinCode.value = code;

  function openModal(el) {
    if (!el) return;
    el.classList.remove('hidden');
    const focusEl = el.querySelector('input, select, button.btn:not(.dash-modal-close)');
    if (focusEl) setTimeout(() => focusEl.focus(), 30);
  }

  function closeModal(el) {
    if (!el) return;
    el.classList.add('hidden');
  }

  function closeAllModals() {
    closeModal(modalMp);
    closeModal(modalJoin);
  }

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeModal(document.getElementById(btn.getAttribute('data-close-modal')));
    });
  });

  [modalMp, modalJoin].forEach((modal) => {
    if (!modal) return;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  if (btnOpenMp) {
    btnOpenMp.addEventListener('click', () => {
      fillMpPackSelect(cachedPacks);
      openModal(modalMp);
    });
  }
  if (btnOpenJoin) {
    btnOpenJoin.addEventListener('click', () => openModal(modalJoin));
  }

  // Deep-link ?code=… → Join-Modal öffnen
  if (code) openModal(modalJoin);

  function formatSize(bytes) {
    if (!bytes || bytes < 1) return '—';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes > 200 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function showUploadError(msg) {
    uploadError.textContent = msg || '';
    uploadError.classList.toggle('hidden', !msg);
    if (msg) uploadOk.classList.add('hidden');
  }

  function showUploadOk(msg) {
    uploadOk.textContent = msg || '';
    uploadOk.classList.toggle('hidden', !msg);
    if (msg) uploadError.classList.add('hidden');
  }

  function setProgress(pct, text) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    uploadProgressFill.style.width = `${clamped}%`;
    uploadProgressText.textContent = text || `${clamped}%`;
  }

  function stopProcessPulse() {
    if (processPulse) {
      clearInterval(processPulse);
      processPulse = null;
    }
  }

  function startProcessPulse() {
    stopProcessPulse();
    let tick = 0;
    // Stay in 70–92% while server extracts + stores — never claim 100% yet
    setProgress(72, 'Wird eingerichtet… bitte warten');
    processPulse = setInterval(() => {
      tick += 1;
      const pct = 72 + Math.min(20, tick);
      setProgress(pct, 'Wird eingerichtet… bitte warten');
    }, 2500);
  }

  async function loadPacks() {
    try {
      const res = await fetch('/api/packs');
      const data = await res.json();
      maxUploadMb = data.maxUploadMb || 1500;
      cachedPacks = data.packs || [];
      fillMpPackSelect(cachedPacks);
      fillProjectPackFilter(cachedPacks);
      renderPacks(cachedPacks);
      updateStorageHint(data.r2);
      await loadProjects();
    } catch {
      packGrid.innerHTML = `<p class="error">Packs konnten nicht geladen werden.</p>`;
    }
  }

  function updateStorageHint(r2) {
    if (!storageHint) return;
    if (r2?.enabled) {
      storageHint.textContent = `Dauerhafter Speicher aktiv (${r2.bucket || 'Object Storage'}) — Packs bleiben nach Redeploys.`;
      storageHint.classList.remove('hidden', 'error');
      return;
    }
    storageHint.textContent =
      'Warnung: Object Storage ist aus — hochgeladene Packs gehen bei jedem Redeploy verloren.';
    storageHint.classList.remove('hidden');
    storageHint.classList.add('error');
  }

  function fillProjectPackFilter(packs) {
    if (!projectPackFilter) return;
    const prev = projectPackFilter.value;
    projectPackFilter.innerHTML = '<option value="">Alle Packs</option>';
    packs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title;
      projectPackFilter.appendChild(opt);
    });
    if (prev && [...projectPackFilter.options].some((o) => o.value === prev)) {
      projectPackFilter.value = prev;
    }
  }

  async function loadProjects() {
    if (!projectList || typeof CVProjects === 'undefined') return;
    try {
      cachedProjects = await CVProjects.listSummaries();
      renderProjects();
    } catch (err) {
      projectList.innerHTML = `<p class="error">Projekte konnten nicht geladen werden.</p>`;
      console.warn(err);
    }
  }

  function renderProjects() {
    if (!projectList) return;
    const filter = projectPackFilter?.value || '';
    const rows = cachedProjects.filter((p) => !filter || p.packId === filter);
    if (!rows.length) {
      projectList.innerHTML =
        '<p class="muted">Noch keine lokalen Projekte — nach der Premiere „Projekt speichern“.</p>';
      return;
    }
    const packTitle = (id) => cachedPacks.find((p) => p.id === id)?.title || id;
    projectList.innerHTML = '';
    rows.forEach((p) => {
      const when = p.savedAt
        ? new Date(p.savedAt).toLocaleString('de-DE', {
            dateStyle: 'short',
            timeStyle: 'short',
          })
        : '—';
      const el = document.createElement('div');
      el.className = 'project-row';
      el.innerHTML = `
        <div class="project-row-main">
          <strong>${escapeHtml(p.name || p.title || 'Projekt')}</strong>
          <p class="muted">${escapeHtml(packTitle(p.packId))} · ${p.takeCount || 0} Takes · ${when}</p>
        </div>
        <div class="project-row-actions">
          <button type="button" class="btn btn-sm" data-open-project="${escapeHtml(p.id)}">Öffnen</button>
          <button type="button" class="btn btn-sm btn-secondary" data-edit-project="${escapeHtml(p.id)}">Bearbeiten</button>
          <button type="button" class="btn btn-sm btn-ghost" data-export-project="${escapeHtml(p.id)}">Datei</button>
          <button type="button" class="btn btn-sm btn-ghost" data-del-project="${escapeHtml(p.id)}" title="Löschen">✕</button>
        </div>
      `;
      projectList.appendChild(el);
    });

    projectList.querySelectorAll('[data-open-project]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = `/play.html?project=${encodeURIComponent(btn.getAttribute('data-open-project'))}`;
      });
    });
    projectList.querySelectorAll('[data-edit-project]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = `/play.html?project=${encodeURIComponent(btn.getAttribute('data-edit-project'))}&edit=1`;
      });
    });
    projectList.querySelectorAll('[data-export-project]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const full = await CVProjects.getProject(btn.getAttribute('data-export-project'));
        if (full) CVProjects.downloadProjectFile(full);
      });
    });
    projectList.querySelectorAll('[data-del-project]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Lokales Projekt löschen?')) return;
        await CVProjects.deleteProject(btn.getAttribute('data-del-project'));
        await loadProjects();
      });
    });
  }

  function fillMpPackSelect(packs) {
    if (!mpPack) return;
    const prev = mpPack.value;
    mpPack.innerHTML = '';
    if (!packs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Kein Pack verfügbar';
      mpPack.appendChild(opt);
      mpPack.disabled = true;
      if (btnMultiplayer) btnMultiplayer.disabled = true;
      if (btnOpenMp) btnOpenMp.disabled = true;
      return;
    }
    mpPack.disabled = false;
    if (btnMultiplayer) btnMultiplayer.disabled = false;
    if (btnOpenMp) btnOpenMp.disabled = false;
    packs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.sceneCount} Clips)`;
      mpPack.appendChild(opt);
    });
    if (prev && packs.some((p) => p.id === prev)) mpPack.value = prev;
  }

  function renderPacks(packs) {
    packGrid.innerHTML = '';
    if (!packs.length) {
      packGrid.innerHTML = '<p class="muted">Noch keine Packs — ZIP oben hochladen.</p>';
      return;
    }

    packs.forEach((pack) => {
      const card = document.createElement('article');
      card.className = 'pack-card';
      const icon = pack.iconUrl
        ? `<img class="pack-card-icon" src="${pack.iconUrl}" alt="" />`
        : `<div class="pack-card-icon placeholder">🎙</div>`;
      card.innerHTML = `
        <div class="pack-card-top">
          ${icon}
          <div>
            <h3>${escapeHtml(pack.title)}</h3>
            <p class="muted">${pack.sceneCount} Clips · ${pack.characters?.length || 0} Charaktere · ${formatSize(pack.sizeBytes)}</p>
          </div>
        </div>
        <div class="pack-card-actions">
          <button type="button" class="btn" data-solo="${escapeHtml(pack.id)}">Alleine</button>
          ${
            pack.source === 'user' || pack.source === 'r2'
              ? `<button type="button" class="btn btn-ghost btn-sm" data-del="${escapeHtml(pack.id)}" title="Löschen">✕</button>`
              : ''
          }
        </div>
      `;
      packGrid.appendChild(card);
    });

    packGrid.querySelectorAll('[data-solo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = `/play.html?solo=1&pack=${encodeURIComponent(btn.getAttribute('data-solo'))}`;
      });
    });
    packGrid.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del');
        if (!confirm(`Pack „${id}“ wirklich löschen?`)) return;
        const res = await fetch(`/api/packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || 'Löschen fehlgeschlagen.');
          return;
        }
        await loadPacks();
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function uploadZip(file) {
    if (!file) return;
    const name = String(file.name || '');
    const looksZip = /\.zip$/i.test(name) || /zip/i.test(file.type || '');
    if (!looksZip) {
      showUploadError('Bitte eine .zip Datei wählen (nicht Ordner / .rar).');
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      showUploadError(`Datei zu groß (max. ${maxUploadMb} MB).`);
      return;
    }
    if (file.size < 64) {
      showUploadError('Datei wirkt leer oder ungültig.');
      return;
    }

    stopProcessPulse();
    showUploadError('');
    showUploadOk('');
    uploadProgressWrap.classList.remove('hidden');
    setProgress(0, 'Senden… 0%');
    uploadDrop.classList.add('uploading');

    const form = new FormData();
    // Keep original filename so server can detect .zip even if MIME is wrong
    form.append('pack', file, name || 'pack.zip');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/packs/upload');
    xhr.timeout = 20 * 60 * 1000; // match server convert/mirror window

    // Network send = 0–70%. Never hit 100% here — server still works after.
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 70);
      setProgress(
        pct,
        `Senden… ${Math.round((ev.loaded / ev.total) * 100)}% · ${formatSize(ev.loaded)} / ${formatSize(ev.total)}`
      );
    };

    xhr.upload.onload = () => {
      startProcessPulse();
    };

    xhr.onload = async () => {
      stopProcessPulse();
      uploadDrop.classList.remove('uploading');
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
        setProgress(100, 'Fertig');
        const mirror =
          data.r2?.ok === true
            ? ' · im Dauer-Speicher gesichert'
            : data.r2?.skipped
              ? ' · nur lokal (kein Object Storage)'
              : '';
        showUploadOk(`„${data.pack?.title || data.pack?.id}“ ist bereit${mirror}.`);
        await loadPacks();
        setTimeout(() => {
          uploadProgressWrap.classList.add('hidden');
          showUploadOk('');
        }, 2500);
      } else {
        const detail =
          data.error ||
          (xhr.status === 413
            ? 'Datei zu groß für den Server-Proxy.'
            : xhr.status === 0
              ? 'Verbindung abgebrochen.'
              : `Upload fehlgeschlagen (${xhr.status}).`);
        showUploadError(detail);
        uploadProgressWrap.classList.add('hidden');
      }
    };

    xhr.onerror = () => {
      stopProcessPulse();
      uploadDrop.classList.remove('uploading');
      showUploadError('Netzwerkfehler beim Upload. Bitte erneut versuchen (HTTPS / stabile Verbindung).');
      uploadProgressWrap.classList.add('hidden');
    };

    xhr.ontimeout = () => {
      stopProcessPulse();
      uploadDrop.classList.remove('uploading');
      showUploadError('Zeitüberschreitung — Pack zu groß oder Server braucht länger. Bitte erneut versuchen.');
      uploadProgressWrap.classList.add('hidden');
    };

    xhr.send(form);
  }

  function openPackPicker() {
    if (uploadDrop.classList.contains('uploading')) return;
    // Reset so choosing the same file again still fires change
    packFile.value = '';
    packFile.click();
  }

  uploadDrop.addEventListener('click', (e) => {
    // Extra button has its own handler — avoid double-open
    if (e.target === btnPickZip || btnPickZip?.contains(e.target)) return;
    openPackPicker();
  });
  if (btnPickZip) {
    btnPickZip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPackPicker();
    });
  }
  uploadDrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPackPicker();
    }
  });
  packFile.addEventListener('change', () => {
    uploadZip(packFile.files?.[0]);
    packFile.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => {
    uploadDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadDrop.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    uploadDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      uploadDrop.classList.remove('dragover');
    });
  });
  uploadDrop.addEventListener('drop', (e) => {
    if (uploadDrop.classList.contains('uploading')) return;
    uploadZip(e.dataTransfer?.files?.[0]);
  });

  btnMultiplayer.addEventListener('click', () => {
    const name = (mpName.value || '').trim();
    const packId = mpPack.value;
    if (!name) {
      alert('Bitte einen Namen eingeben.');
      return;
    }
    if (!packId) {
      alert('Bitte ein Voicepack wählen.');
      return;
    }
    sessionStorage.removeItem('cv_roomCode');
    sessionStorage.removeItem('cv_playerId');
    location.href = `/play.html?mp=1&pack=${encodeURIComponent(packId)}&name=${encodeURIComponent(name)}`;
  });

  btnJoin.addEventListener('click', () => {
    const codeVal = joinCode.value.trim().toUpperCase();
    const name = joinName.value.trim();
    if (!codeVal || codeVal.length < 4) {
      alert('Bitte gültigen Room-Code eingeben.');
      return;
    }
    if (!name) {
      alert('Bitte einen Namen eingeben.');
      return;
    }
    location.href = `/play.html?code=${encodeURIComponent(codeVal)}&name=${encodeURIComponent(name)}`;
  });

  if (projectPackFilter) {
    projectPackFilter.addEventListener('change', () => renderProjects());
  }
  if (btnImportProjectFile && projectFileInput) {
    btnImportProjectFile.addEventListener('click', () => projectFileInput.click());
    projectFileInput.addEventListener('change', async () => {
      const file = projectFileInput.files?.[0];
      projectFileInput.value = '';
      if (!file || typeof CVProjects === 'undefined') return;
      try {
        await CVProjects.importProjectFile(file);
        await loadProjects();
      } catch (err) {
        alert(err.message || 'Import fehlgeschlagen.');
      }
    });
  }

  loadPacks();
})();
