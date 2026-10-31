'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const P = require('../lib/protocol');
const { PowerStreamDevice } = require('../lib/device');
const { nobleUuid } = require('../lib/ble');

const SN = 'HW51ZOH4PS000000';
const UID = '0000000000000000000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pbField(fn, value) {
    return Buffer.concat([P.varint(fn << 3), P.varint(value >>> 0)]);
}

/** Simulierter PowerStream: verschluesselt/entschluesselt echte Frames */
class FakePs {
    constructor({ authCode = 0, chunk = 0 } = {}) {
        this.session = new P.Session(SN, UID);
        this.authCode = authCode;
        this.chunk = chunk; // >0: Notifications in Stuecke dieser Groesse zerlegen
        this.perm = 0; // W
        this.out = 120; // W
        this.bright = 1023;
        this.supply = 0;
        this.writes = []; // {cmdId, value}
        this.connections = 0;
        this.peripheral = null;
        this.hbTimer = null;
    }

    notify(frame) {
        const n = this.notifyChar;
        if (!n) {
            return;
        }
        if (this.chunk) {
            for (let i = 0; i < frame.length; i += this.chunk) {
                n.emit('data', frame.subarray(i, i + this.chunk), true);
            }
        } else {
            n.emit('data', frame, true);
        }
    }

    psFrame(cmdSet, cmdId, payload, ver = 3) {
        const pkt = P.buildPacket({ src: P.DST_PS, dst: P.SRC_APP, cmdSet, cmdId, payload, ver, dsrc: 1, ddst: 1 });
        pkt[6] = 0x37; // seq[0] als XOR-Maske
        return this.session.encryptFrame(pkt);
    }

    heartbeat() {
        const pb = Buffer.concat([
            pbField(48, this.perm * 10),
            pbField(38, this.out * 10),
            pbField(31, 87),
            pbField(56, this.bright),
            pbField(50, this.supply),
            pbField(53, 1),
            pbField(35, 23012),
        ]);
        return this.psFrame(0x14, 0x01, Buffer.from(pb.map(b => b ^ 0x37)));
    }

    onWrite(frame) {
        const d = crypto.createDecipheriv('aes-128-cbc', this.session.key, this.session.iv);
        d.setAutoPadding(false);
        const dec = Buffer.concat([d.update(frame.subarray(5)), d.final()]);
        const ver = frame[1];
        const payLen = frame[2] | (frame[3] << 8);
        const [cs, ci, po] = ver >= 3 ? [dec[11], dec[12], 13] : [dec[9], dec[10], 11];
        const payload = dec.subarray(po, po + payLen);
        if (cs === 0x35 && ci === 0x86) {
            setTimeout(() => this.notify(this.psFrame(0x35, 0x86, Buffer.from([this.authCode]))), 10);
        } else if (cs === 0x14) {
            // payload: 0x08 + varint
            let v = 0;
            let sh = 0;
            for (let i = 1; i < payload.length; i++) {
                v |= (payload[i] & 0x7f) << sh;
                sh += 7;
                if (!(payload[i] & 0x80)) {
                    break;
                }
            }
            this.writes.push({ cmdId: ci, value: v });
            if (ci === 0x81) {
                this.perm = v / 10;
            }
            if (ci === 0x87) {
                this.bright = v;
            }
            if (ci === 0x82) {
                this.supply = v;
            }
        }
    }

    /** Fake-BleManager */
    makeBle() {
        return {
            connect: async () => {
                this.connections++;
                const ps = this;
                const writeChar = {
                    uuid: nobleUuid(P.WRITE_UUID),
                    properties: ['writeWithoutResponse'],
                    async writeAsync(buf) {
                        ps.onWrite(Buffer.from(buf));
                    },
                };
                const notifyChar = Object.assign(new EventEmitter(), {
                    uuid: nobleUuid(P.NOTIFY_UUID),
                    async subscribeAsync() {},
                    async unsubscribeAsync() {},
                });
                this.notifyChar = notifyChar;
                const p = Object.assign(new EventEmitter(), {
                    state: 'connected',
                    async discoverSomeServicesAndCharacteristicsAsync() {
                        return { characteristics: [writeChar, notifyChar] };
                    },
                    async disconnectAsync() {
                        p.state = 'disconnected';
                    },
                    async updateRssiAsync() {
                        return -61;
                    },
                });
                this.peripheral = p;
                return p;
            },
        };
    }

    startHeartbeats(ms = 40) {
        this.hbTimer = setInterval(() => this.notify(this.heartbeat()), ms);
    }

    dropLink() {
        this.peripheral.state = 'disconnected';
        this.peripheral.emit('disconnect');
    }

    stop() {
        clearInterval(this.hbTimer);
    }
}

async function waitFor(fn, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (fn()) {
            return;
        }
        await sleep(10);
    }
    throw new Error('waitFor Timeout');
}


module.exports = { FakePs, sleep, waitFor, SN, UID };
