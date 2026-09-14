# MJ Headle

Heardle-Style: Michael-Jackson-Songs am Intro erraten. Solo oder über die zentrale Lagga-Party.

## Songs einfach nach Cloudflare hochladen

1. Bucket öffnen:  
   https://dash.cloudflare.com/?to=/:account/r2/default/buckets/lagga-mj-headle
2. Ordner/Prefix **`audio/`** anlegen (oder beim Upload den Pfad `audio/` setzen)
3. In Windows alle MP3s markieren → per Drag&Drop in den Bucket / Upload
4. Dateinamen dürfen so bleiben wie sie sind (`Smooth Criminal (2012 Remaster).mp3` ist ok)
5. Im Spiel / Server: Katalog neu laden (`POST /api/catalog/sync` oder Server neu starten)

Der Server liest danach alle Dateien unter `audio/`, räumt Titel auf und wirft Duplikate weg.  
Cue kannst du später setzen (`--cues` / find-cue) — ohne Cue sind Songs noch nicht spielbar, aber schon in der Suchleiste sichtbar.

R2-Zugangsdaten in `.env` (`MJ_R2_*`) müssen gesetzt sein, sonst sieht der Server den Bucket nicht.


Deine Dateien heißen schon richtig (z. B. `Smooth Criminal (2012 Remaster).mp3`).  
**Auf deinem PC** (Ordner mit den ~140 MP3s):

```bash
cd games/mj-headle
node tools/prep-library.js --in "C:/Users/DU/Music/MJ" --cues
```

Das Skript:
1. entfernt Remaster/Radio-Edit/Demo/… aus dem Titel  
2. wirft Duplikate raus (z. B. 3× Smooth Criminal → 1 Remaster behalten)  
3. kopiert nach `data/audio/<slug>.mp3`  
4. schreibt `catalog/songs.json`  
5. mit `--cues` setzt es automatisch den Hör-Start (Cue)

Nur anschauen ohne Kopieren:

```bash
node tools/prep-library.js --in "C:/Users/DU/Music/MJ" --dry-run
```

Danach optional nach R2 hochladen (`audio/<slug>.mp3`) — oder lokal mit `data/audio` spielen.

## Rate-Suche

Im Spiel gibt es eine **Suchleiste** über den kompletten Katalog (alle MJ-Titel aus `songs.json`). Tippen filtert live; Pfeiltasten + Enter wählen einen Treffer.


| Stufe | Dauer | Punkte |
|------|------:|-------:|
| 1 | 0,1s | 100 |
| 2 | 0,5s | 80 |
| 3 | 1s | 60 |
| 4 | 5s | 40 |
| 5 | 13s | 20 |
| Reveal | — | 0 |

Alle Stufen starten am **Cue-Point** (`cueStartSec`) — nicht blind am Dateianfang. Ohne gültigen Cue (`ok` oder `manual`) ist ein Song nicht spielbar.

## Party

`"partySupport": true` — Launch aus der Hub-Lobby:

`/g/mj-headle/?party=<partyId>&name=<name>&member=<memberId>`

Kein eigenes Join-Code-System.

## Audio hochladen (Cloudflare R2)

Bucket: **`lagga-mj-headle`** (bereits angelegt).

### Key-Schema

- `catalog/songs.json` — Manifest
- `audio/<song-id>.mp3` (auch `.m4a` / `.ogg` / `.wav`)

### Env (in `games/mj-headle/.env`)

```bash
MJ_R2_ACCOUNT_ID=
MJ_R2_ACCESS_KEY_ID=
MJ_R2_SECRET_ACCESS_KEY=
MJ_R2_BUCKET=lagga-mj-headle
# optional:
# MJ_R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
# MJ_R2_PUBLIC_BASE_URL=
```

### Upload

1. Cloudflare Dashboard → R2 → `lagga-mj-headle` → Upload nach `audio/<id>.mp3`
2. oder CLI:

```bash
npx wrangler r2 object put lagga-mj-headle/audio/billie-jean.mp3 --file ./billie-jean.mp3
```

3. Cue finden und prüfen:

```bash
node tools/find-cue.js ./billie-jean.mp3 --apply billie-jean
```

4. Katalog aktualisieren (`catalog/songs.json` oder R2 `catalog/songs.json`) mit:

```json
{
  "id": "billie-jean",
  "title": "Billie Jean",
  "artist": "Michael Jackson",
  "audioKey": "audio/billie-jean.mp3",
  "cueStartSec": 0.42,
  "cueQuality": "ok"
}
```

### Lokaler Fallback (ohne R2)

Lege Dateien unter `data/audio/<id>.mp3` ab (gitignored). Cue-Overrides: `data/cue-overrides.json`.

### Preview / manueller Override

- `GET /api/songs/:id/preview?dur=0.1`
- `POST /api/songs/:id/cue` mit `{ "cueStartSec": 1.23 }`
- `POST /api/songs/:id/analyze-cue` mit `{ "apply": true }`

## Start

```bash
# Solo-Dev
npm run game -- mj-headle

# oder über Hub
npm start
# → http://localhost:3000/g/mj-headle/
```

## Cue-Tests

```bash
node tools/test-cue.js
```
