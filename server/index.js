const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const { listGames, getGame } = require('./registry');
const PartyManager = require('./partyManager');
const { attachPartySocket } = require('./partySocket');

const PORT = Number(process.env.PORT || 3000);
const GAME_PORT_BASE = Number(process.env.GAME_PORT_BASE || 3101);
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';
const HUB_INTERNAL_URL = process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${PORT}`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true },
  path: '/socket.io',
});

const parties = new PartyManager();

const hubPublic = path.join(__dirname, '..', 'hub', 'public');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(hubPublic));

// Railway / Render healthcheck — must exist on the hub, not only on games
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'lagga-club-hub',
    games: listGames().map((g) => g.slug),
  });
});

app.get('/api/games', (_req, res) => {
  const games = listGames().map(({ dir, ...rest }) => rest);
  res.json({ games });
});

app.get('/api/games/:slug', (req, res) => {
  const game = getGame(req.params.slug);
  if (!game) {
    res.status(404).json({ error: 'Spiel nicht gefunden.' });
    return;
  }
  const { dir, ...rest } = game;
  res.json(rest);
});

function assertPartyToken(req, res) {
  const token = req.get('x-party-token') || req.query.token;
  if (token !== PARTY_INTERNAL_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/party/:partyId', (req, res) => {
  if (!assertPartyToken(req, res)) return;
  const party = parties.getParty(req.params.partyId);
  if (!party) {
    res.status(404).json({ error: 'Party nicht gefunden.' });
    return;
  }
  res.json({ ok: true, party: parties.publicState(party) });
});

app.post('/api/party/:partyId/return', (req, res) => {
  if (!assertPartyToken(req, res)) return;
  const party = parties.getParty(req.params.partyId);
  if (!party) {
    res.status(404).json({ error: 'Party nicht gefunden.' });
    return;
  }
  parties.returnToLobby(party);
  const state = parties.publicState(party);
  io.to(`party:${party.id}`).emit('party:state', state);
  io.to(`party:${party.id}`).emit('party:returned', state);
  res.json({ ok: true, party: state });
});

/** @type {Map<string, { port: number, child: import('child_process').ChildProcess }>} */
const running = new Map();

function ensureGameProcess(slug) {
  if (running.has(slug)) return running.get(slug);
  const meta = getGame(slug);
  if (!meta) throw new Error(`Unbekanntes Spiel: ${slug}`);
  const port = GAME_PORT_BASE + running.size;
  const entry = path.join(meta.dir, meta.entry || 'server/index.js');
  if (!fs.existsSync(entry)) throw new Error(`Entry fehlt: ${entry}`);

  const child = spawn(process.execPath, [entry], {
    cwd: meta.dir,
    env: {
      ...process.env,
      PORT: String(port),
      HUB_INTERNAL_URL,
      PARTY_INTERNAL_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[${slug}] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[${slug}] ${buf}`));
  child.on('exit', (code) => {
    console.warn(`[${slug}] exited (${code})`);
    running.delete(slug);
  });
  const info = { port, child };
  running.set(slug, info);
  return info;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGame(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Spiel auf Port ${port} startet nicht (Health-Check).`);
}

async function proxyToGame(slug, req, res) {
  let info;
  try {
    info = ensureGameProcess(slug);
    if (!info.ready) {
      await waitForGame(info.port);
      info.ready = true;
    }
  } catch (e) {
    res.status(404).send(e.message || 'Spiel nicht gefunden');
    return;
  }

  // Express strips the mount path: req.url is already "/play.html?..." etc.
  let urlPath = req.url || '/';
  if (!urlPath.startsWith('/')) urlPath = `/${urlPath}`;

  const headers = { ...req.headers, host: `127.0.0.1:${info.port}` };
  delete headers['content-length'];

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: info.port,
      path: urlPath,
      method: req.method,
      headers,
    },
    (up) => {
      up.on('error', () => {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      });
      res.on('error', () => {
        try {
          up.destroy();
        } catch {
          /* ignore */
        }
      });
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).send(`Spiel-Proxy-Fehler (${slug}): ${err.message}`);
    } else {
      res.end();
    }
  });
  req.on('error', () => {
    try {
      upstream.destroy();
    } catch {
      /* ignore */
    }
  });
  req.pipe(upstream);
}

app.get('/g/:slug', (req, res, next) => {
  // Only redirect the bare /g/<slug> (no trailing slash) → /g/<slug>/
  if (req.path.endsWith('/')) return next();
  res.redirect(302, `/g/${req.params.slug}/`);
});

app.use('/g/:slug', (req, res) => {
  proxyToGame(req.params.slug, req, res);
});

attachPartySocket(io, parties, { getGame });

server.on('upgrade', async (req, socket, head) => {
  const url = String(req.url || '');
  // Hub Socket.io owns non-game upgrades — do not destroy them.
  if (!url.startsWith('/g/')) {
    return;
  }

  const match = url.match(/^\/g\/([^/]+)(.*)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const slug = match[1];
  let urlPath = match[2] || '/';
  if (!urlPath.startsWith('/')) urlPath = `/${urlPath}`;

  let info;
  try {
    info = ensureGameProcess(slug);
    if (!info.ready) {
      await waitForGame(info.port);
      info.ready = true;
    }
  } catch {
    socket.destroy();
    return;
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: info.port,
    path: urlPath,
    method: 'GET',
    headers: { ...req.headers, host: `127.0.0.1:${info.port}` },
  });
  socket.on('error', () => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });

  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    upSocket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n') +
        '\r\n\r\n'
    );
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('error', () => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  });
  if (head && head.length) upstream.write(head);
  upstream.end();
});

// Express 5: no bare "*". Fallback after static / API / game mounts.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/g/') || req.path === '/health') {
    return next();
  }
  res.sendFile(path.join(hubPublic, 'index.html'), (err) => {
    if (err) next();
  });
});

server.listen(PORT, () => {
  const games = listGames();
  console.log(`Lagga Club Hub on :${PORT}`);
  console.log(
    `Games: ${games.map((g) => `${g.slug} → /g/${g.slug}/`).join(', ') || '(noch keine)'}`
  );
});

function shutdown() {
  for (const [slug, info] of running) {
    try {
      info.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    console.log(`stopped ${slug}`);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Proxy sockets can emit ECONNRESET after clients disconnect — do not crash the hub.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
    console.warn('[hub] ignored socket error:', err.code);
    return;
  }
  console.error(err);
  process.exit(1);
});
