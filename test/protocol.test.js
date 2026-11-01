'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const P = require('../lib/protocol');
const { SENSORS, scaleValue } = require('../lib/sensors');
const { SetpointController } = require('../lib/controller');

const SN = 'HW51ZOH4PS000000';
const UID = '0000000000000000000';

// ---- Referenzvektoren ----
test('Referenzvektoren: CRC8 / CRC16 / MD5 / AES', () => {
    assert.strictEqual(P.crc8(Buffer.from('123456789')), 0xf4);
    assert.strictEqual(P.crc16(Buffer.from('123456789')), 0xbb3d);
    assert.strictEqual(P.md5(Buffer.from('abc')).toString('hex'), '900150983cd24fb0d6963f7d28e17f72');
    const key = P.md5(Buffer.from('abc'));
    const iv = P.md5(Buffer.from('cba'));
    const c = crypto.createCipheriv('aes-128-cbc', key, iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(Buffer.alloc(16, 'A')), c.final()]);
    assert.strictEqual(ct.toString('hex'), 'f27b86b1dc9a9538743be06751cc3bc2');
});

test('varint', () => {
    assert.deepStrictEqual([...P.varint(0)], [0]);
    assert.deepStrictEqual([...P.varint(300)], [0xac, 0x02]);
    assert.deepStrictEqual([...P.varint(8000)], [0xc0, 0x3e]);
});

test('Schluessel/IV-Ableitung: key=MD5(SN), iv=MD5(reverse(SN))', () => {
    const s = new P.Session(SN, UID);
    assert.strictEqual(s.key.toString('hex'), P.md5(Buffer.from(SN)).toString('hex'));
    assert.strictEqual(s.iv.toString('hex'), P.md5(Buffer.from([...SN].reverse().join(''))).toString('hex'));
});

// ---- Hilfen: "PowerStream-Seite" simulieren ----
function psFrame(session, { cmdSet, cmdId, payload, ver = 3, seq0 = 0 }) {
    const pkt = P.buildPacket({ src: P.DST_PS, dst: P.SRC_APP, cmdSet, cmdId, payload, ver, dsrc: 1, ddst: 1 });
    // seq[0] (Byte 6 im Klartext-Paket) als XOR-Maske
    pkt[6] = seq0;
    return session.encryptFrame(pkt);
}
function pbVarintField(fn, value) {
    return Buffer.concat([P.varint(fn << 3), P.varint(value >>> 0)]);
}
function decryptOwn(session, frame) {
    const d = crypto.createDecipheriv('aes-128-cbc', session.key, session.iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(frame.subarray(5)), d.final()]);
}

test('Kommando-Frames: Header, CRCs, Payload korrekt', () => {
    const s = new P.Session(SN, UID);
    const f = s.frameSetLoad(150);
    assert.strictEqual(f[0], 0xaa);
    assert.strictEqual(f[1], 0x13);
    assert.strictEqual(f[2], 3); // Payload: 0x08 + varint(1500) = 3 Byte
    assert.strictEqual(f[4], P.crc8(f.subarray(0, 4)));
    assert.strictEqual((f.length - 5) % 16, 0);
    const dec = decryptOwn(s, f);
    assert.strictEqual(dec[0], 0x0d);
    assert.strictEqual(dec[7], 0x21); // src
    assert.strictEqual(dec[8], 0x35); // dst
    assert.strictEqual(dec[11], 0x14); // cmd_set
    assert.strictEqual(dec[12], 0x81); // cmd_id
    assert.deepStrictEqual([...dec.subarray(13, 16)], [0x08, ...P.varint(1500)]);
    // CRC16 ueber das Klartext-Paket: Paketlaenge = 20 + Payload (v3), Kopf im Klartext + entschluesselter Body
    const pkt = Buffer.concat([f.subarray(0, 5), dec]).subarray(0, 20 + 3);
    const crc = P.crc16(pkt.subarray(0, pkt.length - 2));
    assert.strictEqual(pkt[pkt.length - 2] | (pkt[pkt.length - 1] << 8), crc);
});

