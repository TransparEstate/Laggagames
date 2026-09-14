(function (global) {
  function createSocket() {
    const GB = window.GB || '';
    return io({
      path: GB ? `${GB}/socket.io` : '/socket.io',
      transports: ['websocket', 'polling'],
    });
  }

  function emitAck(socket, event, payload) {
    return new Promise((resolve) => {
      socket.emit(event, payload || {}, (response) => {
        resolve(response || { error: 'Keine Antwort vom Server.' });
      });
    });
  }

  function phaseLabel(phase) {
    const map = {
      lobby: 'Lobby',
      clip: 'Original-Clip',
      recording: 'Aufnahme',
      playback: 'Playback',
      voting: 'Voting',
      results: 'Ergebnis',
      scoreboard: 'Scoreboard',
    };
    return map[phase] || phase;
  }

  function sortedPlayers(players) {
    return [...(players || [])].sort((a, b) => b.score - a.score);
  }

  function showError(el, message) {
    if (!el) return;
    if (!message) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function spawnReaction(container, emoji) {
    if (!container) return;
    const node = document.createElement('div');
    node.className = 'floating-reaction';
    node.textContent = emoji;
    node.style.left = `${20 + Math.random() * 60}%`;
    node.style.bottom = '20%';
    container.appendChild(node);
    setTimeout(() => node.remove(), 2000);
  }

  global.CV = {
    createSocket,
    emitAck,
    phaseLabel,
    sortedPlayers,
    showError,
    spawnReaction,
  };
})(window);
