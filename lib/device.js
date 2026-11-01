'use strict';
const { EventEmitter } = require('node:events');
const { Session, SVC_UUID, WRITE_UUID, NOTIFY_UUID, expectedFrameLength } = require('./protocol');
const { SENSORS, FIELD, HB_CHANNEL, knownFields, scaleValue } = require('./sensors');
const { SetpointController } = require('./controller');
const { nobleUuid, withTimeout, uuidEquals } = require('./ble');

const DEFAULTS = {
    minWatts: 0,
    maxWatts: 800,
    startWatts: 0,
    toleranceW: 5,
    writeGraceMs: 6000, // Mindestabstand zwischen Re-Asserts
    controlCheckMs: 5000, // Soll/Ist-Pruefintervall
    telemetryMs: 3000, // Telemetrie-Publish
    statusMs: 15000, // Link/RSSI-Status
    retryMs: 8000, // Pause zwischen BLE-Reconnect-Versuchen
    authTimeoutMs: 10000,
    fragTimeoutMs: 500, // Wartezeit auf Rest eines fragmentierten Frames
    allSensors: false,
    holdSetpoint: true, // false: Werte nur beim Setzen schreiben (anderer Adapter regelt), nichts nachfuehren
};

const noop = () => undefined;

/**
 * Ein PowerStream, ein BLE-Link. Meldet Aenderungen ueber das Event 'update' (id, wert),
 * wobei id relativ zum Geraet ist, z.B. "inverter_heartbeat.batSoc" oder "info.link".
 */
class PowerStreamDevice extends EventEmitter {
    /**
     * @param {object} cfg
     * @param {string} cfg.id Geraete-ID (nur fuer Logs)
     * @param {string} cfg.sn Seriennummer
     * @param {string} cfg.mac BLE-MAC
     * @param {string} cfg.userId EcoFlow User-ID
     * @param {import('./ble').BleManager} cfg.ble
     * @param {object} [cfg.options] siehe DEFAULTS
     * @param {object} [cfg.log] {debug,info,warn,error}
     */
    constructor(cfg) {
        super();
        this.id = cfg.id;
        this.mac = cfg.mac;
        this.ble = cfg.ble;
        this.opts = { ...DEFAULTS, ...(cfg.options || {}) };
        // Logger-Methoden explizit binden (adapter.log ist ein Klassenobjekt, Spread wuerde sie nicht kopieren)
        const l = cfg.log || {};
        this.log = {};
        for (const lvl of ['debug', 'info', 'warn', 'error']) {
            this.log[lvl] = typeof l[lvl] === 'function' ? m => l[lvl](m) : noop;
        }
        this.session = new Session(cfg.sn, cfg.userId);
        this.sensors = SENSORS.filter(s => !s.hidden || this.opts.allSensors);

        this.ctl = new SetpointController({
            minWatts: this.opts.minWatts,
            maxWatts: this.opts.maxWatts,
            startWatts: this.opts.startWatts,
            toleranceW: this.opts.toleranceW,
            graceMs: this.opts.writeGraceMs,
            hold: this.opts.holdSetpoint,
        });

        this.fields = {}; // zusammengefuehrter Feldspeicher ueber alle Heartbeats
        this.permWatts = null;
        this.brightPct = null;
        this.targetBright = null;
        this.targetSupply = null;
        this.suppressBrightUntil = 0;
        this.suppressSupplyUntil = 0;
        this.suppressPermUntil = 0;

        this.linked = false;
        this.reconnects = 0;
        this.lastDisconnect = '';
        this._telemFresh = false;
        this._stopped = true;
        this._timers = [];
        this._regulating = false;
        this._frag = null;
        this._sleepCancel = null;
        this._peripheral = null;
        this._writeChar = null;
        this._notifyChar = null;
        this._dataHandler = buf => this._onData(buf);
        this._discHandler = () => this._onDisconnected('Funkverbindung getrennt');
        this._discResolve = null;
        this._authResolve = null;
    }

