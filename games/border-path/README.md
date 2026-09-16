# Border Path

Travle-ähnliches Geografie-Rätsel: Von einem Startland zum Zielland über **Landgrenzen** tippen. Start und Ziel nur als Umrandung; andere Länder bleiben verborgen, bis sie geraten oder als Hinweis erscheinen (falsch = rot). Vektor-Weltkarte mit Pan/Zoom (Drag, Mausrad, Pinch).

## Spielen

- Hub: `/g/border-path/`
- Solo: Schwierigkeit wählen → raten
- Namen auf **Deutsch oder Englisch**
- **Leicht / Mittel / Schwer** steuern Weglänge und Guess-Budget
- **3 Hinweise** (aufsteigend): Initiale → Namenslänge → gestrichelte Umrandung

## Regeln

- Gewinn, wenn Start und Ziel über geratene Länder verbunden sind
- Guess-Budget = kürzester Pfad + Extra je Stufe
- Grün verkürzt die Reststrecke, Orange ist nah, Rot ist Umweg
- Perfect: kürzester Pfad in Reihenfolge vom Start
- Hinweis-Länder werden nach korrektm Tipp normal (grün/orange/rot) eingefärbt — keine gestrichelte Hint-Darstellung mehr

## Party / Versus

`"partySupport": true` — Launch aus der Hub-Lobby:

`/g/border-path/?party=<partyId>&name=<displayName>&member=<memberId>`

Versus-Hybrid über **3 Runden** mit gemeinsamem Puzzle je Runde:

- **4 Hinweise** fürs ganze Match (Pool) — aufsparen oder in einer Runde mehrere Stufen nehmen
- Ranking nach **Punkten** (Summe über Runden); bei Gleichstand **Gesamtzeit**
- Host startet; nach jeder Runde kurzer Zwischenstand, dann nächste Route

## Daten

- `assets/geo/world.geojson` — vereinfachte Länderpolygone (Natural Earth 50m)
- `assets/geo/adjacency.json` — Nachbargraph (+ manuelle Brücken)
- `assets/geo/aliases.json` — DE/EN-Aliase
- Rebuild: `node tools/build-geo.js`
- Checks: `node tools/verify.js`
