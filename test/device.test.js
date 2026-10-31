'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PowerStreamDevice } = require('../lib/device');
const { FakePs, sleep, waitFor, SN, UID } = require('./fakeps');

function makeDevice(ps, extra = {}) {
    const updates = {};
    const logs = [];
    const dev = new PowerStreamDevice({
        id: 'WR0',
        sn: SN,
        mac: 'aa:bb:cc:dd:ee:ff',
        userId: UID,
        ble: ps.makeBle(),
        options: { retryMs: 60, controlCheckMs: 50, telemetryMs: 30, statusMs: 80, authTimeoutMs: 1500, ...extra },
        log: {
            debug: m => logs.push(m),
            info: m => logs.push(m),
            warn: m => logs.push(`WARN ${m}`),
            error: m => logs.push(`ERR ${m}`),
        },
    });
    dev.on('update', (id, v) => (updates[id] = v));
    return { dev, updates, logs };
}

test('Verbindung, Auth, Telemetrie und write-on-change', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    const { dev, updates } = makeDevice(ps);
    dev.start();
    try {
        await waitFor(() => updates['info.link'] === true);
        await waitFor(() => updates['inverter_heartbeat.batSoc'] !== undefined);
        assert.strictEqual(updates['inverter_heartbeat.batSoc'], 87);
        assert.strictEqual(updates['inverter_heartbeat.invOutputWatts'], 120);
        assert.strictEqual(updates['inverter_heartbeat.invInputVolt'], 230.12);
        assert.strictEqual(updates['inverter_heartbeat.invOnOff'], true);
        assert.strictEqual(updates['inverter_heartbeat.permanentWatts'], 0);
        assert.strictEqual(updates['inverter_heartbeat.invBrightness'], 100);
        assert.strictEqual(updates['inverter_heartbeat.supplyPriority'], false);
        assert.strictEqual(updates['info.bleRssi'], -61);
        assert.ok(updates['info.lastUpdate'] > 0);

        // Ruhezustand: Ist (0) == Soll (0) -> kein Write
        await sleep(300);
        assert.strictEqual(ps.writes.length, 0, 'beim Start darf nichts geschrieben werden');

        // neuer Sollwert: 203 -> 205 W, genau EIN Write
        assert.strictEqual(dev.setTarget(203), 205);
        await waitFor(() => ps.writes.length >= 1);
        await sleep(400);
        assert.deepStrictEqual(ps.writes, [{ cmdId: 0x81, value: 2050 }]);
        await waitFor(() => updates['inverter_heartbeat.permanentWatts'] === 205);

        // Helligkeit + Supply-Mode
        dev.setBrightness(50);
        dev.setSupplyMode(1);
        await waitFor(() => ps.writes.length >= 3);
        assert.deepStrictEqual(ps.writes.slice(1), [
            { cmdId: 0x87, value: 500 },
            { cmdId: 0x82, value: 1 },
        ]);
    } finally {
        await dev.stop();
        ps.stop();
    }
});

test('Reconnect nach Funkabbruch: Helligkeit/Supply werden erneut gesetzt, Sollwert nicht', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    const { dev, updates } = makeDevice(ps);
    dev.start();
    try {
        await waitFor(() => updates['info.link'] === true);
        dev.setTarget(300);
        dev.setBrightness(40);
        await waitFor(() => ps.writes.length >= 2);
        const before = ps.writes.length;
        ps.dropLink();
        await waitFor(() => updates['info.link'] === false);
        await waitFor(() => updates['info.link'] === true);
        assert.strictEqual(ps.connections, 2);
        await waitFor(() => ps.writes.length > before);
        await sleep(300);
        const after = ps.writes.slice(before);
        assert.deepStrictEqual(after, [{ cmdId: 0x87, value: 400 }]);
        assert.strictEqual(updates['info.bleReconnects'], 2);
    } finally {
        await dev.stop();
        ps.stop();
    }
});

test('Selbstheilung: verschluckter Write wird nach Karenz erneut gesendet', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    // erster Sollwert-Write wird "verschluckt"
    const orig = ps.onWrite.bind(ps);
    let swallowed = false;
    ps.onWrite = frame => {
        const before = ps.perm;
        orig(frame);
        if (!swallowed && ps.writes.length === 1) {
            swallowed = true;
            ps.perm = before;
        }
    };
    const { dev, updates } = makeDevice(ps, { writeGraceMs: 200 });
    dev.start();
    try {
        await waitFor(() => updates['info.link'] === true);
        dev.setTarget(150);
        await waitFor(() => ps.writes.length >= 2, 3000);
        assert.strictEqual(ps.writes[1].value, 1500);
        await waitFor(() => updates['inverter_heartbeat.permanentWatts'] === 150);
    } finally {
        await dev.stop();
        ps.stop();
    }
});

test('Fragmentierte Notifications (20-Byte-Stuecke) werden zusammengesetzt', async () => {
    const ps = new FakePs({ chunk: 20 });
    ps.startHeartbeats();
    const { dev, updates } = makeDevice(ps);
    dev.start();
    try {
        await waitFor(() => updates['info.link'] === true);
        await waitFor(() => updates['inverter_heartbeat.batSoc'] === 87);
        assert.strictEqual(updates['inverter_heartbeat.invInputVolt'], 230.12);
    } finally {
        await dev.stop();
        ps.stop();
    }
});

test('AUTH FAIL: kein Link, Fehlermeldung, erneuter Versuch', async () => {
    const ps = new FakePs({ authCode: 5 });
    ps.startHeartbeats();
    const { dev, updates, logs } = makeDevice(ps);
    dev.start();
    try {
        await waitFor(() => ps.connections >= 2, 4000);
        assert.notStrictEqual(updates['info.link'], true);
        assert.ok(logs.some(l => l.includes('AUTH FAIL 0x05')), logs.join('\n'));
        assert.ok(updates['info.lastDisconnect'].includes('AUTH FAIL'));
    } finally {
        await dev.stop();
        ps.stop();
    }
});

test('stop() beendet sauber und setzt den Link auf false', async () => {
    const ps = new FakePs();
    ps.startHeartbeats();
    const { dev, updates } = makeDevice(ps);
    dev.start();
    await waitFor(() => updates['info.link'] === true);
    await dev.stop();
    ps.stop();
    assert.strictEqual(updates['info.link'], false);
    assert.strictEqual(updates['info.status'], 'gestoppt');
});
