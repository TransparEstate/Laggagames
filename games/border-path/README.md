# Border Path

Travle-ähnliches Geografie-Rätsel: Von einem Startland zum Zielland über **Landgrenzen** tippen. Start und Ziel sind nur als Umrandung sichtbar; geratene Länder erscheinen auf der Karte (falsch = rot).

## Spielen

- Hub: `/g/border-path/`
- Solo: Schwierigkeit wählen → raten
- Namen auf **Deutsch oder Englisch**
- **Leicht / Mittel / Schwer** steuern Weglänge, Guess-Budget und Hinweise

## Regeln

- Gewinn, wenn Start und Ziel über geratene Länder verbunden sind
- Guess-Budget = kürzester Pfad + Extra je Stufe
- Grün verkürzt die Reststrecke, Orange ist nah, Rot ist Umweg
- Perfect: kürzester Pfad in Reihenfolge vom Start

## Party

`"partySupport": true` — Launch aus der Hub-Lobby:

`/g/border-path/?party=<partyId>&name=<displayName>&member=<memberId>`

v1: Solo-Spiel nach Launch; Return zur Hub-Party. Kein Sync-Rennen.

## Daten

- `data/world.geojson` — vereinfachte Länderpolygone
- `data/adjacency.json` — Nachbargraph (+ manuelle Brücken)
- `data/aliases.json` — DE/EN-Aliase
- Rebuild: `node tools/build-geo.js`
- Checks: `node tools/verify.js`
