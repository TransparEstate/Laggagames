/**
 * Hub party socket handlers.
 * @param {import('socket.io').Server} io
 * @param {import('./partyManager')} parties
 * @param {{ getGame: (slug: string) => object | null }} deps
 */
function attachPartySocket(io, parties, deps) {
  const { getGame } = deps;

  function emitState(party) {
    if (!party) return;
    const state = parties.publicState(party);
    io.to(`party:${party.id}`).emit('party:state', state);
  }

  function ackOk(ack, payload) {
    if (typeof ack === 'function') ack({ ok: true, ...payload });
  }

  function ackErr(ack, error) {
    if (typeof ack === 'function') ack({ error: String(error || 'Fehler') });
  }

  io.on('connection', (socket) => {
    socket.on('party:create', (payload = {}, ack) => {
      try {
        const result = parties.createParty(socket.id, payload.name);
        if (result.error) return ackErr(ack, result.error);
        socket.join(`party:${result.party.id}`);
        socket.data.partyId = result.party.id;
        socket.data.memberId = result.memberId;
        ackOk(ack, {
          party: parties.publicState(result.party),
          memberId: result.memberId,
        });
        emitState(result.party);
      } catch (err) {
        ackErr(ack, err.message || 'Party erstellen fehlgeschlagen.');
      }
    });

    socket.on('party:join', (payload = {}, ack) => {
      try {
        const result = parties.joinParty(payload.code || payload.partyId, socket.id, payload.name);
        if (result.error) return ackErr(ack, result.error);
        socket.join(`party:${result.party.id}`);
        socket.data.partyId = result.party.id;
        socket.data.memberId = result.memberId;
        ackOk(ack, {
          party: parties.publicState(result.party),
          memberId: result.memberId,
          reclaimed: !!result.reclaimed,
        });
        emitState(result.party);
      } catch (err) {
        ackErr(ack, err.message || 'Beitritt fehlgeschlagen.');
      }
    });

    socket.on('party:reconnect', (payload = {}, ack) => {
      try {
        const result = parties.reconnect(payload.partyId || payload.code, payload.memberId, socket.id);
        if (result.error) return ackErr(ack, result.error);
        socket.join(`party:${result.party.id}`);
        socket.data.partyId = result.party.id;
        socket.data.memberId = result.memberId;
        ackOk(ack, {
          party: parties.publicState(result.party),
          memberId: result.memberId,
        });
        emitState(result.party);
      } catch (err) {
        ackErr(ack, err.message || 'Reconnect fehlgeschlagen.');
      }
    });

    socket.on('party:leave', (_payload, ack) => {
      const result = parties.leaveSocket(socket.id, { hard: true });
      socket.data.partyId = null;
      socket.data.memberId = null;
      ackOk(ack, {});
      if (result?.party && !result.empty) emitState(result.party);
    });

    socket.on('party:selectGame', (payload = {}, ack) => {
      const party = parties.getPartyForSocket(socket.id);
      const memberId = socket.data.memberId;
      const slug = payload.slug;
      const game = getGame(slug);
      if (!game) return ackErr(ack, 'Spiel nicht gefunden.');
      if (!game.partySupport) return ackErr(ack, 'Dieses Spiel unterstützt keine Party.');
      const result = parties.selectGame(party, memberId, slug);
      if (result.error) return ackErr(ack, result.error);
      ackOk(ack, { party: parties.publicState(party) });
      emitState(party);
    });

    socket.on('party:startGame', (payload = {}, ack) => {
      const party = parties.getPartyForSocket(socket.id);
      const memberId = socket.data.memberId;
      const slug = payload.slug || party?.selectedGame;
      const game = getGame(slug);
      if (!game) return ackErr(ack, 'Spiel nicht gefunden.');
      if (!game.partySupport) return ackErr(ack, 'Dieses Spiel unterstützt keine Party.');
      const result = parties.startGame(party, memberId, slug);
      if (result.error) return ackErr(ack, result.error);

      const state = parties.publicState(party);
      const launch = {
        slug: result.slug,
        partyId: party.id,
        members: state.members,
        leadId: party.leadId,
      };
      ackOk(ack, { party: state, launch });
      emitState(party);
      io.to(`party:${party.id}`).emit('party:launch', launch);
    });

    socket.on('party:returnToLobby', (_payload, ack) => {
      const party = parties.getPartyForSocket(socket.id);
      const memberId = socket.data.memberId;
      if (!party) return ackErr(ack, 'Keine Party.');
      if (party.leadId !== memberId) return ackErr(ack, 'Nur der Lead kehrt zur Lobby zurück.');
      const result = parties.returnToLobby(party);
      if (result.error) return ackErr(ack, result.error);
      ackOk(ack, { party: parties.publicState(party) });
      emitState(party);
      io.to(`party:${party.id}`).emit('party:returned', parties.publicState(party));
    });

    socket.on('disconnect', () => {
      const result = parties.leaveSocket(socket.id, { hard: false });
      if (result?.party && !result.empty) emitState(result.party);
    });
  });
}

module.exports = { attachPartySocket };
