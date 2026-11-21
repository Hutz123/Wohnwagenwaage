# Waage – Neigungssensor für Einachsfahrzeuge

Ein BLE-Sensor misst die Neigung quer und längs. Eine App auf dem Android-Handy zeigt an, um wie viele Millimeter ein Rad unterbaut bzw. die Deichsel angehoben/abgesenkt werden muss.

```
firmware/waage/waage.ino   Firmware für Seeed XIAO nRF52840 Sense (Arduino)
app/                       Web-Bluetooth-App (PWA, offlinefähig), läuft in Chrome auf Android
tools/serve.py             Lokaler Testserver für die App
.github/workflows/         Veröffentlicht app/ auf GitHub Pages
```

## Hardware

- Seeed **XIAO nRF52840 Sense** (Beschleunigungssensor LSM6DS3TR-C ist auf dem Board)
- USB-C-Kabel
- Später: kleiner LiPo-Akku (3,7 V, z. B. 300–500 mAh) an die BAT-Pads auf der Unterseite, dazu ein kleines Gehäuse

## Firmware aufspielen

1. Arduino IDE 2 installieren.
2. *Datei → Einstellungen → Zusätzliche Boardverwalter-URLs*:
   `https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`
3. *Boardverwalter*: **„Seeed nRF52 Boards“** installieren – **nicht** „Seeed nRF52 mbed-enabled Boards“.
4. Board **„Seeed XIAO nRF52840 Sense“** wählen, `firmware/waage/waage.ino` öffnen, hochladen.
   Weitere Bibliotheken sind nicht nötig (Bluefruit und LittleFS gehören zum Board-Paket).

Falls das Hochladen nicht klappt: Reset-Taste zweimal schnell drücken. Dann erscheint ein USB-Laufwerk und das Board wartet auf Firmware.

Die serielle Konsole (115200 Baud) zeigt Fehler, z. B. wenn der Sensor nicht gefunden wird.

## App bereitstellen

Web Bluetooth funktioniert nur über HTTPS. Am einfachsten geht das mit GitHub Pages:

1. Projekt in ein GitHub-Repository pushen (Branch `main`).
2. Repo → *Settings → Pages → Source: **GitHub Actions***.
3. Der Workflow veröffentlicht `app/`. Die Adresse steht danach im Actions-Lauf.
4. Die Adresse auf dem Handy in **Chrome** öffnen, dann *⋮ → Zum Startbildschirm hinzufügen*. Danach läuft die App wie eine normale App, auch offline.

Lokaler Test ohne Sensor: `python tools/serve.py` starten und `http://localhost:8123/?demo` öffnen (simulierte Messwerte).

## Montage

- Board **flach** montieren, **Bauteilseite nach oben**.
- Board-Kanten möglichst **parallel zur Achse**. Ist das Board im Grundriss verdreht, mischt sich die Längsneigung in die Querneigung: Bei 5° Verdrehung landen ca. 9 % der Längsneigung in der Querneigung.
- **Starr** befestigen. Wackelt der Sensor, ist die Kalibrierung wertlos.

## Erste Inbetriebnahme

1. App öffnen, **Verbinden**, Gerät „Waage“ wählen.
2. ⚙ **Einstellungen**:
   - **Spurweite**: Mitte Reifenaufstandsfläche bis Mitte Reifenaufstandsfläche.
   - **Abstand Achse–Stützrad** (optional): Damit zeigt die App die Längsneigung in mm an der Deichsel an.
   - **Einbaulage → Automatisch erkennen**, dann die Deichsel per Stützrad ein paar Zentimeter anheben. Die App erkennt, welche Sensorachse nach vorne zeigt.
   - **Nullpunkt setzen**: Nur wenn das Fahrzeug nachweislich waagerecht steht, z. B. auf ebenem Hallenboden, mit der Wasserwaage auf Achse/Rahmen geprüft. Der Nullpunkt wird im Sensor gespeichert.
3. **Speichern**.

Gemessen wird nur, solange die App verbunden ist. Ohne Verbindung ist der Sensor stromlos und der Funkchip sendet nur selten ein Lebenszeichen.

## Rechnung

- Unterbauhöhe Rad: `h = Spurweite × sin(Querneigung)`. Unterbaut wird immer das tiefere Rad.
- Deichsel: `h = Abstand Achse–Stützrad × sin(Längsneigung)`

## BLE-Protokoll

| | UUID | |
|---|---|---|
| Service | `6f1a0001-3c2b-4d5e-8f90-a1b2c3d4e5f6` | |
| Tilt | `6f1a0002-3c2b-4d5e-8f90-a1b2c3d4e5f6` | read/notify, 5 Hz, 6 Byte: `int16` Neigung X, `int16` Neigung Y (je 0,01°, little-endian), `uint8` Flags (bit0 ruhig, bit1 Nullpunkt gesetzt), `uint8` reserviert |
| Ctrl | `6f1a0003-3c2b-4d5e-8f90-a1b2c3d4e5f6` | write, 1 Byte: `0x01` Nullpunkt setzen (3 s Mittelung), `0x02` Nullpunkt löschen |

Die Neigung ist positiv, wenn das +X- bzw. +Y-Ende der Sensorachse höher liegt. Die Zuordnung zu vorne/links macht die App über die Einbaulage.

## Stand / nächste Schritte

- [ ] Firmware auf echter Hardware testen (bisher nur geschrieben, nicht auf dem Board gelaufen)
- [ ] Akkuspannung messen und in der App anzeigen
- [ ] Genauigkeit über Temperatur prüfen (Nullpunkt morgens kalt vs. mittags warm)
- [ ] Optional: Keil-Stufen in der App („Stufe 2“ statt mm)
