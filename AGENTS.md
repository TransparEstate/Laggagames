# Laggagames – Hinweise für Agents

## Produkt

Multimodale Gamesite mit **eigenen Spielen**. Spiele laufen **solo** oder im **synchronisierten Multiplayer** (miteinander und/oder gegeneinander).

Aktueller Code (Branch mit App): Node.js + Express + Socket.io, statisches Frontend unter `public/`, Voicepack-/Room-Logik unter `server/`. Das ist ein Scaffold (Choicer-Voicer-Port), **kein Freifahrtschein für einen Rewrite**.

## Harte Regeln

1. **Nicht neu bauen.** Kein neues Framework, kein „sauberer Neustart“, kein Ersetzen von Express/Vanilla-JS/Socket.io ohne ausdrücklichen Auftrag.
2. **Nicht anlügen.** Unsicherheiten, fehlende Dateien, fehlgeschlagene Checks und Scope-Grenzen klar sagen. Nicht behaupten, etwas sei getestet/fertig, wenn es nicht ist.
3. **Code nur gezielt lesen.** Nicht die gesamte Codebasis durchsuchen oder „einmal alles anschauen“.
   - Primär: Dateien **des aktuellen Spiels** / der aktuellen Aufgabe.
   - Zusätzlich nur bei Bedarf: **Multiplayer-/Sync-/Room-relevante** Stellen (`server/roomManager.js`, `server/gameLogic.js`, `public/js/sync-client.js` / `socket-client.js` o. Ä.).
   - Dashboard, Pack-Upload, R2, Export, Deploy-Configs usw. **nur**, wenn die Aufgabe das explizit braucht.
4. **Kein Browser-Durchklicken und keine Screenshots**, außer der Nutzer fordert das ausdrücklich an. Fertig = Terminal-Checks (Start, gezielte Tests, Logs, API/Socket-Verhalten). Computer-Use/E2E im Browser ist standardmäßig **verboten**.
5. **Kleine, fokussierte Änderungen.** Ein Ziel pro Lauf. Bestehende Strukturen erweitern statt parallele Systeme zu erfinden.
6. **Keine Pushs und keine Pull Requests.** Agents sollen nicht von sich aus pushen oder PRs öffnen.
7. **Nur sinnvoll benannte Branches** anlegen — keine kryptischen/wirren Auto-Namen. Schema in der Art:
   - `v3.1-Update-Michael-Jackson-Spiel`
   - `v2-Sync-Multiplayer-Lobby`
   - `v1-Neues-Kartenspiel`
   - Also: **Version/Kurzkennung + klarer Inhalt**, Bindestriche statt Zufalls-Hashes (`v6foo-190f`, `cursor-agent-…`, UUID-Fragmente usw. sind verboten).
8. **Kein Branch „einfach so“.** Nur anlegen, wenn die Aufgabe das braucht; Name so wählen, dass ein Mensch sofort versteht, worum es geht.

## Nicht-Ziele (vorerst)

- Rewrite auf React/Next/andere Stacks
- Accounts, Payments, Store, generische CMS-Features
- Fremde/IP-belastete Packs committen oder öffentlich machen
- Große Game-Engine-Abstraktion, bevor ein zweites Spiel und klare Sync-Verträge stehen
- Prod-Deploys oder Secrets ins Repo
- Push/PR von Agents aus; kryptisch oder zufällig benannte Branches

## Stack (beibehalten)

- **Backend:** Node.js, Express, Socket.io (`server/`)
- **Frontend:** statisches HTML/JS (`public/`)
- **Packs/Media:** ZIP-Voicepacks, optional Object Storage (R2)
- **Start lokal:** `npm install` bzw. `npm ci`, dann `npm start` (Port 3000)

## Wann ist etwas „fertig“?

- Aufgabe erfüllt, ohne Scope zu sprengen
- Relevante Checks im Terminal (nicht Browser), wo sinnvoll
- Kurzer, ehrlicher Status: was geändert wurde, was bewusst **nicht** angefasst wurde, was offen bleibt
