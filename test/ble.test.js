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
