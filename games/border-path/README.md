# Border Path

Travle-ähnliches Geografie-Rätsel: Von einem Startland zum Zielland über **Landgrenzen** tippen. Start und Ziel sind hervorgehoben; alle Ländergrenzen bleiben als Vektor-Umrisse sichtbar; geratene Länder erscheinen gefüllt (falsch = rot). Die Karte lässt sich per Drag, Mausrad und Pinch zoomen/verschieben.

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

- `assets/geo/world.geojson` — vereinfachte Länderpolygone (Natural Earth 50m)
- `assets/geo/adjacency.json` — Nachbargraph (+ manuelle Brücken)
- `assets/geo/aliases.json` — DE/EN-Aliase
- Rebuild: `node tools/build-geo.js`
- Checks: `node tools/verify.js`
