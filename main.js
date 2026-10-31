'use strict';
/*
 * ioBroker.ecoflow-ps-ble
 * Lokale, cloudfreie Anbindung des EcoFlow PowerStream (HW51) per Bluetooth LE.
 */
const utils = require('@iobroker/adapter-core');
const { BleManager } = require('./lib/ble');
const { PowerStreamDevice } = require('./lib/device');
const { SENSORS } = require('./lib/sensors');
const { fetchUserId, LoginError } = require('./lib/login');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

class EcoflowPsBle extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] */
    constructor(options = {}) {
        super({ ...options, name: 'ecoflow-ps-ble' });
        /** @type {Map<string, PowerStreamDevice>} */
        this.devices = new Map();
        this.ble = null;
        this._initTimer = null;
        this._unloaded = false;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------------------------------------------------------- Start
    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const cfg = this.config;

        const userId = String(cfg.userId || '').trim();
        if (!userId) {
            this.log.error('Keine EcoFlow User-ID konfiguriert. In den Instanz-Einstellungen unter "EcoFlow-Konto" die User-ID abrufen oder eintragen.');
            return;
        }

        const defs = this._validateDevices(cfg.devices);
        if (!defs.length) {
            this.log.error('Kein gueltiges, aktives Geraet konfiguriert (Geraete-ID, Seriennummer, BLE-MAC).');
            return;
        }

        const options = {
            minWatts: num(cfg.minWatts, 0),
            maxWatts: num(cfg.maxWatts, 800),
            startWatts: num(cfg.startWatts, 0),
            toleranceW: num(cfg.toleranceW, 5),
            writeGraceMs: num(cfg.writeGraceS, 6) * 1000,
            telemetryMs: Math.max(1, num(cfg.telemetryS, 3)) * 1000,
            retryMs: Math.max(2, num(cfg.retryS, 8)) * 1000,
            allSensors: !!cfg.allSensors,
        };
        if (options.maxWatts < options.minWatts) {
            this.log.warn('Maximalleistung < Minimalleistung - verwende 0..800 W');
            options.minWatts = 0;
            options.maxWatts = 800;
        }

        this.ble = new BleManager();
        for (const d of defs) {
            await this._createObjects(d, options);
            const dev = new PowerStreamDevice({
                id: d.id,
                sn: d.sn,
                mac: d.mac,
                userId,
                ble: this.ble,
                options,
                log: this.log,
            });
            dev.on('update', (id, val) => void this._onDeviceUpdate(d.id, id, val));
            this.devices.set(d.id, dev);
        }
        this.subscribeStates('*.control.*');
        await this._initBleAndStart();
    }

    /** Bluetooth bereit machen; bei Fehlern regelmaessig neu versuchen (Dongle evtl. spaeter da) */
    async _initBleAndStart(attempt = 0) {
        if (this._unloaded) {
            return;
        }
        try {
            await this.ble.init();
        } catch (e) {
            (attempt === 0 ? this.log.error : this.log.debug).call(this.log, `Bluetooth nicht verfuegbar: ${e.message} (neuer Versuch in 30 s)`);
            this._initTimer = setTimeout(() => void this._initBleAndStart(attempt + 1), 30000);
            return;
        }
        this.log.info(`Bluetooth bereit - starte ${this.devices.size} Geraet(e)`);
        for (const dev of this.devices.values()) {
            dev.start();
        }
    }

    _validateDevices(list) {
        const out = [];
        const seen = new Set();
        for (const raw of Array.isArray(list) ? list : []) {
            if (!raw || raw.enabled === false) {
                continue;
            }
            const id = String(raw.id || '').trim();
            const sn = String(raw.sn || '').trim();
            const mac = String(raw.mac || '')
                .trim()
                .toLowerCase()
                .replace(/-/g, ':');
            if (!ID_RE.test(id)) {
                this.log.error(`Geraete-ID "${id}" ungueltig (erlaubt: Buchstaben, Ziffern, _ und -)`);
                continue;
            }
            if (seen.has(id)) {
                this.log.error(`Geraete-ID "${id}" doppelt vergeben`);
                continue;
            }
            if (!sn) {
                this.log.error(`[${id}] Seriennummer fehlt`);
                continue;
            }
            if (!MAC_RE.test(mac)) {
                this.log.error(`[${id}] BLE-MAC "${raw.mac}" ungueltig (Format aa:bb:cc:dd:ee:ff)`);
                continue;
            }
            seen.add(id);
            out.push({ id, sn, mac });
        }
        return out;
    }

    // ---------------------------------------------------------------- Objekte
    async _state(id, common) {
        await this.extendObjectAsync(id, {
            type: 'state',
            common: { read: true, write: false, ...common },
            native: {},
        });
    }

    async _createObjects(d, options) {
        const base = d.id;
        await this.extendObjectAsync(base, {
            type: 'device',
            common: { name: `PowerStream ${d.id}` },
            native: { sn: d.sn, mac: d.mac },
        });
        for (const [ch, name] of [
            ['control', 'Steuerung'],
            ['telemetry', 'Messwerte'],
            ['info', 'Verbindung / Diagnose'],
        ]) {
            await this.extendObjectAsync(`${base}.${ch}`, { type: 'channel', common: { name }, native: {} });
        }

        // --- Steuerung ---
        await this._state(`${base}.control.setWatts`, {
            name: 'Einspeise-Sollwert',
            type: 'number',
            role: 'level',
            unit: 'W',
            min: options.minWatts,
            max: options.maxWatts,
            step: 5,
            write: true,
        });
        await this._state(`${base}.control.brightness`, {
            name: 'Inverter Helligkeit',
            type: 'number',
            role: 'level.dimmer',
            unit: '%',
            min: 0,
            max: 100,
            write: true,
        });
        await this._state(`${base}.control.supplyMode`, {
            name: 'Power Supply Mode',
            type: 'number',
            role: 'level',
            min: 0,
            max: 1,
            states: { 0: 'Prioritize power supply', 1: 'Prioritize power storage' },
            write: true,
        });
        await this._state(`${base}.control.reconnect`, {
            name: 'BLE-Verbindung neu aufbauen',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            def: false,
        });

        // --- Messwerte ---
        for (const s of SENSORS) {
            if (s.hidden && !options.allSensors) {
                continue;
            }
            const common = {
                name: s.name,
                type: s.kind === 'bool' ? 'boolean' : 'number',
                role: s.role,
            };
            if (s.unit) {
                common.unit = s.unit;
            }
            await this._state(`${base}.telemetry.${s.key}`, common);
        }

        // --- Diagnose ---
        await this._state(`${base}.info.link`, { name: 'BLE verbunden und angemeldet', type: 'boolean', role: 'indicator.reachable' });
        await this._state(`${base}.info.status`, { name: 'Verbindungsstatus', type: 'string', role: 'text' });
        await this._state(`${base}.info.bleRssi`, { name: 'BLE RSSI', type: 'number', role: 'value.rssi', unit: 'dBm' });
        await this._state(`${base}.info.bleReconnects`, { name: 'BLE Verbindungen seit Start', type: 'number', role: 'value' });
        await this._state(`${base}.info.lastDisconnect`, { name: 'Letzter Trennungsgrund', type: 'string', role: 'text' });
        await this._state(`${base}.info.lastUpdate`, { name: 'Letzte Messwert-Aktualisierung', type: 'number', role: 'value.time' });
    }

    // ---------------------------------------------------------------- Geraet -> States
    async _onDeviceUpdate(devId, id, val) {
        if (this._unloaded) {
            return;
        }
        const full = `${devId}.${id}`;
        try {
            if (id.startsWith('control.')) {
                await this.setStateAsync(full, { val, ack: true });
            } else {
                await this.setStateChangedAsync(full, { val, ack: true });
            }
            if (id === 'info.link') {
                const any = [...this.devices.values()].some(d => d.linked);
                await this.setStateChangedAsync('info.connection', { val: any, ack: true });
            }
        } catch (e) {
            this.log.debug(`State ${full} nicht gesetzt: ${e.message}`);
        }
    }

    // ---------------------------------------------------------------- States -> Geraet
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const parts = id.slice(this.namespace.length + 1).split('.');
        if (parts.length !== 3 || parts[1] !== 'control') {
            return;
        }
        const dev = this.devices.get(parts[0]);
        if (!dev) {
            return;
        }
        const val = Number(state.val);
        switch (parts[2]) {
            case 'setWatts':
                if (Number.isFinite(val)) {
                    dev.setTarget(val);
                } else {
                    this.log.warn(`[${parts[0]}] ungueltiger Sollwert: ${state.val}`);
                }
                break;
            case 'brightness':
                if (Number.isFinite(val)) {
                    dev.setBrightness(val);
                }
                break;
            case 'supplyMode':
                if (Number.isFinite(val)) {
                    dev.setSupplyMode(val);
                }
                break;
            case 'reconnect':
                if (state.val === true || state.val === 'true' || val === 1) {
                    dev.reconnect();
                }
                await this.setStateAsync(id, { val: false, ack: true });
                break;
            default:
                break;
        }
    }

    // ---------------------------------------------------------------- Admin-Nachrichten
    /**
     * Admin -> Adapter: "getUserId". Meldet sich mit den uebergebenen EcoFlow-Zugangsdaten an
     * und liefert die User-ID zurueck. Zugangsdaten werden weder gespeichert noch geloggt.
     *
     * @param {ioBroker.Message} obj
     */
    async onMessage(obj) {
        if (!obj || obj.command !== 'getUserId') {
            return;
        }
        const m = obj.message || {};
        let response;
        try {
            const userId = await fetchUserId({ identifier: m.email, password: m.password, region: m.region });
            this.log.info('EcoFlow User-ID erfolgreich ermittelt');
            response = { result: `User-ID: ${userId}`, native: { userId } };
        } catch (e) {
            if (!(e instanceof LoginError)) {
                this.log.warn(`User-ID-Abfrage fehlgeschlagen: ${e.message}`);
            }
            response = { error: e.message };
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, response, obj.callback);
        }
    }

    // ---------------------------------------------------------------- Ende
    async onUnload(callback) {
        this._unloaded = true;
        try {
            if (this._initTimer) {
                clearTimeout(this._initTimer);
            }
            await Promise.all([...this.devices.values()].map(d => d.stop()));
            if (this.ble) {
                await this.ble.shutdown();
            }
            await this.setStateAsync('info.connection', false, true);
        } catch (e) {
            this.log.debug(`Fehler beim Beenden: ${e.message}`);
        } finally {
            callback();
        }
    }
}

function num(v, def) {
    const n = Number(v);
    return v === '' || v === null || v === undefined || !Number.isFinite(n) ? def : n;
}

if (require.main !== module) {
    /** @param {Partial<utils.AdapterOptions>} [options] */
    module.exports = options => new EcoflowPsBle(options);
} else {
    new EcoflowPsBle();
}
