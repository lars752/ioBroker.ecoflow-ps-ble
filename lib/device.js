'use strict';
const { EventEmitter } = require('node:events');
const { Session, SVC_UUID, WRITE_UUID, NOTIFY_UUID, expectedFrameLength } = require('./protocol');
const { SENSORS, FIELD, scaleValue } = require('./sensors');
const { SetpointController } = require('./controller');
const { nobleUuid, withTimeout } = require('./ble');

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
};

const noop = () => undefined;

/**
 * Ein PowerStream, ein BLE-Link. Meldet Aenderungen ueber das Event 'update' (id, wert),
 * wobei id relativ zum Geraet ist, z.B. "telemetry.bat_soc" oder "info.link".
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
        });

        this.fields = {}; // zusammengefuehrter Feldspeicher ueber alle Heartbeats
        this.permWatts = null;
        this.brightPct = null;
        this.targetBright = null;
        this.targetSupply = null;
        this.suppressBrightUntil = 0;
        this.suppressSupplyUntil = 0;

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
        if (this.ctl.target !== null) {
            this._set('control.setWatts', this.ctl.target);
        }
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
     * @returns {number} tatsaechlich verwendeter Wert (begrenzt + auf 5 W gerundet)
     */
    setTarget(w) {
        const applied = this.ctl.setTarget(w);
        this.log.info(`[${this.id}] Sollwert: ${applied} W`);
        this._set('control.setWatts', applied);
        void this._regulate();
        return applied;
    }

    /** Helligkeit in Prozent (0..100) */
    setBrightness(pct) {
        pct = Math.min(100, Math.max(0, Math.round(pct)));
        this.targetBright = pct;
        this.suppressBrightUntil = Date.now() + 8000;
        this._set('control.brightness', pct);
        if (this.linked) {
            void this._send(this.session.frameSetBright(Math.round((pct / 100) * 1023)), `Helligkeit ${pct} %`);
        }
        return pct;
    }

    /** 0 = Prioritize power supply, 1 = Prioritize power storage */
    setSupplyMode(val) {
        val = val ? 1 : 0;
        this.targetSupply = val;
        this.suppressSupplyUntil = Date.now() + 8000;
        this._set('control.supplyMode', val);
        if (this.linked) {
            void this._send(this.session.frameSetSupply(val), `Supply-Mode ${val}`);
        }
        return val;
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
                this.lastDisconnect = e.message;
                this.log.warn(`[${this.id}] ${e.message}`);
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
        const p = await this.ble.connect(this.mac);
        this._peripheral = p;
        p.once('disconnect', this._discHandler);

        const found = await withTimeout(
            p.discoverSomeServicesAndCharacteristicsAsync([nobleUuid(SVC_UUID)], [nobleUuid(WRITE_UUID), nobleUuid(NOTIFY_UUID)]),
            10000,
            'GATT-Discovery Timeout',
        );
        const chars = found.characteristics || [];
        this._writeChar = chars.find(c => c.uuid === nobleUuid(WRITE_UUID)) || null;
        this._notifyChar = chars.find(c => c.uuid === nobleUuid(NOTIFY_UUID)) || null;
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
        if (this.targetBright !== null) {
            void this._send(this.session.frameSetBright(Math.round((this.targetBright / 100) * 1023)), 'Helligkeit');
        }
        if (this.targetSupply !== null) {
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
                        this._handleFrame(part);
                    }
                }, this.opts.fragTimeoutMs);
                this._frag = { buf, expected, timer };
                return;
            }
        }
        this._handleFrame(buf);
    }

    _handleFrame(buf) {
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
            this._onHeartbeat(r.fields);
        }
    }

    _onHeartbeat(f) {
        Object.assign(this.fields, f);
        this.log.debug(`[${this.id}] Heartbeat-Felder: ${JSON.stringify(f)}`);
        const first = this.permWatts === null;
        if (FIELD.PERM in f) {
            this.permWatts = Math.trunc(f[FIELD.PERM] / 10);
        }
        if (FIELD.BRIGHT in f) {
            this.brightPct = Math.round((f[FIELD.BRIGHT] / 1023) * 100);
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
    _set(id, val) {
        this.emit('update', id, val);
    }

    _publishTelemetry() {
        if (!this.linked || !this._telemFresh) {
            return;
        }
        this._telemFresh = false;
        for (const s of this.sensors) {
            // proto3-Regel: nie gesehenes Feld = 0
            const raw = this.fields[s.field] !== undefined ? this.fields[s.field] : 0;
            this._set(`telemetry.${s.key}`, scaleValue(s, raw));
        }
        const now = Date.now();
        if (this.brightPct !== null && now > this.suppressBrightUntil) {
            this._set('control.brightness', this.brightPct);
        }
        if (now > this.suppressSupplyUntil) {
            this._set('control.supplyMode', this.fields[FIELD.SUPPLY] ? 1 : 0);
        }
        this._set('info.lastUpdate', now);
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
