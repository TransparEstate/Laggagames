(function (global) {
  function createSyncController(video, options = {}) {
    const onCue = options.onCue || (() => {});
    const getScenes = options.getScenes || (() => []);
    const getMyCharacters = options.getMyCharacters || (() => []);
    let applying = false;
    let lastCueId = null;
    let cueTimer = null;

    function estimatedTime(sync) {
      if (!sync) return 0;
      if (!sync.playing) return sync.mediaTime || 0;
      const drift = (Date.now() - (sync.updatedAt || Date.now())) / 1000;
      return (sync.mediaTime || 0) + Math.max(0, drift);
    }

    async function applySync(sync) {
      if (!video || !sync || applying) return;
      applying = true;
      try {
        const target = estimatedTime(sync);
        if (Math.abs((video.currentTime || 0) - target) > 0.35) {
          try {
            video.currentTime = target;
          } catch (_) {}
        }
        video.muted = options.muted !== false;
        if (sync.playing) {
          try {
            await video.play();
          } catch (_) {}
        } else {
          video.pause();
        }
      } finally {
        applying = false;
      }
    }

    function watchCues() {
      if (cueTimer) return;
      cueTimer = setInterval(() => {
        if (!video || video.paused) return;
        const t = video.currentTime || 0;
        const mine = new Set(getMyCharacters());
        const scenes = getScenes() || [];
        const upcoming = scenes.find(
          (s) =>
            mine.has(s.character) &&
            t >= s.timestamp - 0.6 &&
            t <= (s.endTimestamp || s.timestamp + 3) + 0.2
        );
        if (upcoming && upcoming.id !== lastCueId) {
          lastCueId = upcoming.id;
          onCue(upcoming, t);
        }
        if (!upcoming) {
          // allow re-trigger later
          const still = scenes.find(
            (s) => mine.has(s.character) && t >= s.timestamp - 0.6 && t <= (s.endTimestamp || s.timestamp + 3)
          );
          if (!still) lastCueId = null;
        }
      }, 120);
    }

    function stopWatch() {
      if (cueTimer) {
        clearInterval(cueTimer);
        cueTimer = null;
      }
    }

    function bindMedia(url) {
      if (!video || !url) return;
      if (video.dataset.src === url) return;
      video.dataset.src = url;
      video.src = url;
      video.preload = 'auto';
      video.playsInline = true;
    }

    watchCues();

    return {
      applySync,
      estimatedTime,
      bindMedia,
      stopWatch,
      resetCue() {
        lastCueId = null;
      },
    };
  }

  global.CVSync = { createSyncController };
})(window);