test('Auth-Frames: Auth-Hash = MD5(userId+SN) in Grossbuchstaben, ver=2', () => {
    const s = new P.Session(SN, UID);
    const a = s.frameAutoAuth();
    assert.strictEqual(a[1], 2);
    assert.strictEqual(a[2], 32);
    const dec = decryptOwn(s, a);
    assert.strictEqual(dec[9], 0x35);
    assert.strictEqual(dec[10], 0x86);
    const expected = crypto
        .createHash('md5')
        .update(UID + SN)
        .digest('hex')
        .toUpperCase();
    assert.strictEqual(dec.subarray(11, 11 + 32).toString('ascii'), expected);
    const st = s.frameAuthStatus();
    assert.strictEqual(st[1], 3);
    assert.strictEqual(st[2], 0);
    const d2 = decryptOwn(s, st);
    assert.strictEqual(d2[11], 0x35);
    assert.strictEqual(d2[12], 0x89);
});

test('Brightness/Supply: cmd_ids 0x87 / 0x82', () => {
    const s = new P.Session(SN, UID);
    assert.strictEqual(decryptOwn(s, s.frameSetBright(512))[12], 0x87);
    assert.strictEqual(decryptOwn(s, s.frameSetSupply(1))[12], 0x82);
});

test('Auth-Antwort wird erkannt (OK und Fehler)', () => {
    const s = new P.Session(SN, UID);
    const ok = s.parseNotify(psFrame(s, { cmdSet: 0x35, cmdId: 0x86, payload: Buffer.from([0x00]), ver: 3 }));
    assert.deepStrictEqual(ok, { type: 'auth', ok: true, code: 0 });
    const bad = s.parseNotify(psFrame(s, { cmdSet: 0x35, cmdId: 0x86, payload: Buffer.from([0x05]), ver: 2 }));
    assert.deepStrictEqual(bad, { type: 'auth', ok: false, code: 5 });
});

test('Heartbeat: Protobuf-Felder inkl. XOR-Maske und int32-Vorzeichen', () => {
    const s = new P.Session(SN, UID);
    const pb = Buffer.concat([
        pbVarintField(48, 1500), // permanent_watts 150.0 W
        pbVarintField(38, 1234), // inverter_output 123.4 W
        pbVarintField(29, -250), // Batterie-Fluss -25.0 W (negativ -> 10 Byte Varint in echtem proto; hier 32 Bit)
        pbVarintField(56, 512),
        pbVarintField(31, 87),
        // Feld mit Wire-Type 2 (Length-delimited) muss uebersprungen werden
        Buffer.concat([P.varint((7 << 3) | 2), P.varint(3), Buffer.from([1, 2, 3])]),
        pbVarintField(53, 1),
    ]);
    for (const seq0 of [0x00, 0x5a]) {
        const masked = Buffer.from(pb.map(b => b ^ seq0));
        const frame = psFrame(s, { cmdSet: 0x14, cmdId: 0x01, payload: masked, ver: 3, seq0 });
        const r = s.parseNotify(frame);
        assert.strictEqual(r.type, 'heartbeat');
        assert.strictEqual(r.fields[48], 1500);
        assert.strictEqual(r.fields[38], 1234);
        assert.strictEqual(r.fields[29], -250);
        assert.strictEqual(r.fields[56], 512);
        assert.strictEqual(r.fields[31], 87);
        assert.strictEqual(r.fields[53], 1);
        assert.strictEqual(r.fields[7], undefined);
    }
});

test('Heartbeat auch mit ver=2 (Offset 11)', () => {
    const s = new P.Session(SN, UID);
    const frame = psFrame(s, { cmdSet: 0x14, cmdId: 0x01, payload: pbVarintField(48, 400), ver: 2 });
    assert.strictEqual(s.parseNotify(frame).fields[48], 400);
});