    // ------------------------------------------------------------ Lebenszyklus
    start() {
        if (!this._stopped) {
            return;
        }
        this._stopped = false;
        this._timers.push(
            setInterval(() => this._publishTelemetry(), this.opts.telemetryMs),
            setInterval(() => void this._regulate(), this.opts.controlCheckMs),
            setInterval(() => void this._publishStatus(), this.opts.statusMs),
        );
        this._set('info.link', false);
        this._loopPromise = this._loop();
    }

    async stop() {
        this._stopped = true;
        this._timers.forEach(t => clearInterval(t));
        this._timers = [];
        if (this._sleepCancel) {
            this._sleepCancel();
        }
        if (this._discResolve) {
            this._discResolve();
        }
        if (this._loopPromise) {
            // laeuft evtl. gerade ein Scan/Connect: nicht ewig warten (Unload-Timeout von js-controller)
            await Promise.race([this._loopPromise, new Promise(r => setTimeout(r, 3000).unref())]);
        }
    }

    /** Verbindung bewusst trennen; die Schleife baut sie danach neu auf */
    reconnect() {
        this.log.info(`[${this.id}] Reconnect angefordert`);
        this.lastDisconnect = 'Reconnect angefordert';
        if (this._discResolve) {
            this._discResolve();
        }
    }

    // ------------------------------------------------------------ Steuerung
    /**
     * Neuen Einspeise-Sollwert setzen.
     *
     * @param {number} w
     * @returns {number} tatsaechlich verwendeter Wert (begrenzt + auf ganze Watt gerundet)
     */
    setTarget(w) {
        const applied = this.ctl.setTarget(w);
        this.log.info(`[${this.id}] Sollwert: ${applied} W`);
        this.suppressPermUntil = Date.now() + 8000;
        this._set(`${HB_CHANNEL}.permanentWatts`, applied, true);
        if (!this.linked) {
            this.log.info(`[${this.id}] Sollwert ${applied} W vorgemerkt - wird geschrieben, sobald das Geraet verbunden ist`);
        } else if (this.permWatts === null) {
            this.log.info(`[${this.id}] Sollwert ${applied} W vorgemerkt - noch kein Heartbeat des Geraets empfangen`);
        }
        void this._regulate();
        return applied;
    }

    /** Helligkeit in Prozent (0..100) */
    setBrightness(pct) {
        pct = Math.min(100, Math.max(0, Math.round(pct * 10) / 10));
        this.targetBright = pct;
        this.suppressBrightUntil = Date.now() + 8000;
        this._set(`${HB_CHANNEL}.invBrightness`, pct, true);
        if (this.linked) {
            // Faktor 0,1 wie bei ioBroker.ecoflow-mqtt (invBrightness 0..100 % = Rohwert 0..1000)
            void this._send(this.session.frameSetBright(Math.round(pct * 10)), `Helligkeit ${pct} %`);
        }
        return pct;
    }

    /** false = Prioritize power supply (Einspeisung), true = Prioritize power storage (Laden) */
    setSupplyMode(val) {
        const on = !!val;
        this.targetSupply = on ? 1 : 0;
        this.suppressSupplyUntil = Date.now() + 8000;
        this._set(`${HB_CHANNEL}.supplyPriority`, on, true);
        if (this.linked) {
            void this._send(this.session.frameSetSupply(on ? 1 : 0), `Supply-Priority ${on ? 'Laden' : 'Einspeisung'}`);
        }
        return on;
    }

