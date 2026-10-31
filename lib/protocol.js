'use strict';
/**
 * EcoFlow PowerStream - BLE-Protokoll (1:1-Port aus ps-esp-ble-bridge V2.6.3).
 * Reine Funktionen/Klassen ohne I/O -> vollstaendig testbar.
 *
 * Quelle der Protokoll-Details: ESP32-Firmware von Just-Zuul, die ihrerseits auf der
 * Reverse-Engineering-Arbeit von rabits/ha-ef-ble beruht.
 */
const crypto = require('node:crypto');

const SVC_UUID = '00000001-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '00000002-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '00000003-0000-1000-8000-00805f9b34fb';

// Adressierung / Kommandos (siehe Firmware: "nur verifizierte Werte")
const SRC_APP = 0x21;
const DST_PS = 0x35;
const CMD = {
    AUTH_STATUS: { set: 0x35, id: 0x89 },
    AUTH: { set: 0x35, id: 0x86 },
    SET_LOAD: { set: 0x14, id: 0x81 }, // permanent_watts, Wert * 10
    SET_SUPPLY: { set: 0x14, id: 0x82 }, // 0 = supply, 1 = storage
    SET_BRIGHT: { set: 0x14, id: 0x87 }, // 0..1023
    HEARTBEAT: { set: 0x14, id: 0x01 },
};

function md5(buf) {
    return crypto.createHash('md5').update(buf).digest();
}

/** CRC-8, Polynom 0x07, Init 0 */
function crc8(buf) {
    let c = 0;
    for (const b of buf) {
        c ^= b;
        for (let i = 0; i < 8; i++) {
            c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
        }
    }
    return c;
}

/** CRC-16/ARC (Polynom 0xA001 reflected), Init 0 */
function crc16(buf) {
    let c = 0;
    for (const b of buf) {
        c ^= b;
        for (let i = 0; i < 8; i++) {
            c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1;
        }
    }
    return c & 0xffff;
}

function varint(n) {
    const out = [];
    n = n >>> 0;
    for (;;) {
        const b = n & 0x7f;
        n >>>= 7;
        out.push(n ? b | 0x80 : b);
        if (!n) {
            break;
        }
    }
    return Buffer.from(out);
}

/** Klartext-Paket (vor Verschluesselung) */
function buildPacket({ src, dst, cmdSet, cmdId, payload, ver, dsrc = 0, ddst = 0 }) {
    payload = payload || Buffer.alloc(0);
    const head = [0xaa, ver, payload.length & 0xff, (payload.length >> 8) & 0xff];
    const bytes = [...head, crc8(Buffer.from(head)), 0x0d, 0, 0, 0, 0, 0, 0, src, dst];
    if (ver >= 3) {
        bytes.push(dsrc, ddst);
    }
    bytes.push(cmdSet, cmdId);
    const buf = Buffer.concat([Buffer.from(bytes), payload]);
    const c = crc16(buf);
    return Buffer.concat([buf, Buffer.from([c & 0xff, c >> 8])]);
}

/** Erwartete Gesamtlaenge eines (verschluesselten) Frames anhand des Headers. */
function expectedFrameLength(data) {
    if (data.length < 4) {
        return Infinity;
    }
    const ver = data[1];
    const payLen = data[2] | (data[3] << 8);
    const bodyLen = (ver >= 3 ? 15 : 13) + payLen;
    return 5 + Math.ceil(bodyLen / 16) * 16;
}

/**
 * Protobuf-Walker: speichert ALLE Varint-Felder (Feldnummer < 64) als int32.
 * Andere Wire-Types werden uebersprungen. Entspricht pbExtractAll() der Firmware.
 *
 * @param {Buffer} d
 * @returns {Record<number, number>}
 */
function pbExtractAll(d) {
    const fields = {};
    let i = 0;
    const readVarint = () => {
        let v = 0n;
        let sh = 0n;
        while (i < d.length) {
            const b = d[i++];
            v |= BigInt(b & 0x7f) << sh;
            if (!(b & 0x80)) {
                break;
            }
            sh += 7n;
            if (sh > 63n) {
                break;
            }
        }
        return v;
    };
    while (i < d.length) {
        const tag = readVarint();
        if (tag === 0n && i >= d.length) {
            break;
        }
        const fn = Number((tag >> 3n) & 0xffffffffn);
        const wt = Number(tag & 7n);
        if (wt === 0) {
            const v = readVarint();
            if (fn < 64) {
                fields[fn] = Number(BigInt.asIntN(32, v));
            }
        } else if (wt === 1) {
            i += 8;
        } else if (wt === 2) {
            // bewusst zwei Schritte: "i += readVarint()" wuerde i VOR dem Aufruf auswerten
            const len = Number(readVarint());
            i += len;
        } else if (wt === 5) {
            i += 4;
        } else {
            break;
        }
    }
    return fields;
}

