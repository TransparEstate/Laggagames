# Flag Sketch

Blindhälften mit **Text-Brief** (kein Flaggenbild), Composite-Naht, Lookalike-Raten, Tonfallen (Roast-Zeilen + Audio-Stinger).

## Spielen

- Hub: `/g/flag-sketch/`
- Solo: Name → Settings → Match starten
- Party: Launch aus Hub-Lobby (`partySupport: true`)

## Ablauf

1. Host: Runden (Default 3), Zeichenzeit (~60s), optionale Hinweise
2. Pro Runde: Paare, jeder bekommt nur L- oder R-**Brief**
3. Zeichnen → Lock → Naht-Reveal + Roast
4. Lookalike-MC auf **fremde** Mashups (bei 2 Spielern: eigenes Mashup erlaubt)
5. Vote: Chaos / Fast richtig / Kunst
6. Wahrheit + Score → nächste Runde

## Daten

- `data/flags.json` — Briefe, Meta, Lookalike-Cluster
- `data/roasts.json` — Tonfallen-Copy

## Checks

```bash
npm run game -- flag-sketch
# curl localhost:<port>/health
node games/flag-sketch/tools/smoke.js
```
