# Laggagames – Hinweise für Agents

## Produkt

Multimodale Gamesite mit **eigenen Spielen**. Spiele laufen **solo** oder im **synchronisierten Multiplayer** (miteinander und/oder gegeneinander).

Architektur: **Hub + isolierte Spiele** unter `games/<slug>/` (kein Monolith). Aktueller Stack: Node.js + Express + Socket.io, Vanilla-Frontend. Scaffold (Choicer-Voicer-Port unter `games/choicer-voicer/`) — **kein Freifahrtschein für einen Rewrite**.

## Zentrales Lobby-/Party-System (verbindlich)

Es gibt **ein zentrales Lobby-/Party-System** (Rooms, Join-Codes, Host, Spielerliste, Ready/Start, Socket-Sync). Das ist die gemeinsame Multiplayer-Schicht für **alle** Spiele.

- **Jedes neue Spiel muss daran angebunden werden** — kein eigenes paralleles Lobby-, Room-, Party- oder Matchmaking-System erfinden.
- Spielspezifische Regeln, UI und Assets gehören **ins jeweilige** `games/<slug>/`. Lobby, Codes, Host-Rechte, Ready/Start und Session-Sync bleiben die gemeinsame Party-Basis (nicht pro Spiel neu erfinden).
- Solo darf vereinfachen, soll aber dieselbe Party-/Room-Idee nutzen oder klar davon ableiten — kein zweites Beitrittsmodell.
- Wenn Lobby/Party-Code noch nicht sauber als Shared-Modul extrahiert ist: bestehende Room-/Lobby-Pfade (z. B. in `games/choicer-voicer/`) als Referenz nehmen und für neue Spiele **wiederverwenden/anbinden**, nicht kopieren und divergieren lassen, solange der User nichts anderes sagt.

## Ordnerstruktur (verbindlich)

```
hub/                  # Nur die Spiele-Übersichtsseite (Landing)
server/               # Nur Hub-Server: Katalog, Proxy zu /g/<slug>/
games/
  _template/          # Vorlage für neue Spiele
  <slug>/             # EIN Spiel = EIN Ordner (komplett isoliert)
    game.json         # Name, Status, Entry — Pflicht
    server/           # Backend dieses Spiels
    public/           # Frontend dieses Spiels
    assets/           # Bundled Assets dieses Spiels
    data/             # Runtime-Daten dieses Spiels (meist gitignored)
    README.md         # Kurzbeschreibung / Regeln des Spiels
AGENTS.md             # Diese Datei
```

Root-Dateien (`package.json`, Deploy-Configs, …) gehören zur Plattform, nicht zu einem einzelnen Spiel.

## Aktives Spiel (wichtigste Scope-Regel)

Wenn der User sagt, an welchem Spiel gearbeitet wird — z. B. „wir arbeiten an **choicer-voicer**“ / „fix **pow-karaoke**“ / „im Spiel `xyz` …“ — dann gilt:

1. **Nur** `games/<slug>/` lesen, suchen, editieren, testen.
2. **Nicht** andere Ordner unter `games/` öffnen oder refaktorieren.
3. **Nicht** den Hub anfassen, außer der User verlangt Hub-/Plattform-Änderungen ausdrücklich.
4. Shared/Root (`server/`, `hub/`, Root-Configs) nur ändern, wenn für dieses Spiel **unvermeidbar** (meist reicht `game.json` — Hub liest dynamisch) **oder** wenn die zentrale Lobby/Party angebunden/geteilt werden muss.
5. Vor großen Explorationen: zuerst `games/<slug>/game.json` + `README.md`, dann gezielt Dateien öffnen.

Ziel: **Tokens und Zeit sparen** — kein Repo-weites Durchsuchen, wenn ein Spiel genannt ist.

### Wenn kein Spiel genannt ist

- Kurze Rückfrage: „Welches Spiel (`games/<slug>`)?“
- Oder nur Hub/Plattform, wenn die Anfrage klar plattformbezogen ist.

### Neues Spiel anlegen

