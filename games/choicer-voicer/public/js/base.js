/**
 * Game mount prefix. Standalone: "". Under hub: "/g/choicer-voicer".
 * Also patches absolute /api and same-origin page navigations when mounted.
 */
(function (global) {
  const pathName = global.location?.pathname || "";
  const match = pathName.match(/^(\/g\/[^/]+)/);
  const GB = match ? match[1] : "";
  global.GB = GB;
  global.gameUrl = function gameUrl(p) {
    const pathPart = String(p || "").startsWith("/") ? String(p) : `/${p}`;
    return `${GB}${pathPart}`;
  };

  /** Prefix absolute in-game media paths (/packs/...) when mounted under /g/<slug>/. */
  global.assetUrl = function assetUrl(u) {
    if (!u || typeof u !== "string") return u;
    if (/^(https?:|blob:|data:)/i.test(u)) return u;
    if (!GB) return u;
    if (u === GB || u.startsWith(`${GB}/`)) return u;
    if (u.startsWith("/")) return GB + u;
    return u;
  };

  if (!GB) return;

  const origFetch = global.fetch.bind(global);
  global.fetch = function (input, init) {
    if (typeof input === "string" && input.startsWith("/")) {
      input = GB + input;
    } else if (input && typeof input.url === "string" && input.url.startsWith(global.location.origin + "/")) {
      // Request object — leave as-is unless same-origin absolute path needed
    }
    return origFetch(input, init);
  };

  const origOpen = global.XMLHttpRequest.prototype.open;
  global.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string" && url.startsWith("/")) url = GB + url;
    return origOpen.call(this, method, url, ...rest);
  };

  // Rewrite absolute in-game links (/play.html, /api/...) to stay under /g/<slug>/.
  // Do NOT rewrite hub exits: "/" and "/#..." must leave the game for Lagga Club.
  global.document?.addEventListener("click", (ev) => {
    const a = ev.target?.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    if (href.startsWith("/g/")) return;
    if (href === "/" || href.startsWith("/#") || href.startsWith("/?")) return;
    if (a.hasAttribute("data-hub-exit")) return;
    ev.preventDefault();
    global.location.href = GB + href;
  });
})(window);
