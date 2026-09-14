# Lagga Club

Hub für **eigene Party-Spiele**. Jedes Spiel lebt isoliert unter `games/<slug>/`.

## Start

```bash
npm install
npm start
```

- Hub: http://localhost:3000  
- Choicer Voicer: http://localhost:3000/g/choicer-voicer/  

Ein Spiel allein:

```bash
npm run game -- choicer-voicer
```

## Struktur

```
hub/                 Spiele-Katalog (UI)
server/              Hub-Server + Proxy /g/<slug>/
games/
  choicer-voicer/    Erstes Spiel (Dub-Studio)
  _template/         Vorlage für neue Spiele
AGENTS.md            Scope-Regeln für Agents (Tokens sparen)
```

## Neues Spiel

1. `games/_template` → `games/<slug>` kopieren  
2. `game.json` anpassen  
3. Im Chat sagen: „Wir arbeiten an `<slug>`“ — dann wird nur dieser Ordner angefasst  

Details: [`AGENTS.md`](./AGENTS.md)
