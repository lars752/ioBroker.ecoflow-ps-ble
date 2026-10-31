# ioBroker.ecoflow-ps-ble

![Tests](https://github.com/lars752/ioBroker.ecoflow-ps-ble/actions/workflows/test.yml/badge.svg)

Lokale, cloudfreie Anbindung des **EcoFlow PowerStream (HW51)** per **Bluetooth LE** an ioBroker.

Der Adapter ist eine Portierung des BLE-Teils der ESP32-Firmware
[Local-MQTT-EcoFlow-PowerStream-BLE-Bridge](https://github.com/Just-Zuul/Local-MQTT-EcoFlow-PowerStream-BLE-Bridge)
(V2.6.3, © Just-Zuul 05/2026). Statt ESP32 → WLAN → MQTT → Home Assistant spricht der ioBroker-Host direkt
per Bluetooth mit dem PowerStream; die Werte landen als normale ioBroker-Datenpunkte.

> ⚠️ **Status: Erstentwurf, nicht an echter Hardware getestet.** Protokoll, Regel-Logik und Adapter-Ablauf sind
> gegen eine Simulation des PowerStream getestet (`npm test`), das Zusammenspiel mit echtem Bluetooth und einem echten
> Gerät ist offen. Nutzung auf eigenes Risiko (siehe Haftungsausschluss des Originals). Zu den Werten, die ein Wechselrichter
> ins Hausnetz einspeist, gehört gesunder Menschenverstand: Sollwert-Grenzen prüfen!

## Was übernommen wurde – und was nicht

| Übernommen (BLE-Kern) | Entfernt (ESP32/HA-spezifisch) |
|---|---|
| BLE-Verbindung, Anmeldung (AES-128-CBC, CRC8/CRC16) | WLAN-Handling, Multi-SSID, BSSID-Lock, Failover |
| Telemetrie (Protobuf-Walker, alle Sensoren + Skalierung) | WLAN-Failsafe (50 W), NTP, WebLog/Webserver |
| Sollwert, Helligkeit, Supply-Mode schreiben | MQTT-Client, MQTT-Auto-Discovery für Home Assistant |
| Write-on-Change (schont den Flash des PowerStream) | ESP-Diagnose (Heap, Uptime, Reset-Grund, WLAN-RSSI …), ESP-Neustart-Button |
| Batterie-SoC (Z-01 aus dem Original) | |

Dazu kommen: mehrere PowerStreams in **einer** Instanz, Reconnect-Schleife, Button „BLE neu verbinden“.

## Voraussetzungen

* ioBroker-Host **mit Bluetooth-Adapter in Reichweite des PowerStream** (BLE: typ. wenige Meter, Wände/Außenmontage beachten).
  Das war der Grund für den ESP32 – der konnte direkt neben dem Wechselrichter stehen. Ist der ioBroker-Host zu weit weg:
  USB-Bluetooth-Dongle an passender Stelle (z. B. über USB-Verlängerung) oder den ESP32 behalten.
* Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.
* Der PowerStream erlaubt **nur eine** BLE-Verbindung gleichzeitig: EcoFlow-App (Bluetooth) und ESP32-Bridge müssen aus sein.
* Daten: **Seriennummer** des PowerStream, **BLE-MAC** (z. B. mit der App *nRF Connect*, Gerätename beginnt mit `HW-…`),
  **EcoFlow User-ID** (z. B. über <https://gnox.github.io/user_id>).

### Linux (typisch ioBroker auf Raspberry Pi / Debian)

Der Adapter nutzt [`@abandonware/noble`](https://github.com/abandonware/noble). Laut deren Dokumentation (hier nicht geprüft):

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev build-essential
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

* In **VM/Proxmox/LXC/Docker** muss der Bluetooth-Adapter durchgereicht werden (USB-Passthrough, bei Docker u. a. `NET_ADMIN`/`NET_RAW`).
* Konkurriert ein laufender `bluetoothd` um den Adapter, hilft ggf. `sudo systemctl stop bluetooth` bzw. `hciconfig hci0 up`.
* macOS liefert keine MAC-Adressen an Anwendungen → dort funktioniert die Suche per MAC nicht.

## Installation

```bash
cd /opt/iobroker
npm install /pfad/zu/iobroker.ecoflow-ps-ble        # Ordner oder .tgz (npm pack)
iobroker upload ecoflow-ps-ble
iobroker add ecoflow-ps-ble
```

## Konfiguration

* **EcoFlow User-ID** – gilt für alle Geräte.
* **Geräte-Tabelle:** Geräte-ID (frei, z. B. `PS1`; wird Teil der Datenpunkt-IDs), Seriennummer **exakt** wie auf dem Gerät,
  BLE-MAC. Pro PowerStream eine Zeile.
* **Sollwert-Grenzen:** Min/Max (HW51: 0–800 W) und Startwert. Startwert **-1** = nach Adapterstart nichts schreiben,
  bis erstmals ein Sollwert gesetzt wird (der Original-ESP setzte nach jedem Neustart den Startwert, standardmäßig 0 W).
* Erweitert: Toleranz/Totband (5 W), Karenz fürs Nachschreiben (6 s), Messwert-Intervall (3 s), Pause zwischen Verbindungsversuchen (8 s).

Vor dem Wechsel auf eine lokale Regelung in der EcoFlow-App die **„Einspeisekontrolle“** aktivieren (Hinweis aus dem Original).

## Datenpunkte (`ecoflow-ps-ble.0.<Geräte-ID>.…`)

| Bereich | Datenpunkt | Beschreibung |
|---|---|---|
| `control` | `setWatts` (W, schreibbar) | Einspeise-Sollwert; wird begrenzt und kaufmännisch auf 5 W gerundet, der verwendete Wert kommt mit `ack=true` zurück |
| | `brightness` (%, schreibbar) | LED-Helligkeit 0–100 % (Rohwert 0–1023) |
| | `supplyMode` (0/1, schreibbar) | 0 = Prioritize power supply, 1 = Prioritize power storage |
| | `reconnect` (Button) | BLE-Verbindung trennen und neu aufbauen |
| `telemetry` | 47 Messwerte (3 davon optional) | Spannungen, Ströme, Leistungen, Temperaturen, Status-/Fehlercodes, `bat_soc`, `bat_input_watts` (± = Fluss zur/von Batterie) … |
| `info` | `link` | BLE verbunden **und** angemeldet |
| | `status`, `lastDisconnect`, `bleReconnects`, `bleRssi`, `lastUpdate` | Diagnose |
| (Instanz) | `info.connection` | mindestens ein Gerät verbunden |

Wichtige Messwerte: `permanent_watts` (Ist-Sollwert im Gerät, Feld 48), `inv_output_watts` (Inverter-Ausgang), `pv1_watts`, `pv2_watts`.

Umbenannt gegenüber den MQTT-Topics des Originals: `perm` → `permanent_watts`, `inv` → `inv_output_watts`.
Die übrigen Schlüssel (`inv_volt_in`, `pv1_watts`, `bat_input_watts` …) sind identisch. `inv_onoff` ist jetzt ein Boolean statt „ein“/„aus“.
Standardmäßig nicht angelegt (in HA „deaktiviert“): `inv_temp`, `install_ctry`, `install_town` – per Checkbox zuschaltbar.

## Verhalten

* **Write-on-Change:** `permanent_watts` liegt im Flash des PowerStream. Geschrieben wird nur bei geändertem Sollwert **oder**
  wenn der Ist-Wert um ≥ Toleranz abweicht (selbstheilend bei verschlucktem Write, gedrosselt durch die Karenzzeit). Im Ruhezustand: null Schreibvorgänge.
* **Reconnect:** Bei Abbruch wird nach der eingestellten Pause neu gesucht/verbunden; gespeicherte Helligkeit/Supply-Mode werden erneut gesetzt, der Sollwert nicht blind.
* **Kein Failsafe mehr:** Der 50-W-Failsafe des ESP galt dem *WLAN*-Ausfall und entfällt. **Bei BLE-Abbruch oder Adapter-Stopp behält der PowerStream seinen zuletzt geschriebenen Sollwert** (wie beim ESP).
* Nach `unload`/Neustart wird der konfigurierte Startwert gesetzt (oder nichts bei -1), **nicht** der zuletzt im Objekt gespeicherte Wert.

## Beispiel: Nulleinspeisung im JavaScript-Adapter

Gleiche Logik wie das HA-Beispiel des Originals (Reserve, 5-W-Raster, Totband). **IDs und Vorzeichen anpassen!**

```js
const GRID    = '0_userdata.0.netz_leistung';                 // + = Bezug, - = Einspeisung
const SET     = 'ecoflow-ps-ble.0.PS1.control.setWatts';
const RESERVE = 30, MIN = 0, MAX = 800, DEADBAND = 15;

schedule('*/10 * * * * *', () => {
    const grid = Number(getState(GRID).val) || 0;
    const cur  = Number(getState(SET).val) || 0;
    const target = Math.min(MAX, Math.max(MIN, Math.round((cur + grid - RESERVE) / 5) * 5));
    if (Math.abs(target - cur) >= DEADBAND) {
        setState(SET, target);
    }
});
```

## Bewusste Abweichungen vom Original

1. Beim Start wird kein Sollwert geschrieben, wenn Ist == Soll (der ESP schrieb nach jedem Boot einmal).
2. „Zuletzt geschrieben“ wird erst nach **erfolgreichem** Schreiben gemerkt (Retry bei Fehlern).
3. Der Ist-Wert wird bei Verbindungsabbruch verworfen und erst mit dem ersten neuen Heartbeat wieder verwendet.
4. Fragmentierte BLE-Notifications werden zusammengesetzt (Fallback; der ESP wertete jede Notification einzeln aus).
5. Mehrere Geräte pro Instanz; Datenpunkte statt MQTT-Topics.

## Bekannte Grenzen / offene Punkte

* **Nicht an echter Hardware verifiziert** (kein Bluetooth/PowerStream in der Entwicklungsumgebung). Die Aufrufe der BLE-Bibliothek
  folgen deren dokumentierter API, wurden aber nur gegen ein Fake geprüft.
* Telemetrie wird – wie im Original – über einen Feldspeicher **zusammengeführt**; ein Feld, das der PowerStream nie sendet, gilt als 0.
  Sollte der PowerStream Felder mit Wert 0 aus dem Heartbeat weglassen, bliebe ein zuvor gesehener Wert stehen. Im Original ist das nie aufgefallen;
  bei Verdacht Loglevel `debug` nutzen und Verlauf prüfen.
* Die HCI-Trennungsgründe (`reason=0x…` im Original) liefert noble nicht; `info.lastDisconnect` zeigt stattdessen den eigenen Grund (z. B. „Auth nicht bestaetigt“, „AUTH FAIL 0x…“).
  Die Fehlercode-Dokus des Originals (`BLE-Fehlercodes_*.md`) helfen bei `AUTH FAIL`.
* Getestet wurde das Original laut Autor mit PowerStream + Delta Pro (Gen1), Firmware V1.0.1.228. EcoFlow kann das jederzeit per Update ändern.

## Entwicklung

```bash
npm install
npm test          # Protokoll, Regel-Logik, Geraet (simulierter PowerStream), Adapter (simulierter adapter-core)
```

## Changelog

### 0.1.0
* Erstveröffentlichung: Portierung des BLE-Teils der ESP32-Bridge V2.6.3 nach ioBroker (nicht an echter Hardware getestet)

## Credits & Lizenz

* © **Just-Zuul 05/2026** – [Local-MQTT-EcoFlow-PowerStream-BLE-Bridge](https://github.com/Just-Zuul/Local-MQTT-EcoFlow-PowerStream-BLE-Bridge): Firmware, Sensor-Tabelle, Kommando-IDs, Regel-Logik.
* **Roman Bashlovkin** – [rabits/ha-ef-ble](https://github.com/rabits/ha-ef-ble): BLE-Protokoll-Reverse-Engineering.
* GnoX – EcoFlow User-ID-Finder.

**Nur für private, nicht-kommerzielle Nutzung** (siehe [LICENSE](LICENSE)). Das Original verbietet kommerzielle Nutzung, Weiterverkauf
und Integration in kommerzielle Produkte; bei Weitergabe von Änderungen sind Autor zu nennen und das Repository zu verlinken.
EcoFlow und PowerStream sind Marken der EcoFlow Technology Inc.; dieses Projekt steht in keiner Verbindung zu EcoFlow.