test('expectedFrameLength stimmt mit echten Frames ueberein', () => {
    const s = new P.Session(SN, UID);
    for (const n of [1, 5, 20, 33, 100, 150]) {
        const payload = Buffer.alloc(n, 1);
        for (const ver of [2, 3, 0x13]) {
            const frame = psFrame(s, { cmdSet: 0x14, cmdId: 0x01, payload, ver });
            assert.strictEqual(P.expectedFrameLength(frame), frame.length, `n=${n} ver=${ver}`);
        }
    }
});

test('Muell wird ignoriert', () => {
    const s = new P.Session(SN, UID);
    assert.strictEqual(s.parseNotify(Buffer.from([1, 2, 3])), null);
    assert.strictEqual(s.parseNotify(Buffer.from([0xaa, 3, 0, 0, 0])), null);
});

test('Skalierung: Inverter input/100, op/10; PV input/10, op/100', () => {
    const by = k => SENSORS.find(x => x.key === k);
    assert.strictEqual(scaleValue(by('invInputVolt'), 23012), 230.12);
    assert.strictEqual(scaleValue(by('invOpVolt'), 2301), 230.1);
    assert.strictEqual(scaleValue(by('pv1InputVolt'), 345), 34.5);
    assert.strictEqual(scaleValue(by('pv1OpVolt'), 3456), 34.56);
    assert.strictEqual(scaleValue(by('invOutputCur'), 1234), 1.234);
    assert.strictEqual(scaleValue(by('batSoc'), 87), 87);
    assert.strictEqual(scaleValue(by('batInputWatts'), -250), -25);
    assert.strictEqual(scaleValue(by('ratedPower'), 800), 800, 'ratedPower: Faktor 1 wie ioBroker.ecoflow-mqtt');
    assert.strictEqual(scaleValue(by('batInputCur'), 1500), 1.5);
    assert.strictEqual(scaleValue(by('invOnOff'), 1), true);
    assert.strictEqual(scaleValue(by('invOnOff'), 0), false);
});

test('Sensor-Namen entsprechen dem inverter_heartbeat von ioBroker.ecoflow-mqtt', () => {
    const keys = SENSORS.map(s => s.key);
    for (const k of ['pv1InputVolt', 'pv2InputWatts', 'batSoc', 'invOutputWatts', 'permanentWatts', 'ratedPower', 'invOnOff', 'batChargingTime', 'batDischargingTime', 'lowerLimit', 'upperLimit', 'dynamicWatts']) {
        assert.ok(keys.includes(k), `${k} fehlt`);
    }
    assert.ok(keys.every(k => /^[a-z][A-Za-z0-9]*$/.test(k)), 'camelCase wie im ecoflow-mqtt-Adapter');
});

test('Sensor-Tabelle: keine doppelten Keys/Felder', () => {
    const keys = new Set(SENSORS.map(s => s.key));
    const fields = new Set(SENSORS.map(s => s.field));
    assert.strictEqual(keys.size, SENSORS.length);
    assert.strictEqual(fields.size, SENSORS.length);
});

// ---- Regel-Logik ----
function ctl(extra = {}) {
    let t = 0;
    const c = new SetpointController({
        minWatts: 0,
        maxWatts: 800,
        startWatts: 0,
        toleranceW: 5,
        graceMs: 6000,
        now: () => t,
        ...extra,
    });
    return { c, tick: ms => (t += ms) };
}

test('Controller: Sollwert wird kaufmaennisch auf ganze Watt gerundet', () => {
    const { c } = ctl();
    assert.deepStrictEqual([0, 0.4, 0.5, 1, 2, 3, 7, 8, 12, 13, 798, 799.6].map(w => c.setTarget(w)), [0, 0, 1, 1, 2, 3, 7, 8, 12, 13, 798, 800]);
});

test('Controller: Sollwert begrenzen und runden', () => {
    const { c } = ctl();
    assert.strictEqual(c.setTarget(-50), 0);
    assert.strictEqual(c.setTarget(1000), 800);
    assert.strictEqual(c.setTarget(203), 203);
    assert.strictEqual(c.setTarget(202.4), 202);
});

