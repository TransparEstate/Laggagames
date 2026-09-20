# Flag Rush

Flaggen-Quiz: Flagge sehen, Ländernnamen tippen (Deutsch oder Englisch). Solo oder Party-Race über die zentrale Lagga-Party.

**Slug:** `flag-rush`  
**Mount:** `/g/flag-rush/`

## Spielen

- Hub: `/g/flag-rush/`
- Solo: Schwierigkeit + Rundenzahl wählen → tippen
- Party: Launch aus der Hub-Lobby  
  `/g/flag-rush/?party=<partyId>&name=<displayName>&member=<memberId>`

## Regeln

- Pro Runde eine Flagge; Antwort per Freitext (Autocomplete)
- Party-Race: Punkte nach Tempo (100 → 10 in 20 s), erster korrekter Tipp +25 Bonus
- Schwierigkeit filtert den Länderpool: Leicht / Mittel / Schwer
- Host startet; nach allen Runden Scoreboard

## Daten

- `assets/countries.json` — ISO2, DE/EN-Namen, Aliase, Difficulty
- Flaggen per CDN: `https://flagcdn.com/w320/{iso}.png`

## Agent-Hinweis

Nur Dateien unter `games/flag-rush/` anfassen. Siehe Root-`AGENTS.md`.