    // ------------------------------------------------------------ intern: Schleife
    async _loop() {
        while (!this._stopped) {
            try {
                await this._connectAndAuth();
                await this._discPromise; // blockiert bis Verbindung abreisst / reconnect() / stop()
                if (!this.lastDisconnect) {
                    this.lastDisconnect = 'Verbindung getrennt';
                }
            } catch (e) {
                const msg = (e && e.message) || (e === undefined ? 'unbekannter BLE-Fehler' : String(e));
                this.lastDisconnect = msg;
                this.log.warn(`[${this.id}] ${msg}`);
            }
            await this._teardown();
            if (this._stopped) {
                break;
            }
            this._set('info.status', 'wartet auf Reconnect');
            await this._sleep(this.opts.retryMs);
        }
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this._sleepCancel = null;
                resolve();
            }, ms);
            this._sleepCancel = () => {
                clearTimeout(t);
                this._sleepCancel = null;
                resolve();
            };
        });
    }

    async _connectAndAuth() {
        this.lastDisconnect = '';
        this._discPromise = new Promise(res => {
            this._discResolve = res;
        });
        this._set('info.status', 'suche/verbinde');
        this.log.info(`[${this.id}] verbinde zu ${this.mac} ...`);
        const p = await this.ble.connect(this.mac, {
            onFound: per => {
                const adv = per.advertisement || {};
                this.log.info(
                    `[${this.id}] im Scan gefunden: RSSI ${per.rssi} dBm, Adresstyp ${per.addressType || '?'}, verbindbar ${per.connectable}, Name "${adv.localName || ''}"`,
                );
            },
        });
        this._peripheral = p;
        p.once('disconnect', this._discHandler);

        // Alles entdecken und tolerant vergleichen (noble liefert Basis-UUIDs je nach Version in Kurz- oder Langform)
        const discover =
            typeof p.discoverAllServicesAndCharacteristicsAsync === 'function'
                ? () => p.discoverAllServicesAndCharacteristicsAsync()
                : () => p.discoverSomeServicesAndCharacteristicsAsync([nobleUuid(SVC_UUID)], [nobleUuid(WRITE_UUID), nobleUuid(NOTIFY_UUID)]);
        const found = await withTimeout(discover(), 15000, 'GATT-Discovery Timeout');
        const chars = found.characteristics || [];
        this.log.debug(
            `[${this.id}] GATT: Dienste ${(found.services || []).map(x => x.uuid).join(',') || '-'}; Merkmale ${chars.map(c => c.uuid).join(',') || '-'}`,
        );
        this._writeChar = chars.find(c => uuidEquals(c.uuid, WRITE_UUID)) || null;
        this._notifyChar = chars.find(c => uuidEquals(c.uuid, NOTIFY_UUID)) || null;
        if (!this._writeChar || !this._notifyChar) {
            this.log.warn(
                `[${this.id}] Gefundene Dienste: ${(found.services || []).map(x => x.uuid).join(', ') || 'keine'}; Merkmale: ${chars.map(c => c.uuid).join(', ') || 'keine'}`,
            );
        }
        if (!this._writeChar || !this._notifyChar) {
            throw new Error('Erwarteter BLE-Dienst/Merkmale nicht gefunden - ist das Ziel wirklich ein PowerStream?');
        }
        this._withoutResponse = (this._writeChar.properties || []).includes('writeWithoutResponse');

        this._set('info.status', 'authentifiziere');
        this._notifyChar.on('data', this._dataHandler);
        await this._notifyChar.subscribeAsync();

        const authP = new Promise(res => {
            this._authResolve = res;
        });
        await this._sleep(300);
        await this._writeRaw(this.session.frameAuthStatus());
        await this._sleep(400);
        await this._writeRaw(this.session.frameAutoAuth());

        let timer;
        const result = await Promise.race([
            authP,
            this._discPromise.then(() => 'disc'),
            new Promise(res => {
                timer = setTimeout(() => res('timeout'), this.opts.authTimeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
        this._authResolve = null;
        if (result === 'disc') {
            throw new Error('Verbindung waehrend der Anmeldung getrennt (Seriennummer/User-ID korrekt? App geschlossen?)');
        }
        if (result === 'timeout') {
            throw new Error('Auth nicht bestaetigt (Seriennummer und User-ID pruefen)');
        }
        if (!result.ok) {
            throw new Error(`AUTH FAIL 0x${result.code.toString(16).padStart(2, '0').toUpperCase()}`);
        }

        this.linked = true;
        this.reconnects++;
        this.log.info(`[${this.id}] BLE verbunden und authentifiziert`);
        this._set('info.status', 'verbunden');
        this._set('info.link', true);
        this._set('info.bleReconnects', this.reconnects);
        // Sollwert NICHT blind schreiben - _regulate() schreibt nur bei Ist != Soll (write-on-change)
        if (this.opts.holdSetpoint && this.targetBright !== null) {
            void this._send(this.session.frameSetBright(Math.round(this.targetBright * 10)), 'Helligkeit');
        }
        if (this.opts.holdSetpoint && this.targetSupply !== null) {
            void this._send(this.session.frameSetSupply(this.targetSupply), 'Supply-Mode');
        }
        void this._publishStatus();
    }

    _onDisconnected(reason) {
        if (!this.lastDisconnect) {
            this.lastDisconnect = reason;
        }
        this.log.info(`[${this.id}] BLE getrennt (${this.lastDisconnect})`);
        if (this._discResolve) {
            this._discResolve();
        }
    }

    async _teardown() {
        const wasLinked = this.linked;
        this.linked = false;
        this.permWatts = null; // Ist-Wert ist nach einem Abbruch nicht mehr verlaesslich
        if (this._frag) {
            clearTimeout(this._frag.timer);
            this._frag = null;
        }
        if (this._notifyChar) {
            this._notifyChar.removeListener('data', this._dataHandler);
            try {
                await this._notifyChar.unsubscribeAsync();
            } catch {
                /* Verbindung evtl. schon weg */
            }
        }
        if (this._peripheral) {
            this._peripheral.removeListener('disconnect', this._discHandler);
            try {
                if (this._peripheral.state === 'connected') {
                    await this._peripheral.disconnectAsync();
                }
            } catch {
                /* ignorieren */
            }
        }
        this._peripheral = this._writeChar = this._notifyChar = null;
        this._authResolve = null;
        this._set('info.link', false);
        if (wasLinked || this.lastDisconnect) {
            this._set('info.lastDisconnect', this.lastDisconnect);
        }
        if (this._stopped) {
            this._set('info.status', 'gestoppt');
        }
    }

    // ------------------------------------------------------------ intern: Empfang
    _onData(buf) {
        if (this._frag) {
            this._frag.buf = Buffer.concat([this._frag.buf, buf]);
            if (this._frag.buf.length >= this._frag.expected) {
                clearTimeout(this._frag.timer);
                const whole = this._frag.buf;
                this._frag = null;
                this._handleFrame(whole);
            }
            return;
        }
        if (buf.length >= 5 && buf[0] === 0xaa) {
            const expected = expectedFrameLength(buf);
            if (buf.length < expected) {
                // Fragmentierter Frame (kleine MTU): Rest abwarten, sonst nach Timeout so auswerten wie er ist
                this.log.debug(`[${this.id}] fragmentierte Notification (${buf.length}/${expected} Byte)`);
                const timer = setTimeout(() => {
                    const part = this._frag && this._frag.buf;
                    this._frag = null;
                    if (part) {
                        this._handleFrame(part, false);
                    }
                }, this.opts.fragTimeoutMs);
                this._frag = { buf, expected, timer };
                return;
            }
        }
        this._handleFrame(buf);
    }

    /**
     * @param {Buffer} buf
     * @param {boolean} [complete] false = nach Timeout unvollstaendig zusammengesetzt
     */
    _handleFrame(buf, complete = true) {
        let r;
        try {
            r = this.session.parseNotify(buf);
        } catch (e) {
            this.log.debug(`[${this.id}] Frame nicht auswertbar: ${e.message}`);
            return;
        }
        if (!r) {
            return;
        }
        if (r.type === 'auth') {
            if (this._authResolve) {
                this._authResolve(r);
            }
            return;
        }
        if (r.type === 'heartbeat') {
            this._onHeartbeat(r.fields, complete);
        }
    }

    _onHeartbeat(f, complete = true) {
        if (complete) {
            // proto3 laesst Felder mit Wert 0 weg: ein vollstaendiger Heartbeat ersetzt den Feldspeicher,
            // sonst bliebe ein alter Wert stehen und "kein Feld 48" (= 0 W) wuerde nie erkannt.
            this.fields = { ...f };
        } else {
            Object.assign(this.fields, f);
        }
        this.log.debug(`[${this.id}] Heartbeat-Felder: ${JSON.stringify(f)}`);
        const first = this.permWatts === null;
        if (FIELD.PERM in f) {
            this.permWatts = Math.trunc(f[FIELD.PERM] / 10);
        } else if (complete) {
            this.permWatts = 0; // Feld fehlt = 0 W
        }
        if (FIELD.BRIGHT in f) {
            this.brightPct = Math.round(f[FIELD.BRIGHT]) / 10;
        } else if (complete) {
            this.brightPct = 0;
        }
        this._telemFresh = true;
        if (first && this.permWatts !== null) {
            void this._regulate(); // erster Ist-Wert nach (Re-)Connect: gleich abgleichen
        }
    }

    // ------------------------------------------------------------ intern: Senden
    async _writeRaw(frame) {
        if (!this._writeChar) {
            throw new Error('nicht verbunden');
        }
        await this._writeChar.writeAsync(frame, this._withoutResponse);
    }

    async _send(frame, what) {
        if (!this.linked) {
            return false;
        }
        try {
            await this._writeRaw(frame);
            this.log.info(`[${this.id}] gesendet: ${what}`);
            return true;
        } catch (e) {
            this.log.warn(`[${this.id}] Senden fehlgeschlagen (${what}): ${e.message}`);
            return false;
        }
    }

    async _regulate() {
        if (!this.linked || this._regulating) {
            return;
        }
        const w = this.ctl.decide(this.permWatts);
        if (w === null) {
            return;
        }
        this._regulating = true;
        try {
            this.log.info(`[${this.id}] Soll=${w} W Ist=${this.permWatts} W -> schreibe`);
            if (await this._send(this.session.frameSetLoad(w), `permanent_watts ${w} W`)) {
                this.ctl.markWritten(w);
            }
        } finally {
            this._regulating = false;
        }
    }

    // ------------------------------------------------------------ intern: Publish
    _set(id, val, force = false) {
        this.emit('update', id, val, force);
    }

    _publishTelemetry() {
        if (!this.linked || !this._telemFresh) {
            return;
        }
        this._telemFresh = false;
        const now = Date.now();
        for (const s of this.sensors) {
            // Nach einem Schreibzugriff den alten Geraetewert nicht gleich wieder anzeigen
            if (s.key === 'supplyPriority' && now <= this.suppressSupplyUntil) {
                continue;
            }
            if (s.key === 'invBrightness' && now <= this.suppressBrightUntil) {
                continue;
            }
            if (s.key === 'permanentWatts' && now <= this.suppressPermUntil && this.permWatts !== this.ctl.target) {
                continue;
            }
            // proto3-Regel: nie gesehenes Feld = 0
            const raw = this.fields[s.field] !== undefined ? this.fields[s.field] : 0;
            this._set(`${HB_CHANNEL}.${s.key}`, scaleValue(s, raw));
        }
        if (this.opts.allSensors) {
            // Felder, die der Adapter (noch) nicht kennt, als JSON zur Auswertung bereitstellen
            const known = knownFields();
            const unknown = {};
            for (const k of Object.keys(this.fields)) {
                if (!known.has(Number(k))) {
                    unknown[k] = this.fields[k];
                }
            }
            this._set('info.unknownFields', JSON.stringify(unknown));
        }
        const nowTs = Date.now();
        this._set('info.lastUpdate', nowTs);
    }

    async _publishStatus() {
        this._set('info.link', this.linked);
        this._set('info.bleReconnects', this.reconnects);
        if (this.linked && this._peripheral) {
            try {
                const rssi = await this._peripheral.updateRssiAsync();
                if (typeof rssi === 'number') {
                    this._set('info.bleRssi', rssi);
                }
            } catch {
                /* RSSI ist nur Diagnose */
            }
        }
    }
}

module.exports = { PowerStreamDevice, DEFAULTS };
