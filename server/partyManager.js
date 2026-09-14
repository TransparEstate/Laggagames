const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PARTY_TTL_MS = 60 * 60 * 1000;

function makeId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

class PartyManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.parties = new Map();
    /** @type {Map<string, string>} socketId -> partyId */
    this.socketToParty = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  generateCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.parties.has(code)) return code;
    }
    throw new Error('Konnte keinen freien Party-Code erzeugen.');
  }

  publicState(party) {
    if (!party) return null;
    return {
      id: party.id,
      code: party.id,
      leadId: party.leadId,
      members: party.members.map((m) => ({
        id: m.id,
        name: m.name,
        connected: m.connected !== false,
        isLead: m.id === party.leadId,
      })),
      status: party.status,
      selectedGame: party.selectedGame,
      currentGame: party.currentGame,
      memberCount: party.members.length,
    };
  }

  createParty(socketId, name) {
    const trimmed = String(name || '').trim().slice(0, 24);
    if (!trimmed) return { error: 'Name erforderlich.' };

    const id = this.generateCode();
    const memberId = makeId('m_');
    const member = {
      id: memberId,
      name: trimmed,
      socketId,
      connected: true,
      disconnectedAt: null,
    };
    const party = {
      id,
      leadId: memberId,
      members: [member],
      status: 'lobby',
      selectedGame: null,
      currentGame: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.parties.set(id, party);
    this.socketToParty.set(socketId, id);
    return { ok: true, party, memberId };
  }

  getParty(partyId) {
    if (!partyId) return null;
    return this.parties.get(String(partyId).toUpperCase()) || null;
  }

  getPartyForSocket(socketId) {
    const id = this.socketToParty.get(socketId);
    return id ? this.getParty(id) : null;
  }

  findMember(party, memberId) {
    return party.members.find((m) => m.id === memberId) || null;
  }

  joinParty(code, socketId, name) {
    const party = this.getParty(code);
    if (!party) return { error: 'Party nicht gefunden.' };
    if (party.status === 'in_game') {
      return { error: 'Party ist gerade in einem Spiel — warte auf die Lobby.' };
    }

    const trimmed = String(name || '').trim().slice(0, 24);
    if (!trimmed) return { error: 'Name erforderlich.' };

    const prev = this.socketToParty.get(socketId);
    if (prev && prev !== party.id) {
      this.leaveSocket(socketId, { hard: true });
    }

    const offline = party.members.find(
      (m) => m.connected === false && m.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (offline) {
      offline.socketId = socketId;
      offline.connected = true;
      offline.disconnectedAt = null;
      this.socketToParty.set(socketId, party.id);
      party.lastActivity = Date.now();
      return { ok: true, party, memberId: offline.id, reclaimed: true };
    }

    if (party.members.some((m) => m.name.toLowerCase() === trimmed.toLowerCase())) {
      return { error: 'Name bereits vergeben.' };
    }
    if (party.members.length >= 12) return { error: 'Party ist voll (max. 12).' };

    const memberId = makeId('m_');
    party.members.push({
      id: memberId,
      name: trimmed,
      socketId,
      connected: true,
      disconnectedAt: null,
    });
    this.socketToParty.set(socketId, party.id);
    party.lastActivity = Date.now();
    return { ok: true, party, memberId };
  }

  reconnect(partyId, memberId, socketId) {
    const party = this.getParty(partyId);
    if (!party) return { error: 'Party nicht gefunden.' };
    const member = this.findMember(party, memberId);
    if (!member) return { error: 'Mitglied nicht gefunden.' };

    const prev = this.socketToParty.get(socketId);
    if (prev && prev !== party.id) {
      this.leaveSocket(socketId, { hard: false });
    }

    if (member.socketId && member.socketId !== socketId) {
      this.socketToParty.delete(member.socketId);
    }
    member.socketId = socketId;
    member.connected = true;
    member.disconnectedAt = null;
    this.socketToParty.set(socketId, party.id);
    party.lastActivity = Date.now();
    return { ok: true, party, memberId: member.id };
  }

  leaveSocket(socketId, opts = {}) {
    const hard = !!opts.hard;
    const partyId = this.socketToParty.get(socketId);
    this.socketToParty.delete(socketId);
    if (!partyId) return null;

    const party = this.parties.get(partyId);
    if (!party) return null;

    const target = party.members.find((m) => m.socketId === socketId) || null;
    if (!target && hard) {
      // nothing to remove
      return { party, empty: false };
    }
    if (!target) return { party, empty: false };

    if (hard) {
      party.members = party.members.filter((m) => m.id !== target.id);
      if (party.leadId === target.id && party.members.length) {
        party.leadId = party.members[0].id;
      }
      party.lastActivity = Date.now();
      if (!party.members.length) {
        this.parties.delete(partyId);
        return { partyId, empty: true, hard: true };
      }
      return { party, empty: false, hard: true, leftMemberId: target.id };
    }

    target.connected = false;
    target.disconnectedAt = Date.now();
    target.socketId = null;
    party.lastActivity = Date.now();
    return { party, empty: false, soft: true };
  }

  selectGame(party, memberId, slug) {
    if (!party) return { error: 'Party nicht gefunden.' };
    if (party.leadId !== memberId) return { error: 'Nur der Lobby-Lead wählt das Spiel.' };
    if (party.status !== 'lobby') return { error: 'Spielwahl nur in der Lobby.' };
    const trimmed = String(slug || '').trim();
    if (!trimmed) return { error: 'Spiel fehlt.' };
    party.selectedGame = trimmed;
    party.lastActivity = Date.now();
    return { ok: true };
  }

  startGame(party, memberId, slug) {
    if (!party) return { error: 'Party nicht gefunden.' };
    if (party.leadId !== memberId) return { error: 'Nur der Lobby-Lead startet das Spiel.' };
    if (party.status !== 'lobby') return { error: 'Party ist nicht in der Lobby.' };
    const gameSlug = String(slug || party.selectedGame || '').trim();
    if (!gameSlug) return { error: 'Kein Spiel ausgewählt.' };
    party.selectedGame = gameSlug;
    party.currentGame = gameSlug;
    party.status = 'in_game';
    party.lastActivity = Date.now();
    return { ok: true, slug: gameSlug };
  }

  returnToLobby(party) {
    if (!party) return { error: 'Party nicht gefunden.' };
    party.status = 'lobby';
    party.currentGame = null;
    party.lastActivity = Date.now();
    return { ok: true };
  }

  cleanup() {
    const now = Date.now();
    for (const [id, party] of this.parties.entries()) {
      const allGone = party.members.every((m) => m.connected === false);
      const stale = now - party.lastActivity > PARTY_TTL_MS;
      if (allGone && stale) {
        for (const m of party.members) {
          if (m.socketId) this.socketToParty.delete(m.socketId);
        }
        this.parties.delete(id);
      }
    }
  }
}

module.exports = PartyManager;
