# Laggagames

Party-/Dub-Studio auf Basis der Choicer-Voicer-Architektur: Voicepacks hochladen, solo oder Multiplayer dubben, Takes exportieren.

## Stack

- **Node.js + Express + Socket.io**
- **Frontend:** statische HTML/JS-Seiten (`public/`)
- **Packs:** Choicer-Voicer-kompatibles ZIP-Format, optional Object Storage (R2 / Railway Bucket)
- **Deploy:** Railway (`railway.toml` + `nixpacks.toml` mit ffmpeg)

## Struktur

```
server/          Express-API, Socket.io, Pack-Loader, R2, Rooms
public/          Dashboard, Host-Studio, Play-Controller
assets/packs/    Bundled Voicepacks (optional)
assets/clips/    Demo-Audio
data/            Runtime-Packs + Meta (gitignored außer Platzhalter)
```

## Lokal starten

```bash
npm install
npm start
```

- Dashboard: http://localhost:3000  
- Host-Studio: http://localhost:3000/host.html  
- Controller: http://localhost:3000/play.html  

## Env

Siehe `.env.example` (Port, R2/Bucket-Credentials, Upload-Limits).

## Voicepack-Format

Ordner unter `assets/packs/<pack-id>/` bzw. Upload-ZIP:

| Datei | Bedeutung |
|-------|-----------|
| `_pack_info.ini` | Titel, Icon |
| `dub_video.ogv` / `.mp4` | Sync-Video |
| `_backing_track.mp3` | Musik ohne Dialog |
| `NN_Character.txt` | Caption, Timestamp, Charakter |
| `NN_Character.mp3` | Original-Referenz |
| `NN_Character.png` | Szenenbild |

Fan-Packs mit urheberrechtlich geschütztem Material nur privat nutzen — nicht committen.
