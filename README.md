# ioBroker.ecoflow-ps-ble

![Tests](https://github.com/lars752/ioBroker.ecoflow-ps-ble/actions/workflows/test.yml/badge.svg)

Lokale, cloudfreie Anbindung des **EcoFlow PowerStream (HW51)** per **Bluetooth LE** an ioBroker.

Der Adapter verbindet sich direkt vom ioBroker-Host aus mit dem PowerStream – ohne EcoFlow-Cloud, ohne zusätzliche Hardware
und ohne MQTT-Broker. Messwerte erscheinen als ioBroker-Datenpunkte, der Einspeise-Sollwert lässt sich über einen Datenpunkt steuern.

## Funktionen

* Messwerte: PV1/PV2, Inverter, Batterie (inkl. Ladezustand), Temperaturen, Status- und Fehlercodes
* Steuerung: Einspeise-Sollwert (W), LED-Helligkeit, Power-Supply-Mode
* Schonende Sollwert-Regelung (Write-on-Change): Der Sollwert liegt im Flash des PowerStream und wird nur bei Änderung
  oder abweichendem Ist-Wert geschrieben – im Ruhezustand gibt es keine Schreibzugriffe
* Mehrere PowerStreams in einer Instanz
* Automatischer Wiederaufbau der Verbindung, Verbindungsdiagnose (RSSI, Status, letzter Trennungsgrund)
* Abruf der EcoFlow User-ID direkt in den Instanz-Einstellungen

## Voraussetzungen

* ioBroker mit Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6
* **Bluetooth-Adapter am ioBroker-Host in Reichweite des PowerStream.** Die BLE-Reichweite beträgt typischerweise wenige Meter;
  Wände und Außenmontage verkürzen sie. Ggf. einen USB-Bluetooth-Dongle an geeigneter Stelle einsetzen.
* Der PowerStream akzeptiert **nur eine** BLE-Verbindung gleichzeitig – die Bluetooth-Verbindung der EcoFlow-App muss geschlossen sein.
* Pro Gerät: **Seriennummer** und **BLE-MAC-Adresse** (z. B. mit der App *nRF Connect* auslesen; der Gerätename beginnt mit `HW-…`)

### Linux

Der Adapter nutzt [`@abandonware/noble`](https://github.com/abandonware/noble). Laut dessen Dokumentation:

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev build-essential
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

* In **VM, Proxmox/LXC und Docker** muss der Bluetooth-Adapter an den Gast durchgereicht werden (USB-Passthrough; bei Docker u. a. `NET_ADMIN`/`NET_RAW`).
* Belegt ein laufender `bluetoothd` den Adapter, helfen ggf. `sudo systemctl stop bluetooth` bzw. `hciconfig hci0 up`.
* macOS stellt Anwendungen keine MAC-Adressen bereit; die Suche per MAC funktioniert dort nicht.

## Installation

```bash
cd /opt/iobroker
npm install https://github.com/lars752/ioBroker.ecoflow-ps-ble/tarball/main
iobroker upload ecoflow-ps-ble
iobroker add ecoflow-ps-ble
```

## Einrichtung

1. **User-ID ermitteln:** Instanz einmal starten, die Einstellungen öffnen und unter *EcoFlow-Konto* E-Mail bzw. Telefonnummer, Passwort
   und Region eintragen, dann **„User-ID abrufen“**. Der Adapter meldet sich einmalig an der EcoFlow-API an und trägt die ID ein.
   Die Zugangsdaten werden weder gespeichert noch protokolliert und gehen ausschließlich an die EcoFlow-Server.
   Alternativ lässt sich die User-ID auch von Hand eintragen.
2. **Geräte eintragen:** Pro PowerStream eine Zeile mit frei wählbarer Geräte-ID (z. B. `PS1`), Seriennummer (exakt wie auf dem Gerät) und BLE-MAC.
3. **Sollwert-Grenzen** prüfen (HW51: 0–800 W) und den Startwert festlegen. Startwert **-1** bedeutet: nach dem Adapterstart nichts schreiben,
   bis erstmals ein Sollwert gesetzt wird.
4. Instanz speichern und neu starten.

Weitere Einstellungen: Soll/Ist-Toleranz (5 W), Karenz zwischen Nachschreibversuchen (6 s), Messwert-Intervall (3 s), Pause zwischen
Verbindungsversuchen (8 s) sowie das Anlegen selten genutzter Sensoren (Inverter-Temperatur, Installationsland/-ort).

## Datenpunkte

Alle Datenpunkte liegen unter `ecoflow-ps-ble.<Instanz>.<Geräte-ID>.…`.

| Bereich | Datenpunkt | Beschreibung |
|---|---|---|
| `control` | `setWatts` (W, schreibbar) | Einspeise-Sollwert; wird begrenzt und kaufmännisch auf 5 W gerundet, der verwendete Wert kommt mit `ack=true` zurück |
| | `brightness` (%, schreibbar) | LED-Helligkeit 0–100 % |
| | `supplyMode` (0/1, schreibbar) | 0 = Prioritize power supply, 1 = Prioritize power storage |
| | `reconnect` (Button) | BLE-Verbindung trennen und neu aufbauen |
| `telemetry` | 47 Messwerte (3 davon optional) | Spannungen, Ströme, Leistungen, Temperaturen, Status-/Fehlercodes, `bat_soc`, `bat_input_watts` (± = Fluss zur/von der Batterie) … |
| `info` | `link` | BLE verbunden **und** angemeldet |
| | `status`, `lastDisconnect`, `bleReconnects`, `bleRssi`, `lastUpdate` | Verbindungsdiagnose |
| (Instanz) | `info.connection` | Mindestens ein Gerät verbunden |

Wichtige Messwerte: `permanent_watts` (aktuell im Gerät eingestellter Sollwert), `inv_output_watts` (Inverter-Ausgang), `pv1_watts`, `pv2_watts`.

## Verhalten

* **Write-on-Change:** Geschrieben wird nur bei geändertem Sollwert **oder** wenn der Ist-Wert um mindestens die Toleranz abweicht
  (selbstheilend bei verlorenem Schreibbefehl, gedrosselt durch die Karenzzeit).
* **Reconnect:** Bei Verbindungsabbruch wird nach der eingestellten Pause neu gesucht und verbunden. Helligkeit und Supply-Mode werden dann erneut gesetzt,
  der Sollwert nur, wenn er vom Ist-Wert abweicht.
* **Verbindungsabbruch und Adapter-Stopp:** Der PowerStream behält seinen zuletzt geschriebenen Sollwert. Eine Rückfallleistung bei Ausfall
  der Verbindung gibt es nicht.
* Nach einem Adapterstart gilt der konfigurierte Startwert (bzw. keiner bei -1), nicht der zuletzt gespeicherte Wert des Datenpunkts.

## Hinweise

* Entwickelt für den PowerStream **HW51**. EcoFlow kann Protokoll und Verhalten per Firmware-Update jederzeit ändern.
* Der Adapter wird ohne Gewähr bereitgestellt. Sollwert-Grenzen und Einspeisung liegen in der Verantwortung des Betreibers.
* Fehlerdiagnose: Loglevel `debug` zeigt u. a. die empfangenen Rohfelder des PowerStream. Bei `AUTH FAIL` Seriennummer und User-ID prüfen.
* Der Adapter und seine Autoren stehen in keiner Verbindung zu EcoFlow. EcoFlow und PowerStream sind Marken der EcoFlow Technology Inc.

## Entwicklung

```bash
npm install
npm test
```

Die Tests decken Protokoll, Regel-Logik, Geräteanbindung (simulierter PowerStream), Adapter-Ablauf und den EcoFlow-Login ab.

## Changelog

### 0.1.0
* Erstveröffentlichung

## Lizenz

Siehe [LICENSE](LICENSE).
