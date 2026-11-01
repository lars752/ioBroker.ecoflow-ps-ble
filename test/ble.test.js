'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkLinuxBluetooth, BleManager, resetController } = require('../lib/ble');

const fsWith = ({ adapters = ['hci0'], capEff = '0000000000002000', noSys = false } = {}) => ({
    readdirSync: () => {
        if (noSys) {
            throw new Error('ENOENT');
        }
        return adapters;
    },
    readFileSync: () => `Name:\tnode\nCapEff:\t${capEff}\nCapBnd:\t000001ffffffffff\n`,
});

test('Vorabpruefung: alles vorhanden -> kein Problem', () => {
    assert.strictEqual(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs: fsWith() }), null);
});

test('Vorabpruefung: root braucht keine Capability', () => {
    assert.strictEqual(checkLinuxBluetooth({ platform: 'linux', uid: 0, fs: fsWith({ capEff: '0' }) }), null);
});

test('Vorabpruefung: cap_net_raw fehlt -> Hinweis mit setcap', () => {
    const r = checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs: fsWith({ capEff: '0000000000000000' }) });
    assert.match(r, /setcap cap_net_raw\+eip/);
});

test('Vorabpruefung: kein Adapter / kein /sys-Eintrag', () => {
    assert.match(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs: fsWith({ adapters: [] }) }), /Kein Bluetooth-Adapter/);
    assert.match(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs: fsWith({ noSys: true }) }), /Kein Bluetooth-Adapter/);
});

test('Vorabpruefung: andere Plattformen und USB-Modus werden nicht blockiert', () => {
    assert.strictEqual(checkLinuxBluetooth({ platform: 'win32', fs: fsWith({ noSys: true }) }), null);
    assert.strictEqual(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs: fsWith({ noSys: true }), env: { BLUETOOTH_HCI_SOCKET_USB_VID: '0a12' } }), null);
});

test('BleManager.init: bei Problem wird noble gar nicht erst geladen, sondern ein Fehler geworfen', async () => {
    const m = new BleManager({ preflight: () => 'Berechtigung fehlt' });
    await assert.rejects(() => m.init(), /Berechtigung fehlt/);
});

const { parseHciconfig, listAdapters } = require('../lib/ble');

const HCICONFIG = `hci0:   Type: Primary  Bus: USB
        BD Address: 3C:6A:D2:B5:78:24  ACL MTU: 1021:5  SCO MTU: 255:11
        UP RUNNING
        RX bytes:1667 acl:0 sco:0 events:181 errors:0
        TX bytes:34596 acl:0 sco:0 commands:182 errors:0

hci1:   Type: Primary  Bus: UART
        BD Address: DC:A6:32:00:11:22  ACL MTU: 1021:8  SCO MTU: 64:1
        DOWN
`;

test('hciconfig-Ausgabe wird geparst (mehrere Adapter, MAC, Bus)', () => {
    assert.deepStrictEqual(parseHciconfig(HCICONFIG), [
        { id: 0, name: 'hci0', type: 'Primary', bus: 'USB', address: '3C:6A:D2:B5:78:24' },
        { id: 1, name: 'hci1', type: 'Primary', bus: 'UART', address: 'DC:A6:32:00:11:22' },
    ]);
});

test('listAdapters: nutzt hciconfig, sonst /sys-Fallback, sonst leere Liste', async () => {
    const ok = await listAdapters({ execFile: (cmd, args, opts, cb) => cb(null, HCICONFIG) });
    assert.deepStrictEqual(ok.map(a => a.name), ['hci0', 'hci1']);
    const noExec = (cmd, args, opts, cb) => cb(new Error('ENOENT'));
    const viaSys = await listAdapters({ execFile: noExec, fs: { readdirSync: () => ['hci1', 'hci0', 'rfkill'] } });
    assert.deepStrictEqual(viaSys, [{ id: 0, name: 'hci0' }, { id: 1, name: 'hci1' }]);
    const none = await listAdapters({ execFile: noExec, fs: { readdirSync: () => { throw new Error('x'); } } });
    assert.deepStrictEqual(none, []);
});

test('Vorabpruefung: gewaehlter Adapter existiert nicht', () => {
    const fs = { readdirSync: () => ['hci0'], readFileSync: () => 'CapEff:\t0000000000002000\n' };
    assert.match(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs, hciDevice: 1 }), /hci1 existiert nicht \(vorhanden: hci0\)/);
    assert.strictEqual(checkLinuxBluetooth({ platform: 'linux', uid: 1000, fs, hciDevice: 0 }), null);
});

