(function (global) {
  const DB_NAME = 'laggagames-projects';
  const DB_VERSION = 1;
  const STORE = 'projects';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('packId', 'packId', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB fehlgeschlagen.'));
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try {
        result = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || new Error('IndexedDB-Transaktion fehlgeschlagen.'));
      };
    });
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function listProjects() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result || []).slice().sort((a, b) => {
          return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
        });
        db.close();
        resolve(rows);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function getProject(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  }

  async function saveProject(project) {
    if (!project?.id) throw new Error('Projekt-ID fehlt.');
    const row = {
      ...project,
      savedAt: project.savedAt || new Date().toISOString(),
    };
    await withStore('readwrite', (store) => store.put(row));
    return row;
  }

  async function deleteProject(id) {
    await withStore('readwrite', (store) => store.delete(id));
  }

  /** Meta only for lists (no audio blobs). */
  function summarize(project) {
    if (!project) return null;
    const takeCount = Object.keys(project.takes || {}).length;
    return {
      id: project.id,
      packId: project.packId,
      title: project.title,
      name: project.name,
      savedAt: project.savedAt,
      mode: project.mode || 'solo',
      takeCount,
    };
  }

  async function listSummaries() {
    const all = await listProjects();
    return all.map(summarize);
  }

  function downloadProjectFile(project) {
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(project.name || project.title || 'projekt').replace(/[^\w\-]+/g, '_')}.cvproject.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function importProjectFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.packId || !data.takes) {
      throw new Error('Ungültige Projektdatei.');
    }
    const id = data.id || (global.crypto?.randomUUID?.() || `p-${Date.now()}`);
    const row = {
      ...data,
      id,
      savedAt: new Date().toISOString(),
      name: data.name || `${data.title || data.packId} · Import`,
    };
    await saveProject(row);
    return row;
  }

  global.CVProjects = {
    listProjects,
    listSummaries,
    getProject,
    saveProject,
    deleteProject,
    summarize,
    downloadProjectFile,
    importProjectFile,
  };
})(window);
