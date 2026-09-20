(function () {
  let ctx;
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  function beep(freq, dur, type, gain) {
    const ac = ensure();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    g.gain.value = gain ?? 0.04;
    o.connect(g);
    g.connect(ac.destination);
    const t = ac.currentTime;
    g.gain.setValueAtTime(gain ?? 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t);
    o.stop(t + dur);
  }

  const map = {
    draw() {
      beep(220, 0.08, 'sawtooth', 0.05);
      setTimeout(() => beep(330, 0.1, 'square', 0.04), 90);
      setTimeout(() => beep(440, 0.12, 'square', 0.035), 180);
    },
    lock() {
      beep(160, 0.15, 'triangle', 0.05);
      setTimeout(() => beep(120, 0.2, 'triangle', 0.04), 100);
    },
    reveal() {
      beep(523, 0.1, 'square', 0.045);
      setTimeout(() => beep(659, 0.1, 'square', 0.04), 110);
      setTimeout(() => beep(784, 0.18, 'square', 0.035), 220);
    },
    guess() {
      beep(300, 0.08, 'sawtooth', 0.04);
      setTimeout(() => beep(250, 0.12, 'sawtooth', 0.035), 100);
    },
    correct() {
      beep(523, 0.08, 'square', 0.05);
      setTimeout(() => beep(784, 0.16, 'square', 0.045), 90);
    },
    wrong() {
      beep(180, 0.2, 'sawtooth', 0.05);
      setTimeout(() => beep(140, 0.25, 'sawtooth', 0.04), 120);
    },
    vote() {
      beep(440, 0.07, 'triangle', 0.04);
      setTimeout(() => beep(550, 0.1, 'triangle', 0.035), 80);
    },
    score() {
      beep(392, 0.1, 'square', 0.04);
      setTimeout(() => beep(494, 0.1, 'square', 0.035), 100);
      setTimeout(() => beep(587, 0.2, 'square', 0.03), 200);
    },
  };

  window.FlagSfx = {
    play(id) {
      try {
        (map[id] || map.guess)();
      } catch (_) {
        /* ignore */
      }
    },
    unlock() {
      ensure();
    },
  };
})();
