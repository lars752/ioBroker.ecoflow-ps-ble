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
    async getStateAsync(id) {
        return this.states.get(`${this.namespace}.${id}`) || null;
    }
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
        for (const id of ['PS1', 'PS1.control.reconnect', 'PS1.inverter_heartbeat.batSoc', 'PS1.inverter_heartbeat.permanentWatts', 'PS1.inverter_heartbeat.invBrightness', 'PS1.inverter_heartbeat.supplyPriority', 'PS1.info.link']) {
            assert.ok(a.objects.has(`${a.namespace}.${id}`), `Objekt ${id} fehlt`);
        }
        assert.ok(!a.objects.has(`${a.namespace}.PS1.inverter_heartbeat.invTemp`), 'versteckte Sensoren nur auf Wunsch');
        assert.strictEqual(a.objects.get(`${a.namespace}.PS1.inverter_heartbeat.permanentWatts`).common.max, 800);
        assert.strictEqual(a.objects.get(`${a.namespace}.PS1.inverter_heartbeat.permanentWatts`).common.write, true);
        for (const old of ['setWatts', 'brightness', 'supplyMode']) {
            assert.ok(!a.objects.has(`${a.namespace}.PS1.control.${old}`), `alter Steuer-Datenpunkt control.${old} entfaellt`);
        }
        assert.strictEqual(a.objects.get(`${a.namespace}.PS1`).native.mac, 'aa:bb:cc:dd:ee:ff');

        await waitFor(() => a.val('info.connection') === true);
        await waitFor(() => a.val('PS1.inverter_heartbeat.batSoc') === 87, 5000);
        assert.strictEqual(a.val('PS1.inverter_heartbeat.invInputVolt'), 230.12);
        assert.strictEqual(a.val('PS1.info.link'), true);
        assert.strictEqual(a.ack('PS1.inverter_heartbeat.batSoc'), true);

        // Sollwert setzen (ack=false vom Nutzer) -> wird gerundet, bestaetigt und ans Geraet geschrieben
        await a.onStateChange(`${a.namespace}.PS1.inverter_heartbeat.permanentWatts`, { val: 203, ack: false });
        await waitFor(() => a.val('PS1.inverter_heartbeat.permanentWatts') === 205);
        assert.strictEqual(a.ack('PS1.inverter_heartbeat.permanentWatts'), true);
        await waitFor(() => ps.writes.some(w => w.cmdId === 0x81 && w.value === 2050));

        // Ack-Aenderungen werden ignoriert, fremde States ebenfalls
        const n = ps.writes.length;
        await a.onStateChange(`${a.namespace}.PS1.inverter_heartbeat.permanentWatts`, { val: 400, ack: true });
        await a.onStateChange(`${a.namespace}.PS1.inverter_heartbeat.batSoc`, { val: 1, ack: false });
        await a.onStateChange(`${a.namespace}.PS9.inverter_heartbeat.permanentWatts`, { val: 400, ack: false });
        await sleep(100);
        assert.strictEqual(ps.writes.length, n);

        // Helligkeit / Supply
        await a.onStateChange(`${a.namespace}.PS1.inverter_heartbeat.invBrightness`, { val: 30, ack: false });
        await a.onStateChange(`${a.namespace}.PS1.inverter_heartbeat.supplyPriority`, { val: true, ack: false });
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
    FakeAdapter.nextConfig = { ...baseCfg(), userId: '' };
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
        assert.deepStrictEqual(a.sent.msg, { result: 'User-ID 99887766 ermittelt und gespeichert.', native: { userId: '99887766' } });
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

test('Gespeicherte User-ID (info.userId) genuegt, wenn das Feld leer ist', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    withFakePs(ps);
    FakeAdapter.nextConfig = { ...baseCfg(), userId: '' };
    const a = createAdapter();
    a._put('info.userId', { val: UID, ack: true });
    await a.onReady();
    try {
        await waitFor(() => a.val('PS1.info.link') === true, 6000);
        assert.strictEqual(a.devices.size, 1);
    } finally {
        await unload(a);
        ps.stop();
    }
});

test('User-ID abrufen nach dem Start: wird gespeichert und die Geraete starten ohne Neustart', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    withFakePs(ps);
    FakeAdapter.nextConfig = { ...baseCfg(), userId: '' };
    const a = createAdapter();
    await a.onReady();
    assert.strictEqual(a.devices.size, 0, 'ohne User-ID kein Start');
    assert.match(a.logs.join('\n'), /warn: Noch keine EcoFlow User-ID/);
    const realFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: '0', data: { user: { userId: UID } } }) });
        await a.onMessage({ command: 'getUserId', from: 'x', callback: 1, message: { email: 'me@example.com', password: 'geheim', region: 'api-e' } });
        assert.match(a.sent.msg.result, new RegExp(`${UID} ermittelt und gespeichert`));
        assert.deepStrictEqual(a.sent.msg.native, { userId: UID });
        assert.strictEqual(a.val('info.userId'), UID);
        await waitFor(() => a.val('PS1.info.link') === true, 6000);
        assert.strictEqual(a.devices.size, 1);
    } finally {
        globalThis.fetch = realFetch;
        await unload(a);
        ps.stop();
    }
});