test('BleManager: gewaehlter Adapter wird vor dem Laden von noble als NOBLE_HCI_DEVICE_ID gesetzt', async () => {
    const before = process.env.NOBLE_HCI_DEVICE_ID;
    try {
        const m = new BleManager({ hciDevice: 1, preflight: () => null });
        await m.init().catch(() => undefined); // noble ist in der Testumgebung nicht installiert
        assert.strictEqual(process.env.NOBLE_HCI_DEVICE_ID, '1');
    } finally {
        if (before === undefined) {
            delete process.env.NOBLE_HCI_DEVICE_ID;
        } else {
            process.env.NOBLE_HCI_DEVICE_ID = before;
        }
    }
});

// ---------------------------------------------------------------- Controller-Reset
const fakeExec = handler => {
    const calls = [];
    const fn = (cmd, args, _opts, cb) => {
        calls.push([cmd, ...args].join(' '));
        const r = handler(cmd, args);
        if (r instanceof Error) {
            cb(r, '', r.stderr || '');
        } else {
            cb(null, '', '');
        }
    };
    fn.calls = calls;
    return fn;
};

test('resetController: hciconfig reset mit gewaehltem Adapter, danach up', async () => {
    const execFile = fakeExec(() => null);
    const r = await resetController({ platform: 'linux', execFile, hciDevice: 1 });
    assert.deepStrictEqual(r, { ok: true, method: 'hciconfig reset' });
    assert.deepStrictEqual(execFile.calls, ['hciconfig hci1 reset', 'hciconfig hci1 up']);
});

test('resetController: Standard ist hci0', async () => {
    const execFile = fakeExec(() => null);
    await resetController({ platform: 'linux', execFile, hciDevice: null });
    assert.strictEqual(execFile.calls[0], 'hciconfig hci0 reset');
});

test('resetController: ohne Rechte -> sudo -n, dann btmgmt', async () => {
    const denied = Object.assign(new Error('x'), { stderr: 'Reset failed: Operation not permitted' });
    let execFile = fakeExec(cmd => (cmd === 'hciconfig' ? denied : null));
    let r = await resetController({ platform: 'linux', execFile, hciDevice: 0 });
    assert.strictEqual(r.method, 'sudo hciconfig reset');
    assert.strictEqual(execFile.calls[1], 'sudo -n hciconfig hci0 reset');

    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    execFile = fakeExec(cmd => (cmd === 'hciconfig' || cmd === 'sudo' ? missing : null));
    r = await resetController({ platform: 'linux', execFile, hciDevice: 0 });
    assert.strictEqual(r.method, 'btmgmt power off/on');
    assert.deepStrictEqual(execFile.calls.slice(-2), ['btmgmt --index 0 power off', 'btmgmt --index 0 power on']);
});

test('resetController: alles scheitert -> ok=false mit Fehlertext; nicht-Linux wird uebersprungen', async () => {
    const execFile = fakeExec(() => new Error('kaputt'));
    const r = await resetController({ platform: 'linux', execFile });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /hciconfig reset: kaputt/);
    assert.deepStrictEqual(await resetController({ platform: 'win32', execFile }), { ok: false, skipped: 'nur unter Linux' });
});

test('BleManager.init: Reset laeuft einmal und vor dem Laden von noble; Fehler ist nicht fatal', async () => {
    const order = [];
    const logs = [];
    const mk = (resetFn, extra = {}) =>
        new BleManager({
            hciDevice: 0,
            preflight: () => {
                order.push('preflight');
                return null;
            },
            resetController: true,
            waitAfterResetMs: 0,
            resetFn,
            log: { info: m => logs.push(`info ${m}`), warn: m => logs.push(`warn ${m}`), debug: () => undefined },
            ...extra,
        });
    let calls = 0;
    const m = mk(async () => {
        calls++;
        order.push('reset');
        return { ok: true, method: 'hciconfig reset' };
    });
    // noble-Pakete sind in der Testumgebung nicht installiert -> init scheitert NACH dem Reset
    await assert.rejects(m.init(), /BLE-Bibliothek konnte nicht geladen werden/);
    await assert.rejects(m.init(), /BLE-Bibliothek/);
    assert.strictEqual(calls, 1, 'nur ein Reset pro Prozess');
    assert.deepStrictEqual(order.slice(0, 2), ['preflight', 'reset']);
    assert.ok(logs.some(l => /zurueckgesetzt \(hciconfig reset\)/.test(l)));

    const m2 = mk(async () => ({ ok: false, error: 'hciconfig reset: nicht erlaubt' }));
    await assert.rejects(m2.init(), /BLE-Bibliothek/);
    assert.ok(logs.some(l => /^warn .*nicht zurueckgesetzt werden/.test(l)));
});

test('BleManager.init: ohne Option kein Reset', async () => {
    let calls = 0;
    const m = new BleManager({ hciDevice: 0, preflight: () => null, resetController: false, resetFn: async () => ++calls });
    await assert.rejects(m.init(), /BLE-Bibliothek/);
    assert.strictEqual(calls, 0);
});
