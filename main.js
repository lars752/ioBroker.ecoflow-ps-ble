'use strict';
/*
 * ioBroker.ecoflow-ps-ble
 * Lokale, cloudfreie Anbindung des EcoFlow PowerStream (HW51) per Bluetooth LE.
 */
const utils = require('@iobroker/adapter-core');
const { BleManager, listAdapters } = require('./lib/ble');
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
        this._ecoInitTimer = null;
        this._ecoUnloaded = false;
        this._ecoDefs = [];
        this._ecoOptions = null;
        this._ecoUserId = '';
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ---------------------------------------------------------------- Start
    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        await this._ecoState('info.userId', {
            name: 'Ermittelte EcoFlow User-ID',
            type: 'string',
            role: 'text',
        });
        const cfg = this.config;

        this._ecoDefs = this._ecoValidateDevices(cfg.devices);
        if (!this._ecoDefs.length) {
            this.log.error('Kein gueltiges, aktives Geraet konfiguriert (Geraete-ID, Seriennummer, BLE-MAC).');
            return;
        }

        this._ecoOptions = {
            minWatts: num(cfg.minWatts, 0),
            maxWatts: num(cfg.maxWatts, 800),
            startWatts: num(cfg.startWatts, 0),
            toleranceW: num(cfg.toleranceW, 5),
            writeGraceMs: num(cfg.writeGraceS, 6) * 1000,
            telemetryMs: Math.max(1, num(cfg.telemetryS, 3)) * 1000,
            retryMs: Math.max(2, num(cfg.retryS, 8)) * 1000,
            allSensors: !!cfg.allSensors,
        };
        if (this._ecoOptions.maxWatts < this._ecoOptions.minWatts) {
            this.log.warn('Maximalleistung < Minimalleistung - verwende 0..800 W');
            this._ecoOptions.minWatts = 0;
            this._ecoOptions.maxWatts = 800;
        }

        const hci = String(cfg.hciDevice === undefined || cfg.hciDevice === null ? '' : cfg.hciDevice).trim();
        const hciDevice = /^\d+$/.test(hci) ? Number(hci) : null;
        if (hciDevice !== null) {
            this.log.info(`Verwende Bluetooth-Adapter hci${hciDevice}`);
        }
        this.ble = new BleManager({ hciDevice });
        for (const d of this._ecoDefs) {
            await this._ecoCreateObjects(d, this._ecoOptions);
        }
        this.subscribeStates('*.control.*');

        // Eine im Feld eingetragene User-ID hat Vorrang; sonst die per "User-ID abrufen" gespeicherte
        const manual = String(cfg.userId || '').trim();
        const stored = manual ? null : await this.getStateAsync('info.userId');
        const userId = manual || (stored && stored.val ? String(stored.val) : '');
        if (!userId) {
            this.log.warn('Noch keine EcoFlow User-ID vorhanden. In den Instanz-Einstellungen unter "EcoFlow-Konto" "User-ID abrufen" ausfuehren oder die ID eintragen.');
            return;
        }
        this._ecoUserId = userId;
        await this._ecoStartDevices();
    }

    /** (Neu-)Aufbau der Geraete mit der aktuellen User-ID */
    async _ecoStartDevices() {
        if (this._ecoUnloaded) {
            return;
        }
        if (this._ecoInitTimer) {
            clearTimeout(this._ecoInitTimer);
            this._ecoInitTimer = null;
        }
        await Promise.all([...this.devices.values()].map(d => d.stop()));
        this.devices.clear();
        for (const d of this._ecoDefs) {
            const dev = new PowerStreamDevice({
                id: d.id,
                sn: d.sn,
                mac: d.mac,
                userId: this._ecoUserId,
                ble: this.ble,
                options: this._ecoOptions,
                log: this.log,
            });
            dev.on('update', (id, val) => void this._ecoOnDeviceUpdate(d.id, id, val));
            this.devices.set(d.id, dev);
        }
        await this._ecoInitBleAndStart();
    }

    /** Bluetooth bereit machen; bei Fehlern regelmaessig neu versuchen (Dongle evtl. spaeter da) */
    async _ecoInitBleAndStart(attempt = 0) {
        if (this._ecoUnloaded) {
            return;
        }
        try {
            await this.ble.init();
        } catch (e) {
            (attempt === 0 ? this.log.error : this.log.debug).call(this.log, `Bluetooth nicht verfuegbar: ${e.message} (neuer Versuch in 30 s)`);
            this._ecoInitTimer = setTimeout(() => void this._ecoInitBleAndStart(attempt + 1), 30000);
            return;
        }
        this.log.info(`Bluetooth bereit (Bibliothek ${this.ble.libName}) - starte ${this.devices.size} Geraet(e)`);
        for (const dev of this.devices.values()) {
            dev.start();
        }
    }

    _ecoValidateDevices(list) {
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
    async _ecoState(id, common) {
        await this.extendObjectAsync(id, {
            type: 'state',
            common: { read: true, write: false, ...common },
            native: {},
        });
    }

    async _ecoCreateObjects(d, options) {
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
        await this._ecoState(`${base}.control.setWatts`, {
            name: 'Einspeise-Sollwert',
            type: 'number',
            role: 'level',
            unit: 'W',
            min: options.minWatts,
            max: options.maxWatts,
            step: 5,
            write: true,
        });
        await this._ecoState(`${base}.control.brightness`, {
            name: 'Inverter Helligkeit',
            type: 'number',
            role: 'level.dimmer',
            unit: '%',
            min: 0,
            max: 100,
            write: true,
        });
        await this._ecoState(`${base}.control.supplyMode`, {
            name: 'Power Supply Mode',
            type: 'number',
            role: 'level',
            min: 0,
            max: 1,
            states: { 0: 'Prioritize power supply', 1: 'Prioritize power storage' },
            write: true,
        });
        await this._ecoState(`${base}.control.reconnect`, {
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
            await this._ecoState(`${base}.telemetry.${s.key}`, common);
        }

        // --- Diagnose ---
        await this._ecoState(`${base}.info.link`, { name: 'BLE verbunden und angemeldet', type: 'boolean', role: 'indicator.reachable' });
        await this._ecoState(`${base}.info.status`, { name: 'Verbindungsstatus', type: 'string', role: 'text' });
        await this._ecoState(`${base}.info.bleRssi`, { name: 'BLE RSSI', type: 'number', role: 'value.rssi', unit: 'dBm' });
        await this._ecoState(`${base}.info.bleReconnects`, { name: 'BLE Verbindungen seit Start', type: 'number', role: 'value' });
        await this._ecoState(`${base}.info.lastDisconnect`, { name: 'Letzter Trennungsgrund', type: 'string', role: 'text' });
        await this._ecoState(`${base}.info.lastUpdate`, { name: 'Letzte Messwert-Aktualisierung', type: 'number', role: 'value.time' });
    }

    // ---------------------------------------------------------------- Geraet -> States
    async _ecoOnDeviceUpdate(devId, id, val) {
        if (this._ecoUnloaded) {
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
        if (obj && obj.command === 'listAdapters') {
            // Auswahlliste fuer die Einstellung "Bluetooth-Adapter"
            const adapters = await listAdapters();
            const options = [{ value: '', label: 'Automatisch (Standardadapter)' }];
            for (const a of adapters) {
                const extra = [a.address, a.bus].filter(Boolean).join(', ');
                options.push({ value: String(a.id), label: extra ? `${a.name} (${extra})` : a.name });
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, options, obj.callback);
            }
            return;
        }
        if (!obj || obj.command !== 'getUserId') {
            return;
        }
        const m = obj.message || {};
        let response;
        try {
            const userId = await fetchUserId({ identifier: m.email, password: m.password, region: m.region });
            this.log.info('EcoFlow User-ID erfolgreich ermittelt');
            // Dauerhaft im Adapter speichern - unabhaengig davon, ob das Formularfeld im Admin aktualisiert wird
            await this.setStateAsync('info.userId', { val: userId, ack: true });
            let text = `User-ID ${userId} ermittelt und gespeichert.`;
            const manual = String((this.config && this.config.userId) || '').trim();
            if (manual && manual !== userId) {
                text += ' Achtung: Die im Feld eingetragene, abweichende User-ID hat nach einem Neustart Vorrang.';
            }
            response = { result: text, native: { userId } };
            if (userId !== this._ecoUserId) {
                this._ecoUserId = userId;
                if (this._ecoDefs && this._ecoDefs.length) {
                    // erst antworten, dann (neu) starten
                    setTimeout(() => void this._ecoStartDevices().catch(e => this.log.warn(`Start fehlgeschlagen: ${e.message}`)), 0);
                }
            }
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
        this._ecoUnloaded = true;
        try {
            if (this._ecoInitTimer) {
                clearTimeout(this._ecoInitTimer);
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