test('Eigene Instanzvariablen und Methoden tragen das Praefix _eco (Namenskollisionen mit der Adapter-Basisklasse vermeiden)', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
    const names = new Set([...src.matchAll(/this\.(_[A-Za-z]+)\b/g)].map(m => m[1]));
    for (const n of names) {
        assert.ok(n.startsWith('_eco'), `Eigenschaft ${n} koennte eine interne Eigenschaft der Basisklasse ueberschreiben`);
    }
    assert.ok(names.size > 0);
});

test('Admin-Nachricht listAdapters: Auswahlliste beginnt mit "Automatisch"', async () => {
    FakeAdapter.nextConfig = baseCfg();
    const a = createAdapter();
    await a.onMessage({ command: 'listAdapters', from: 'x', callback: 9, message: {} });
    assert.ok(Array.isArray(a.sent.msg));
    assert.deepStrictEqual(a.sent.msg[0], { value: '', label: 'Automatisch (Standardadapter)' });
    for (const o of a.sent.msg) {
        assert.strictEqual(typeof o.value, 'string');
    }
});

test('User-ID abrufen: leeres Formular -> gespeicherte Zugangsdaten (E-Mail, Passwort, Region) werden verwendet', async () => {
    withFakePs(new FakePs());
    FakeAdapter.nextConfig = { ...baseCfg(), userId: '', devices: [], loginEmail: 'me@example.com', loginPassword: 'geheim', loginRegion: 'api-e' };
    const a = createAdapter();
    const realFetch = globalThis.fetch;
    const bodies = [];
    try {
        globalThis.fetch = async (url, opts) => {
            bodies.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, json: async () => ({ code: '0', data: { user: { userId: UID } } }) };
        };
        // Admin ersetzt nicht aufgeloeste Platzhalter nicht immer durch '' -> beides muss funktionieren
        await a.onMessage({ command: 'getUserId', from: 'x', callback: 1, message: { email: '${data.loginEmail}', password: '', region: '' } });
        assert.match(a.sent.msg.result, new RegExp(`${UID} ermittelt`));
        assert.match(bodies[0].url, /api-e/);
        assert.strictEqual(bodies[0].body.email, 'me@example.com');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('Start: ermittelte User-ID aus info.userId wird einmalig in die Instanzeinstellungen uebernommen', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    withFakePs(ps);
    FakeAdapter.nextConfig = { ...baseCfg(), userId: '' };
    const a = createAdapter();
    const writes = [];
    a.extendForeignObjectAsync = async (id, obj) => void writes.push({ id, obj });
    a._put('info.userId', { val: UID, ack: true });
    await a.onReady();
    try {
        assert.deepStrictEqual(writes, [{ id: `system.adapter.${a.namespace}`, obj: { native: { userId: UID } } }]);
    } finally {
        await unload(a);
        ps.stop();
    }
    // Ist die ID schon eingetragen, wird nichts geschrieben
    const ps2 = new FakePs();
    ps2.startHeartbeats();
    withFakePs(ps2);
    FakeAdapter.nextConfig = baseCfg();
    const b = createAdapter();
    const writes2 = [];
    b.extendForeignObjectAsync = async (id, obj) => void writes2.push({ id, obj });
    await b.onReady();
    try {
        assert.strictEqual(writes2.length, 0);
    } finally {
        await unload(b);
        ps2.stop();
    }
});

test('Admin-Konfiguration: Zugangsdaten sind gespeicherte Felder, Passwort verschluesselt und sichtbar schaltbar', () => {
    const items = require('../admin/jsonConfig.json').items;
    const pkg = require('../io-package.json');
    for (const k of ['loginEmail', 'loginPassword', 'loginRegion', 'userId']) {
        assert.ok(items[k], `Feld ${k} fehlt`);
        assert.ok(!k.startsWith('_'), 'Felder mit Unterstrich werden nicht gespeichert');
        assert.ok(k in pkg.native, `native.${k} fehlt`);
    }
    assert.strictEqual(items.loginPassword.type, 'password');
    assert.strictEqual(items.loginPassword.visible, true);
    assert.deepStrictEqual(pkg.common.encryptedNative, ['loginPassword']);
});
