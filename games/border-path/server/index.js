const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const game = require('./gameLogic');

const PORT = Number(process.env.PORT) || 3020;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const HUB_INTERNAL_URL = (
  process.env.HUB_INTERNAL_URL || `http://127.0.0.1:${process.env.HUB_PORT || 3000}`
).replace(/\/$/, '');
const PARTY_INTERNAL_TOKEN = process.env.PARTY_INTERNAL_TOKEN || 'dev-party-token';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

async function fetchHubParty(partyId) {
  const id = String(partyId || '').toUpperCase();
  if (!id) return { error: 'partyId fehlt.' };
  try {
    const res = await fetch(`${HUB_INTERNAL_URL}/api/party/${encodeURIComponent(id)}`, {
      headers: { 'x-party-token': PARTY_INTERNAL_TOKEN },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `Hub-Party ${res.status}` };
    return { ok: true, party: data.party };
  } catch (err) {
    return { error: err.message || 'Hub nicht erreichbar.' };
  }
}

async function postHubPartyReturn(partyId) {
  const id = String(partyId || '').toUpperCase();
  if (!id) return { error: 'partyId fehlt.' };
  try {
    const res = await fetch(`${HUB_INTERNAL_URL}/api/party/${encodeURIComponent(id)}/return`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-party-token': PARTY_INTERNAL_TOKEN,
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `Hub-Return ${res.status}` };
    return { ok: true, party: data.party };
  } catch (err) {
    return { error: err.message || 'Hub nicht erreichbar.' };
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    game: 'border-path',
    meta: game.meta,
    difficulties: game.difficulties(),
  });
});

app.get('/api/meta', (_req, res) => {
  res.json({ ok: true, meta: game.meta, difficulties: game.difficulties() });
});

app.get('/api/world', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', 'geo', 'world.geojson'));
});

app.get('/api/suggest', (req, res) => {
  res.json({ ok: true, suggestions: game.suggestNames(String(req.query.q || '')) });
});

app.post('/api/round', (req, res) => {
  try {
    const difficulty = String(req.body?.difficulty || 'medium');
    const session = game.getOrCreateSession(req.body?.sessionId);
    const state = game.newRound(session, difficulty);
    res.json({ ok: true, state });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Runde fehlgeschlagen.' });
  }
});

app.get('/api/round/:sessionId', (req, res) => {
  const session = game.sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  res.json({ ok: true, state: game.serializeRound(session) });
});

app.post('/api/guess', (req, res) => {
  const session = game.sessions.get(String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  const result = game.applyGuess(session, req.body?.name);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/hint', (req, res) => {
  const session = game.sessions.get(String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'Session nicht gefunden.' });
  const result = game.applyHint(session);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

const partyPlayers = new Map();

io.on('connection', (socket) => {
  socket.on('session:join-party', async (payload = {}, ack) => {
    try {
      const partyId = String(payload.partyId || '').toUpperCase();
      const name = String(payload.name || '').trim() || 'Spieler';
      const memberId = String(payload.memberId || '').trim();
      if (!partyId) {
        if (typeof ack === 'function') ack({ error: 'partyId nötig.' });
        return;
      }
      const hub = await fetchHubParty(partyId);
      if (hub.error) {
        if (typeof ack === 'function') ack({ error: hub.error });
        return;
      }
      partyPlayers.set(socket.id, { partyId, name, memberId });
      socket.join(`party:${partyId}`);
      if (typeof ack === 'function') {
        ack({
          ok: true,
          partyId,
          playerId: socket.id,
          party: hub.party,
          mode: 'solo-in-party',
        });
      }
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Join fehlgeschlagen.' });
    }
  });

  socket.on('session:return-to-lobby', async (_payload, ack) => {
    try {
      const info = partyPlayers.get(socket.id);
      if (!info?.partyId) {
        if (typeof ack === 'function') ack({ error: 'Keine Party-Session.' });
        return;
      }
      const { partyId } = info;
      await postHubPartyReturn(partyId);
      partyPlayers.delete(socket.id);
      socket.emit('session:returned', { partyId });
      if (typeof ack === 'function') ack({ ok: true, partyId });
    } catch (err) {
      if (typeof ack === 'function') ack({ error: err.message || 'Return fehlgeschlagen.' });
    }
  });

  socket.on('disconnect', () => {
    partyPlayers.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Border Path on :${PORT}`);
});
