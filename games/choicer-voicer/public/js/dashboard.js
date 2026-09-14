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
  const projectList = document.getElementById('projectList');
  const projectPackFilter = document.getElementById('projectPackFilter');
  const btnImportProjectFile = document.getElementById('btnImportProjectFile');
  const projectFileInput = document.getElementById('projectFileInput');
  const partyBanner = document.getElementById('partyBanner');
  const partyBannerText = document.getElementById('partyBannerText');
  const partyName = document.getElementById('partyName');
  const partyPack = document.getElementById('partyPack');
  const btnPartyStart = document.getElementById('btnPartyStart');
  const soloSections = document.getElementById('soloSections');
  const projectsSection = document.getElementById('projectsSection');
  const dashTagline = document.getElementById('dashTagline');

  let maxUploadMb = 1500;
  let processPulse = null;
  let cachedPacks = [];
  let cachedProjects = [];

  const params = new URLSearchParams(location.search);
  const partyId = (params.get('party') || '').toUpperCase();
  const partyMemberId = params.get('member') || '';
  const inParty = !!partyId;

  function gamePath(p) {
    return typeof gameUrl === 'function' ? gameUrl(p) : p;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 1) return '—';
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes > 200 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function showUploadError(msg) {
    if (!uploadError) return;
    uploadError.textContent = msg || '';
    uploadError.classList.toggle('hidden', !msg);
    if (msg && uploadOk) uploadOk.classList.add('hidden');
  }

  function showUploadOk(msg) {
    if (!uploadOk) return;
    uploadOk.textContent = msg || '';
    uploadOk.classList.toggle('hidden', !msg);
    if (msg && uploadError) uploadError.classList.add('hidden');
  }

  function setProgress(pct, text) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    if (uploadProgressFill) uploadProgressFill.style.width = `${clamped}%`;
    if (uploadProgressText) uploadProgressText.textContent = text || `${clamped}%`;
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
    setProgress(72, 'Wird eingerichtet… bitte warten');
    processPulse = setInterval(() => {
      tick += 1;
      setProgress(72 + Math.min(20, tick), 'Wird eingerichtet… bitte warten');
    }, 2500);
  }

  function applyPartyMode() {
    if (!inParty) return;
    partyBanner?.classList.remove('hidden');
    soloSections?.classList.add('hidden');
    projectsSection?.classList.add('hidden');
    if (dashTagline) {
      dashTagline.textContent =
        'Party-Modus: Solo ist gesperrt. Wähle ein Pack und starte die gemeinsame Session.';
    }
    if (partyName && params.get('name')) partyName.value = params.get('name');
    if (partyBannerText) {
      partyBannerText.textContent = `Party ${partyId} — Multiplayer-Session für alle Mitglieder.`;
    }
  }

  function fillPartyPackSelect(packs) {
    if (!partyPack) return;
    partyPack.innerHTML = '';
    if (!packs.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Kein Pack verfügbar';
      partyPack.appendChild(opt);
      partyPack.disabled = true;
      if (btnPartyStart) btnPartyStart.disabled = true;
      return;
    }
    partyPack.disabled = false;
    if (btnPartyStart) btnPartyStart.disabled = false;
    packs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.title} (${p.sceneCount} Clips)`;
      partyPack.appendChild(opt);
    });
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

  function updateStorageHint(r2) {
    if (!storageHint) return;
    if (r2?.enabled) {
      storageHint.textContent = `Cloudflare R2 aktiv (${r2.bucket || 'R2'}) — Packs sind für alle Nutzer geteilt.`;
      storageHint.classList.remove('hidden', 'error');
      return;
    }
    storageHint.textContent =
      'Cloudflare R2 fehlt — Uploads sind deaktiviert. Packs werden nur in R2 gespeichert.';
    storageHint.classList.remove('hidden');
    storageHint.classList.add('error');
  }

  async function loadProjects() {
    if (!projectList || typeof CVProjects === 'undefined' || inParty) return;
    try {
      cachedProjects = await CVProjects.listSummaries();
      renderProjects();
    } catch (err) {
      projectList.innerHTML = '<p class="error">Projekte konnten nicht geladen werden.</p>';
      console.warn(err);
    }
  }

  function renderProjects() {
    if (!projectList || inParty) return;
    const filter = projectPackFilter?.value || '';
    const rows = cachedProjects.filter((p) => !filter || p.packId === filter);
    if (!rows.length) {
      projectList.innerHTML =
        '<p class="muted">Noch keine lokalen Projekte — nach der Premiere speichern.</p>';
      return;
    }
    const packTitle = (id) => cachedPacks.find((p) => p.id === id)?.title || id;
    projectList.innerHTML = '';
    rows.forEach((p) => {
      const when = p.savedAt
        ? new Date(p.savedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
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
        </div>`;
      projectList.appendChild(el);
    });

    projectList.querySelectorAll('[data-open-project]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = gamePath(
          `/play.html?project=${encodeURIComponent(btn.getAttribute('data-open-project'))}`
        );
      });
    });
    projectList.querySelectorAll('[data-edit-project]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = gamePath(
          `/play.html?project=${encodeURIComponent(btn.getAttribute('data-edit-project'))}&edit=1`
        );
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

  function renderPacks(packs) {
    if (!packGrid) return;
    packGrid.innerHTML = '';
    if (!packs.length) {
      packGrid.innerHTML = '<p class="muted">Noch keine Packs — ZIP oben hochladen.</p>';
      return;
    }

    packs.forEach((pack) => {
      const card = document.createElement('article');
      card.className = 'pack-card';
      const iconSrc =
        pack.iconUrl && typeof assetUrl === 'function'
          ? assetUrl(pack.iconUrl)
          : pack.iconUrl;
      const icon = iconSrc
        ? `<img class="pack-card-icon" src="${escapeHtml(iconSrc)}" alt="" />`
        : `<div class="pack-card-icon placeholder">🎙</div>`;
      const action = inParty
        ? `<button type="button" class="btn" data-party-pack="${escapeHtml(pack.id)}">Für Party</button>`
        : `<button type="button" class="btn" data-solo="${escapeHtml(pack.id)}">Alleine</button>`;
      card.innerHTML = `
        <div class="pack-card-top">
          ${icon}
          <div>
            <h3>${escapeHtml(pack.title)}</h3>
            <p class="muted">${pack.sceneCount} Clips · ${pack.characters?.length || 0} Charaktere · ${formatSize(pack.sizeBytes)}</p>
          </div>
        </div>
        <div class="pack-card-actions">
          ${action}
          ${
            !inParty && (pack.source === 'user' || pack.source === 'r2')
              ? `<button type="button" class="btn btn-ghost btn-sm" data-del="${escapeHtml(pack.id)}" title="Löschen">✕</button>`
              : ''
          }
        </div>`;
      packGrid.appendChild(card);
    });

    packGrid.querySelectorAll('[data-solo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        location.href = gamePath(
          `/play.html?solo=1&pack=${encodeURIComponent(btn.getAttribute('data-solo'))}`
        );
      });
    });
    packGrid.querySelectorAll('[data-party-pack]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (partyPack) partyPack.value = btn.getAttribute('data-party-pack');
        startPartySession();
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

  async function loadPacks() {
    try {
      const res = await fetch('/api/packs');
      const data = await res.json();
      maxUploadMb = data.maxUploadMb || 1500;
      cachedPacks = data.packs || [];
      fillPartyPackSelect(cachedPacks);
      fillProjectPackFilter(cachedPacks);
      renderPacks(cachedPacks);
      updateStorageHint(data.r2);
      if (!inParty) await loadProjects();
    } catch {
      if (packGrid) packGrid.innerHTML = '<p class="error">Packs konnten nicht geladen werden.</p>';
    }
  }

  function uploadZip(file) {
    if (!file || inParty) return;
    const name = String(file.name || '');
    const looksZip = /\.zip$/i.test(name) || /zip/i.test(file.type || '');
    if (!looksZip) {
      showUploadError('Bitte eine .zip Datei wählen.');
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      showUploadError(`Datei zu groß (max. ${maxUploadMb} MB).`);
      return;
    }

    stopProcessPulse();
    showUploadError('');
    showUploadOk('');
    uploadProgressWrap?.classList.remove('hidden');
    setProgress(0, 'Senden… 0%');
    uploadDrop?.classList.add('uploading');

    const form = new FormData();
    form.append('pack', file, name || 'pack.zip');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/packs/upload');
    xhr.timeout = 20 * 60 * 1000;

    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      const pct = Math.round((ev.loaded / ev.total) * 70);
      setProgress(pct, `Senden… ${Math.round((ev.loaded / ev.total) * 100)}%`);
    };
    xhr.upload.onload = () => startProcessPulse();

    xhr.onload = async () => {
      stopProcessPulse();
      uploadDrop?.classList.remove('uploading');
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok) {
        setProgress(100, 'Fertig');
        showUploadOk(
          data.duplicate
            ? `„${data.pack?.title || data.pack?.id}“ war schon vorhanden (Duplikat übersprungen).`
            : `„${data.pack?.title || data.pack?.id}“ ist in Cloudflare R2 für alle bereit.`
        );
        await loadPacks();
        setTimeout(() => {
          uploadProgressWrap?.classList.add('hidden');
          showUploadOk('');
        }, 2500);
      } else {
        showUploadError(data.error || `Upload fehlgeschlagen (${xhr.status}).`);
        uploadProgressWrap?.classList.add('hidden');
      }
    };
    xhr.onerror = () => {
      stopProcessPulse();
      uploadDrop?.classList.remove('uploading');
      showUploadError('Netzwerkfehler beim Upload.');
      uploadProgressWrap?.classList.add('hidden');
    };
    xhr.ontimeout = () => {
      stopProcessPulse();
      uploadDrop?.classList.remove('uploading');
      showUploadError('Zeitüberschreitung beim Upload.');
      uploadProgressWrap?.classList.add('hidden');
    };
    xhr.send(form);
  }

  function openPackPicker() {
    if (!packFile || uploadDrop?.classList.contains('uploading') || inParty) return;
    packFile.value = '';
    packFile.click();
  }

  function startPartySession() {
    if (!inParty) return;
    const name = (partyName?.value || params.get('name') || '').trim();
    const packId = partyPack?.value || '';
    if (!name) {
      alert('Bitte einen Namen eingeben.');
      return;
    }
    const q = new URLSearchParams({ party: partyId, name });
    if (packId) q.set('pack', packId);
    if (partyMemberId) q.set('member', partyMemberId);
    location.href = gamePath(`/play.html?${q.toString()}`);
  }

  if (uploadDrop && !inParty) {
    uploadDrop.addEventListener('click', (e) => {
      if (e.target === btnPickZip || btnPickZip?.contains(e.target)) return;
      openPackPicker();
    });
    btnPickZip?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPackPicker();
    });
    uploadDrop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPackPicker();
      }
    });
    packFile?.addEventListener('change', () => {
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
  }

  btnPartyStart?.addEventListener('click', startPartySession);
  projectPackFilter?.addEventListener('change', () => renderProjects());

  if (btnImportProjectFile && projectFileInput && !inParty) {
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

  applyPartyMode();
  loadPacks();
})();
