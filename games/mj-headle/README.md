# MJ Headle

Heardle-Style: Michael-Jackson-Songs am Intro erraten. Solo oder über die zentrale Lagga-Party.

## Clip-Stufen & Punkte

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
