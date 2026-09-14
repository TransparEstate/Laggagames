const {
  createEmptyRoom,
  publicState,
  addPlayer,
  removePlayer,
  softDisconnect,
  updatePlayerSocket,
  claimHost,
} = require('./gameLogic');

const ROOM_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.socketToRoom = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  generateCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Konnte keinen freien Room-Code erzeugen.');
  }

  createRoom(hostSocketId) {
    const code = this.generateCode();
    const room = createEmptyRoom(code, hostSocketId);
    this.rooms.set(code, room);
    this.socketToRoom.set(hostSocketId, code);
    return room;
  }

  /**
   * Party session: room key = hub partyId (no public room codes).
   */
  getOrCreatePartyRoom(partyId, hostSocketId) {
    const code = String(partyId || '').toUpperCase();
    if (!code) throw new Error('partyId fehlt.');
    let room = this.rooms.get(code);
    if (!room) {
      room = createEmptyRoom(code, hostSocketId);
      room.partyId = code;
      room.solo = false;
      this.rooms.set(code, room);
    }
    this.socketToRoom.set(hostSocketId, code);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase()) || null;
  }

  getRoomForSocket(socketId) {
    const code = this.socketToRoom.get(socketId);
    return code ? this.getRoom(code) : null;
  }

  joinRoom(code, socketId, name) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Raum nicht gefunden.' };
    // Drop stale socket mapping if this socket was in another room
    const prev = this.socketToRoom.get(socketId);
    if (prev && prev !== room.code) {
      this.leaveSocket(socketId, { hard: false });
    }
    const result = addPlayer(room, socketId, name);
    if (result.error) return result;
    this.socketToRoom.set(socketId, room.code);
    return { ok: true, room, player: result.player, reclaimed: !!result.reclaimed };
  }

  /**
   * @param {string} socketId
   * @param {{ hard?: boolean }} [opts] hard=true removes the player; default soft keeps seat for reconnect
   */
  leaveSocket(socketId, opts = {}) {
    const hard = !!opts.hard;
    const code = this.socketToRoom.get(socketId);
    this.socketToRoom.delete(socketId);
    if (!code) return null;

    const room = this.rooms.get(code);
    if (!room) return null;

    if (hard) {
      const result = removePlayer(room, socketId);
      if (result.empty || room.players.length === 0) {
        this.rooms.delete(code);
        return { code, empty: true, hard: true };
      }
      return { code, room, empty: false, hard: true, hostLeft: !!result.hostLeft };
    }

    softDisconnect(room, socketId);
    // Never delete room on soft disconnect — TTL cleanup handles abandoned rooms
    return { code, room, empty: false, soft: true };
  }

  reconnect(code, oldPlayerId, newSocketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Raum nicht gefunden.' };
    const player = room.players.find((p) => p.id === oldPlayerId);
    if (!player) return { error: 'Spieler nicht gefunden — mit gleichem Namen erneut beitreten.' };

    // Clear any mapping for the new socket
    const prevCode = this.socketToRoom.get(newSocketId);
    if (prevCode && prevCode !== room.code) {
      this.leaveSocket(newSocketId, { hard: false });
    }

    const ok = updatePlayerSocket(room, oldPlayerId, newSocketId);
    if (!ok) return { error: 'Spieler nicht gefunden.' };
    player.connected = true;
    player.disconnectedAt = null;
    if (room.hostId === newSocketId || room.hostId === oldPlayerId) {
      room.hostId = newSocketId;
      room.hostSocketId = newSocketId;
    }
    this.socketToRoom.set(newSocketId, room.code);
    room.lastActivity = Date.now();
    return { ok: true, room };
  }

  reattachHost(code, socketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Raum nicht gefunden.' };
    claimHost(room, socketId);
    this.socketToRoom.set(socketId, room.code);
    return { ok: true, room };
  }

  getPublicState(room) {
    return publicState(room);
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (now - room.lastActivity > ROOM_TTL_MS) {
        for (const player of room.players) {
          this.socketToRoom.delete(player.id);
        }
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = RoomManager;
