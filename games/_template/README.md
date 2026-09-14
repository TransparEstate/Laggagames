# Neues Spiel (Template)

1. Ordner kopieren: `games/_template` → `games/<slug>/`
2. `game.json` anpassen (`id` = Ordnername)
3. Server + Frontend hier entwickeln
4. In Chat sagen: **„Wir arbeiten an `<slug>`“** — Agent liest nur `games/<slug>/` (siehe Root-`AGENTS.md`)

## Party-Vertrag (optional)

Setze `"partySupport": true` in `game.json`, damit das Spiel in der Hub-Lobby startbar ist.

**Launch-URL:** `/g/<slug>/?party=<partyId>&name=<displayName>&member=<memberId>`

Erwartung:

1. Bei `party`-Query: Multiplayer-Session an `partyId` hängen (keine eigenen Room-Codes).
2. Party-Mitglieder vom Hub laden (`GET /api/party/:id` mit `x-party-token`).
3. Solo-UI ausblenden/blockieren, solange Party-Kontext aktiv ist.
4. Exit → Redirect auf `/` (Hub). Optional `POST /api/party/:id/return` — Party bleibt bestehen.

Env (vom Hub an Game-Child): `HUB_INTERNAL_URL`, `PARTY_INTERNAL_TOKEN`.
