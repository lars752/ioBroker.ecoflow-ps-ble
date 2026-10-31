'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkLinuxBluetooth, BleManager } = require('../lib/ble');

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