/** Sitzungs-Krypto + Frame-Bau/-Auswertung fuer genau ein Geraet (Seriennummer). */
class Session {
    /**
     * @param {string} sn Seriennummer des PowerStream
     * @param {string} userId EcoFlow User-ID
     */
    constructor(sn, userId) {
        this.sn = String(sn);
        this.userId = String(userId);
        this.key = md5(Buffer.from(this.sn));
        this.iv = md5(Buffer.from([...this.sn].reverse().join('')));
    }

    _aes(encrypt, buf) {
        const fn = encrypt ? crypto.createCipheriv : crypto.createDecipheriv;
        const c = fn('aes-128-cbc', this.key, this.iv); // IV wird pro Frame neu gesetzt (nicht verkettet)
        c.setAutoPadding(false);
        return Buffer.concat([c.update(buf), c.final()]);
    }

    /** Kopf (5 Byte) im Klartext, Rest AES-128-CBC, Null-Padding auf 16 */
    encryptFrame(pkt) {
        const body = pkt.subarray(5);
        const padded = Buffer.alloc(Math.ceil(body.length / 16) * 16);
        body.copy(padded);
        return Buffer.concat([pkt.subarray(0, 5), this._aes(true, padded)]);
    }

    frameAuthStatus() {
        return this.encryptFrame(
            buildPacket({
                src: SRC_APP,
                dst: DST_PS,
                cmdSet: CMD.AUTH_STATUS.set,
                cmdId: CMD.AUTH_STATUS.id,
                ver: 3,
                dsrc: 1,
                ddst: 1,
            }),
        );
    }

    frameAutoAuth() {
        const hash = md5(Buffer.from(this.userId + this.sn))
            .toString('hex')
            .toUpperCase();
        return this.encryptFrame(
            buildPacket({
                src: SRC_APP,
                dst: DST_PS,
                cmdSet: CMD.AUTH.set,
                cmdId: CMD.AUTH.id,
                payload: Buffer.from(hash, 'ascii'),
                ver: 2,
            }),
        );
    }

    _frameSetVarint(cmd, value) {
        const payload = Buffer.concat([Buffer.from([0x08]), varint(value)]);
        return this.encryptFrame(
            buildPacket({ src: SRC_APP, dst: DST_PS, cmdSet: cmd.set, cmdId: cmd.id, payload, ver: 0x13 }),
        );
    }

    /** Einspeise-Sollwert in Watt (ganzzahlig) */
    frameSetLoad(watts) {
        return this._frameSetVarint(CMD.SET_LOAD, Math.round(watts * 10));
    }

    /** Helligkeit als Rohwert 0..1023 */
    frameSetBright(bits) {
        return this._frameSetVarint(CMD.SET_BRIGHT, bits);
    }

    /** 0 = Prioritize power supply, 1 = Prioritize power storage */
    frameSetSupply(val) {
        return this._frameSetVarint(CMD.SET_SUPPLY, val);
    }

    /**
     * Entschluesselt eine Notification und ordnet sie ein.
     *
     * @param {Buffer} data
     * @returns {null | {type:'auth', ok:boolean, code:number} | {type:'heartbeat', fields:Record<number,number>} | {type:'other', src:number, cmdSet:number, cmdId:number}}
     */
    parseNotify(data) {
        if (data.length < 5 || data[0] !== 0xaa) {
            return null;
        }
        const ver = data[1];
        const payLen = data[2] | (data[3] << 8);
        const bl = data.length - 5;
        const al = bl - (bl % 16);
        if (al === 0) {
            return null;
        }
        const dec = this._aes(false, data.subarray(5, 5 + al));
        if (dec.length < 13) {
            return null;
        }
        const src = dec[7];
        let cmdSet;
        let cmdId;
        let po;
        if (ver >= 3) {
            cmdSet = dec[11];
            cmdId = dec[12];
            po = 13;
        } else {
            cmdSet = dec[9];
            cmdId = dec[10];
            po = 11;
        }
        if (src === DST_PS && cmdSet === CMD.AUTH.set && cmdId === CMD.AUTH.id) {
            return { type: 'auth', ok: dec[po] === 0x00, code: dec[po] };
        }
        if (src === DST_PS && cmdSet === CMD.HEARTBEAT.set && cmdId === CMD.HEARTBEAT.id) {
            const avail = dec.length > po ? dec.length - po : 0;
            const n = Math.min(payLen, avail);
            if (n < 4) {
                return null;
            }
            const pl = Buffer.from(dec.subarray(po, po + n));
            const x = dec[1]; // seq[0] als XOR-Maske
            if (x) {
                for (let k = 0; k < n; k++) {
                    pl[k] ^= x;
                }
            }
            return { type: 'heartbeat', fields: pbExtractAll(pl) };
        }
        return { type: 'other', src, cmdSet, cmdId };
    }
}

module.exports = {
    SVC_UUID,
    WRITE_UUID,
    NOTIFY_UUID,
    CMD,
    SRC_APP,
    DST_PS,
    md5,
    crc8,
    crc16,
    varint,
    buildPacket,
    expectedFrameLength,
    pbExtractAll,
    Session,
};
