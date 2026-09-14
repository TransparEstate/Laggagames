# Choicer Voicer

Dub-Studio: Voicepacks hochladen, solo oder Multiplayer dubben, Takes exportieren.

**Slug:** `choicer-voicer`  
**Mount:** `/g/choicer-voicer/`

## Pack-Speicher

Alle Voicepacks liegen **ausschließlich in Cloudflare R2** (Bucket z.B. `choicer-voicer-packs`).

- Jeder Upload ist für alle Nutzer sichtbar.
- Identische Packs werden per Content-Hash dedupliziert (kein zweites Exemplar).
- Lokal/Railway speichern Packs nicht dauerhaft — nur ephemeres Staging beim Upload.
- Beim Start lädt der Server vorhandene R2-Manifeste; der Katalog ist also nicht leer, wenn bereits Packs in Cloudflare liegen.

Benötigte Env-Vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (siehe `.env.example`).

## Agent-Hinweis

Bei Arbeit an diesem Spiel **nur** Dateien unter `games/choicer-voicer/` anfassen. Siehe Root-`AGENTS.md`.
