async function loadGames() {
  const grid = document.getElementById('gameGrid');
  try {
    const res = await fetch('/api/games');
    const data = await res.json();
    const games = data.games || [];
    if (!games.length) {
      grid.innerHTML =
        '<p class="muted">Noch keine Spiele. Lege einen Ordner unter <code>games/&lt;slug&gt;/</code> an (siehe Template).</p>';
      return;
    }
    grid.innerHTML = games
      .map((g, i) => {
        const status = g.status || 'wip';
        const ready = status === 'playable' || status === 'ready' || status === 'live';
        const badgeClass = ready ? 'badge' : 'badge wip';
        const href = `/g/${g.slug}/`;
        return `<a class="card" href="${href}" style="animation-delay:${0.05 * i}s">
          <h2>${escapeHtml(g.name || g.slug)}</h2>
          <p>${escapeHtml(g.tagline || g.description || '')}</p>
          <div class="meta">
            <span class="${badgeClass}">${escapeHtml(status)}</span>
            <span class="cta">Öffnen →</span>
          </div>
        </a>`;
      })
      .join('');
  } catch (e) {
    grid.innerHTML = `<p class="muted">Katalog konnte nicht geladen werden: ${escapeHtml(e.message || e)}</p>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

loadGames();
