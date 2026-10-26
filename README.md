# TV Web Remote – Samsung GQ75QN900ATXZG

Web-Interface für den Samsung QN900A (Tizen, 2021). Läuft lokal, ohne Cloud.

Voraussetzung: Node.js 18 oder neuer, Fernseher im selben Netz.

```bash
npm install
cp config.example.json config.json   # IP und MAC des Fernsehers eintragen
npm start                            # http://localhost:8097
```

Einstellungen in `config.json` (IP, MAC für Wake-on-LAN, Port, optional SmartThings, `extraApps`).
IP und MAC zeigt der Fernseher unter Einstellungen › Allgemein › Netzwerk › Netzwerkstatus › IP-Einstellungen.
Beim ersten Start fragt der Fernseher einmal nach Freigabe; der Kopplungs-Token landet in `data/token.json`.
`config.json` und `data/` sind per `.gitignore` vom Repo ausgeschlossen.

## Schnittstellen

| Funktion | Weg |
|---|---|
| Alle Fernbedienungstasten, Text, Touchpad, Browser | WebSocket `wss://TV:8002` (Token-Kopplung) |
| Status, Apps prüfen/starten/schließen | REST `http://TV:8001/api/v2` |
| Lautstärke-Regler, Stumm, Medien per URL abspielen | DLNA/UPnP `http://TV:9197` |
| Einschalten aus dem Standby | `KEY_POWER`, sonst Wake-on-LAN (unter WSL zusätzlich über Windows) |
| Bildmodus, Tonmodus, Quellenliste, Sender direkt | optional SmartThings-API (`smartthings.token` in `config.json`) |

Die Firmware beantwortet die App-Listen-Abfrage nicht mehr. Deshalb werden die IDs aus
`server/apps-catalog.js` einzeln geprüft. Weitere App-IDs kommen in `config.json` unter `"extraApps": ["…"]`.