test('Controller: Ruhezustand schreibt nichts (auch beim Start nicht)', () => {
    const { c } = ctl();
    assert.strictEqual(c.decide(0), null);
    c.setTarget(200);
    assert.strictEqual(c.decide(200), null);
    assert.strictEqual(c.decide(198), null); // innerhalb Toleranz
});

test('Controller: neuer Sollwert wird geschrieben, danach nur gedrosselt re-asserted', () => {
    const { c, tick } = ctl();
    c.setTarget(200);
    assert.strictEqual(c.decide(0), 200);
    c.markWritten(200);
    assert.strictEqual(c.decide(0), null); // Karenz, Heartbeat zeigt noch alten Ist-Wert
    tick(6001);
    assert.strictEqual(c.decide(0), 200); // verschluckter Write -> selbstheilend
    c.markWritten(200);
    assert.strictEqual(c.decide(200), null);
    c.setTarget(300);
    assert.strictEqual(c.decide(200), 300); // geaenderter Soll: sofort, keine Karenz
});

test('Controller: ohne Ist-Wert oder ohne Startwert nichts tun', () => {
    const { c } = ctl();
    c.setTarget(200);
    assert.strictEqual(c.decide(null), null);
    const n = ctl({ startWatts: -1 }).c;
    assert.strictEqual(n.target, null);
    assert.strictEqual(n.decide(300), null);
    n.setTarget(100);
    assert.strictEqual(n.decide(300), 100);
});

test('Regelung ohne hold: nur gesetzte Sollwerte schreiben, nichts nachfuehren', () => {
    let t = 0;
    const c = new SetpointController({ minWatts: 0, maxWatts: 800, startWatts: 100, toleranceW: 5, graceMs: 6000, hold: false, now: () => t });
    // Startwert + Abweichung: kein Schreiben, der andere Adapter fuehrt den Wert
    assert.strictEqual(c.decide(0), null);
    // gesetzter Sollwert wird geschrieben, auch innerhalb der Karenzzeit
    c.setTarget(200);
    assert.strictEqual(c.decide(0), 200);
    c.markWritten(200);
    assert.strictEqual(c.decide(0), null, 'kein Re-Assert, wenn das Geraet abweicht');
    t += 100;
    c.setTarget(300);
    assert.strictEqual(c.decide(200), 300);
    c.markWritten(300);
    // Geraet hat den Wert schon -> nicht schreiben
    c.setTarget(300);
    assert.strictEqual(c.decide(300), null);
    assert.strictEqual(c.decide(0), null, 'danach nichts mehr nachfuehren');
    // Ist unbekannt -> warten
    c.setTarget(150);
    assert.strictEqual(c.decide(null), null);
    assert.strictEqual(c.decide(0), 150);
});

test('Regelung ohne hold: nicht bestaetigter Sollwert wird nach der Karenz wiederholt, hoechstens maxAttempts mal', () => {
    let t = 0;
    const c = new SetpointController({ minWatts: 0, maxWatts: 800, startWatts: 0, toleranceW: 5, graceMs: 1000, hold: false, maxAttempts: 3, now: () => t });
    c.setTarget(200);
    assert.strictEqual(c.decide(0), 200);
    c.markWritten(200);
    assert.strictEqual(c.decide(0), null, 'Karenz: auf Bestaetigung warten');
    t += 1000;
    assert.strictEqual(c.decide(0), 200, 'nicht bestaetigt -> Wiederholung');
    c.markWritten(200);
    t += 1000;
    assert.strictEqual(c.decide(0), 200);
    c.markWritten(200);
    t += 1000;
    assert.strictEqual(c.decide(0), null, 'nach maxAttempts keine weiteren Versuche');
    assert.strictEqual(c.gaveUp, true);
    c.retry();
    assert.strictEqual(c.gaveUp, false);
    assert.strictEqual(c.decide(0), 200, 'nach retry() wieder offen');
    c.markWritten(200);
    // Bestaetigung beendet alles
    assert.strictEqual(c.decide(200), null);
    assert.strictEqual(c.pending, false);
    t += 5000;
    assert.strictEqual(c.decide(0), null, 'danach wird nichts mehr nachgefuehrt');
});
