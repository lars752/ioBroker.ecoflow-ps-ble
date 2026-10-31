'use strict';
/**
 * Laedt main.js gegen ein simuliertes @iobroker/adapter-core und einen simulierten PowerStream.
 * Prueft: Objekt-Anlage, Validierung, State->Geraet (setWatts etc.), Geraet->State (ack), info.connection.
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { FakePs, waitFor, sleep, SN, UID } = require('./fakeps');

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.name = options.name;
        this.namespace = `${options.name}.0`;
        this.config = FakeAdapter.nextConfig;
        this.objects = new Map();
        this.states = new Map();
        this.logs = [];
        const mk = lvl => m => this.logs.push(`${lvl}: ${m}`);
        this.log = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
    }
    async extendObjectAsync(id, obj) {
        this.objects.set(`${this.namespace}.${id}`, { ...(this.objects.get(`${this.namespace}.${id}`) || {}), ...obj });
    }
    _put(id, st) {
        const full = id.includes(this.namespace) ? id : `${this.namespace}.${id}`;
        const s = typeof st === 'object' && st !== null && 'val' in st ? st : { val: st, ack: false };
        this.states.set(full, s);
    }
    async setStateAsync(id, st, ack) {
        this._put(id, typeof st === 'object' && st !== null ? st : { val: st, ack: !!ack });
    }
    async setStateChangedAsync(id, st) {
        this._put(id, st);
    }
    subscribeStates() {}
    sendTo(to, cmd, msg, cb) {
        this.sent = { to, cmd, msg, cb };
    }
    val(id) {
        const s = this.states.get(`${this.namespace}.${id}`);
        return s && s.val;
    }
    ack(id) {
        const s = this.states.get(`${this.namespace}.${id}`);
        return s && s.ack;
    }
}

// @iobroker/adapter-core ersetzen
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') {
        return { Adapter: FakeAdapter };
    }
    return origLoad.call(this, request, ...rest);
};
const { BleManager } = require('../lib/ble');
const createAdapter = require('../main.js');

function withFakePs(ps) {
    const ble = ps.makeBle();
    BleManager.prototype.init = async () => undefined;
    BleManager.prototype.connect = mac => ble.connect(mac);
    BleManager.prototype.shutdown = async () => undefined;
}

const baseCfg = () => ({
    userId: UID,
    devices: [{ enabled: true, id: 'PS1', sn: SN, mac: 'AA-BB-CC-DD-EE-FF' }],
    minWatts: 0,
    maxWatts: 800,
    startWatts: 0,
    toleranceW: 5,
    writeGraceS: 1,
    telemetryS: 1,
    retryS: 2,
    allSensors: false,
});

async function unload(a) {
    await new Promise(res => a.onUnload(res));
}

test('Start: Objekte, Verbindung, Telemetrie, Sollwert ueber State, Ack, info.connection', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    withFakePs(ps);
    FakeAdapter.nextConfig = baseCfg();
    const a = createAdapter();
    await a.onReady();
    try {
        // Objekte
        for (const id of ['PS1', 'PS1.control.setWatts', 'PS1.control.brightness', 'PS1.control.supplyMode', 'PS1.control.reconnect', 'PS1.telemetry.bat_soc', 'PS1.telemetry.permanent_watts', 'PS1.info.link']) {
            assert.ok(a.objects.has(`${a.namespace}.${id}`), `Objekt ${id} fehlt`);
        }
        assert.ok(!a.objects.has(`${a.namespace}.PS1.telemetry.inv_temp`), 'versteckte Sensoren nur auf Wunsch');
        assert.strictEqual(a.objects.get(`${a.namespace}.PS1.control.setWatts`).common.max, 800);
        assert.strictEqual(a.objects.get(`${a.namespace}.PS1`).native.mac, 'aa:bb:cc:dd:ee:ff');

        await waitFor(() => a.val('info.connection') === true);
        await waitFor(() => a.val('PS1.telemetry.bat_soc') === 87, 5000);
        assert.strictEqual(a.val('PS1.telemetry.inv_volt_in'), 230.12);
        assert.strictEqual(a.val('PS1.info.link'), true);
        assert.strictEqual(a.ack('PS1.telemetry.bat_soc'), true);

        // Sollwert setzen (ack=false vom Nutzer) -> wird gerundet, bestaetigt und ans Geraet geschrieben
        await a.onStateChange(`${a.namespace}.PS1.control.setWatts`, { val: 203, ack: false });
        await waitFor(() => a.val('PS1.control.setWatts') === 205);
        assert.strictEqual(a.ack('PS1.control.setWatts'), true);
        await waitFor(() => ps.writes.some(w => w.cmdId === 0x81 && w.value === 2050));

        // Ack-Aenderungen werden ignoriert, fremde States ebenfalls
        const n = ps.writes.length;
        await a.onStateChange(`${a.namespace}.PS1.control.setWatts`, { val: 400, ack: true });
        await a.onStateChange(`${a.namespace}.PS1.telemetry.bat_soc`, { val: 1, ack: false });
        await a.onStateChange(`${a.namespace}.PS9.control.setWatts`, { val: 400, ack: false });
        await sleep(100);
        assert.strictEqual(ps.writes.length, n);

        // Helligkeit / Supply
        await a.onStateChange(`${a.namespace}.PS1.control.brightness`, { val: 30, ack: false });
        await a.onStateChange(`${a.namespace}.PS1.control.supplyMode`, { val: 1, ack: false });
        await waitFor(() => ps.writes.some(w => w.cmdId === 0x87) && ps.writes.some(w => w.cmdId === 0x82));

        // Button "reconnect"
        await a.onStateChange(`${a.namespace}.PS1.control.reconnect`, { val: true, ack: false });
        await waitFor(() => a.val('PS1.info.link') === false);
        assert.strictEqual(a.val('PS1.control.reconnect'), false);
        await waitFor(() => a.val('PS1.info.link') === true, 6000);
    } finally {
        await unload(a);
        ps.stop();
    }
    assert.strictEqual(a.val('info.connection'), false);
});

test('Ungueltige Konfiguration: kein Start, klare Fehlermeldungen', async () => {
    const ps = new FakePs();
    withFakePs(ps);
    FakeAdapter.nextConfig = {
        ...baseCfg(),
        devices: [
            { enabled: true, id: 'bad id', sn: SN, mac: 'aa:bb:cc:dd:ee:ff' },
            { enabled: true, id: 'X', sn: '', mac: 'aa:bb:cc:dd:ee:ff' },
            { enabled: true, id: 'Y', sn: SN, mac: 'nope' },
            { enabled: false, id: 'Z', sn: SN, mac: 'aa:bb:cc:dd:ee:ff' },
        ],
    };
    const a = createAdapter();
    await a.onReady();
    assert.strictEqual(a.devices.size, 0);
    const errs = a.logs.filter(l => l.startsWith('error')).join('\n');
    assert.match(errs, /bad id/);
    assert.match(errs, /Seriennummer fehlt/);
    assert.match(errs, /ungueltig/);
    await unload(a);

    FakeAdapter.nextConfig = { ...baseCfg(), userId: '' };
    const b = createAdapter();
    await b.onReady();
    assert.match(b.logs.join('\n'), /User-ID/);
    await unload(b);
});

test('Bluetooth nicht verfuegbar: Fehler wird gemeldet, Adapter laeuft weiter (Retry)', async () => {
    const ps = new FakePs();
    withFakePs(ps);
    BleManager.prototype.init = async () => {
        throw new Error('kein Adapter');
    };
    FakeAdapter.nextConfig = baseCfg();
    const a = createAdapter();
    await a.onReady();
    assert.match(a.logs.join('\n'), /Bluetooth nicht verfuegbar: kein Adapter/);
    assert.strictEqual(a.val('info.connection'), false);
    await unload(a); // raeumt den Retry-Timer weg
});

test('Admin-Nachricht getUserId: liefert User-ID, Fehler werden gemeldet, Passwort wird nicht geloggt', async () => {
    const ps = new FakePs();
    withFakePs(ps);
    FakeAdapter.nextConfig = baseCfg();
    const a = createAdapter();
    const realFetch = globalThis.fetch;
    try {
        globalThis.fetch = async (url, init) => {
            const b = JSON.parse(init.body);
            return {
                ok: true,
                status: 200,
                json: async () =>
                    b.password === Buffer.from('geheim').toString('base64')
                        ? { code: '0', data: { user: { userId: '99887766' } } }
                        : { code: '2026', message: 'Password is incorrect' },
            };
        };
        await a.onMessage({ command: 'getUserId', from: 'system.adapter.admin.0', callback: 1, message: { email: 'me@example.com', password: 'geheim', region: 'api-e' } });
        assert.deepStrictEqual(a.sent.msg, { result: 'User-ID: 99887766', native: { userId: '99887766' } });
        await a.onMessage({ command: 'getUserId', from: 'x', callback: 2, message: { email: 'me@example.com', password: 'falsch', region: 'api-e' } });
        assert.deepStrictEqual(a.sent.msg, { error: 'Password is incorrect' });
        await a.onMessage({ command: 'getUserId', from: 'x', callback: 3, message: { email: '', password: '' } });
        assert.match(a.sent.msg.error, /eingeben/);
        await a.onMessage({ command: 'andere', from: 'x', callback: 4, message: {} });
        assert.strictEqual(a.sent.cb, 3, 'unbekannte Kommandos werden ignoriert');
        assert.ok(!a.logs.join('\n').includes('geheim') && !a.logs.join('\n').includes('falsch'));
    } finally {
        globalThis.fetch = realFetch;
    }
});