1. `games/_template/` → `games/<slug>/` kopieren.
2. `game.json` setzen (`id` / `name` / `status` / `entry`).
3. **Zentrales Lobby-/Party-System mit anbinden** (Join-Code, Host, Ready/Start, Sync) — kein eigenes Party-System.
4. Danach wieder: nur in diesem Ordner arbeiten (plus unvermeidbare Shared-Lobby-Anbindung).

## Harte Regeln

1. **Nicht neu bauen.** Kein neues Framework, kein „sauberer Neustart“, kein Ersetzen von Express/Vanilla-JS/Socket.io ohne ausdrücklichen Auftrag.
2. **Nicht anlügen.** Unsicherheiten, fehlende Dateien, fehlgeschlagene Checks und Scope-Grenzen klar sagen. Nicht behaupten, etwas sei getestet/fertig, wenn es nicht ist.
3. **Code nur gezielt lesen.** Nicht die gesamte Codebasis durchsuchen oder „einmal alles anschauen“.
   - Primär: Dateien **des aktuellen Spiels** unter `games/<slug>/`.
   - Zusätzlich nur bei Bedarf: **Lobby-/Party-/Multiplayer-/Sync-Stellen** (Shared oder Referenz im bestehenden Spiel).
   - Hub, Pack-Upload, R2, Export, Deploy-Configs usw. **nur**, wenn die Aufgabe das explizit braucht.
4. **Kein Browser-Durchklicken und keine Screenshots**, außer der Nutzer fordert das ausdrücklich an. Fertig = Terminal-Checks (Start, gezielte Tests, Logs, API/Socket-Verhalten). Computer-Use/E2E im Browser ist standardmäßig **verboten**.
5. **Kleine, fokussierte Änderungen.** Ein Ziel pro Lauf. Bestehende Strukturen erweitern statt parallele Systeme zu erfinden.
6. **Keine Pushs und keine Pull Requests** von Agents aus, außer der User / die Plattform-Aufgabe fordert das ausdrücklich.
7. **Nur sinnvoll benannte Branches** — keine kryptischen Auto-Namen. Schema z. B.:
   - `v3.1-Update-Michael-Jackson-Spiel`
   - `v2-Sync-Multiplayer-Lobby`
   - `v1-Neues-Kartenspiel`
8. **Kein Branch „einfach so“.** Nur anlegen, wenn die Aufgabe das braucht.

## Nicht-Ziele (vorerst)

- Rewrite auf React/Next/andere Stacks
- Eigenes Lobby/Party/Matchmaking **pro Spiel** (statt dem zentralen System)
- Accounts, Payments, Store, generische CMS-Features
- Fremde/IP-belastete Packs committen oder öffentlich machen
- Große Game-Engine-Abstraktion, bevor ein zweites Spiel und klare Sync-Verträge stehen
- Prod-Deploys oder Secrets ins Repo
- Kryptisch oder zufällig benannte Branches; Push/PR von Agents aus ohne Auftrag

## Stack (beibehalten)

- **Hub:** Express (`server/`), Landing (`hub/public/`)
- **Pro Spiel:** Express + Socket.io (`games/<slug>/server/`), statisches HTML/JS (`games/<slug>/public/`)
- **Multiplayer:** zentrales Lobby-/Party-/Room-System — für jedes neue Spiel mitanbinden
- **Packs/Media:** ZIP-Voicepacks, optional Object Storage (R2)
- **Start:** `npm install` / `npm ci`, dann `npm start` (Hub :3000, Spiele unter `/g/<slug>/`)
- **Ein Spiel solo:** `npm run game -- <slug>`

## Wann ist etwas „fertig“?

- Aufgabe erfüllt, ohne Scope zu sprengen
- Neue Spiele sind an das **zentrale Lobby-/Party-System** angebunden (kein paralleles Beitrittsmodell)
- Relevante Checks im Terminal (nicht Browser), wo sinnvoll — und nur wenn der User Tests nicht untersagt
- Kurzer, ehrlicher Status: was geändert wurde, was bewusst **nicht** angefasst wurde, was offen bleibt
