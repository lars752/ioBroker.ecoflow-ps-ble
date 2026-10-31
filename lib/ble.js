'use strict';

/**
 * Duenner Wrapper um @abandonware/noble (BLE-Central).
 *
 * - noble wird erst bei init() geladen, damit der Adapter ohne funktionierendes Bluetooth
 *   mit einer klaren Fehlermeldung startet statt abzustuerzen.
 * - Scan/Connect-Vorgaenge werden serialisiert (mehrere PowerStreams, ein Funkchip).
 * - Fuer Tests laesst sich ein Fake-noble injizieren (opts.noble).
 */
/**
 * Vorabpruefung unter Linux, bevor noble geladen wird: Fehlt die Berechtigung fuer rohe HCI-Sockets
 * oder gibt es keinen Bluetooth-Adapter, wirft noble einen nicht abfangbaren Fehler und der ganze
 * Adapter-Prozess beendet sich. Hier wird stattdessen eine verstaendliche Meldung erzeugt.
 *
 * @param {object} [env] Abhaengigkeiten (fuer Tests ersetzbar)
 * @returns {string|null} Fehlertext oder null, wenn alles in Ordnung scheint
 */
function checkLinuxBluetooth(env = {}) {
    const fs = env.fs || require('node:fs');
    const platform = env.platform || process.platform;
    const uid = env.uid !== undefined ? env.uid : typeof process.getuid === 'function' ? process.getuid() : -1;
    const procEnv = env.env || process.env;
    const wanted = env.hciDevice === undefined || env.hciDevice === null ? null : Number(env.hciDevice);
    if (platform !== 'linux') {
        return null;
    }
    if (procEnv.BLUETOOTH_HCI_SOCKET_USB_VID) {
        return null; // USB-Direktzugriff (libusb) statt HCI-Socket
    }
    try {
        const adapters = fs.readdirSync('/sys/class/bluetooth').filter(n => /^hci\d+$/.test(n));
        if (!adapters.length) {
            return 'Kein Bluetooth-Adapter gefunden (/sys/class/bluetooth ist leer). In VM/LXC/Docker den Adapter durchreichen (siehe README).';
        }
        if (wanted !== null && !adapters.includes(`hci${wanted}`)) {
            return `Der gewaehlte Bluetooth-Adapter hci${wanted} existiert nicht (vorhanden: ${adapters.join(', ')}). Einstellung "Bluetooth-Adapter" pruefen.`;
        }
    } catch {
        return 'Kein Bluetooth-Adapter gefunden (/sys/class/bluetooth fehlt). In VM/LXC/Docker den Adapter durchreichen (siehe README).';
    }
    if (uid !== 0) {
        try {
            const status = fs.readFileSync('/proc/self/status', 'utf8');
            const m = /^CapEff:\s*([0-9a-fA-F]+)/m.exec(status);
            if (m && (BigInt(`0x${m[1]}`) & (1n << 13n)) === 0n) {
                return 'Dem Node.js-Prozess fehlt die Berechtigung cap_net_raw fuer Bluetooth. Einmalig ausfuehren: sudo setcap cap_net_raw+eip $(eval readlink -f $(which node)) - danach die Instanz neu starten.';
            }
        } catch {
            /* nicht pruefbar -> noble versuchen lassen */
        }
    }
    return null;
}

/** Parst die Ausgabe von `hciconfig` */
function parseHciconfig(text) {
    const list = [];
    let cur = null;
    for (const line of String(text).split(/\r?\n/)) {
        let m = /^(hci(\d+)):\s+Type:\s*(\S+)\s+Bus:\s*(\S+)/.exec(line);
        if (m) {
            cur = { id: Number(m[2]), name: m[1], type: m[3], bus: m[4] };
            list.push(cur);
            continue;
        }
        m = /BD Address:\s*([0-9A-Fa-f:]{17})/.exec(line);
        if (m && cur) {
            cur.address = m[1].toUpperCase();
        }
    }
    return list;
}

/**
 * Vorhandene Bluetooth-Adapter (Linux): bevorzugt per `hciconfig` (mit MAC und Bus),
 * sonst anhand von /sys/class/bluetooth.
 *
 * @param {object} [env] Abhaengigkeiten (fuer Tests ersetzbar)
 * @returns {Promise<Array<{id:number,name:string,address?:string,bus?:string,type?:string}>>}
 */
async function listAdapters(env = {}) {
    const execFile = env.execFile || require('node:child_process').execFile;
    const fs = env.fs || require('node:fs');
    try {
        const text = await new Promise((resolve, reject) => {
            execFile('hciconfig', [], { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
        });
        const list = parseHciconfig(text);
        if (list.length) {
            return list.sort((a, b) => a.id - b.id);
        }
    } catch {
        /* hciconfig nicht vorhanden -> Fallback */
    }
    try {
        return fs
            .readdirSync('/sys/class/bluetooth')
            .filter(n => /^hci\d+$/.test(n))
            .map(n => ({ id: Number(n.slice(3)), name: n }))
            .sort((a, b) => a.id - b.id);
    } catch {
        return [];
    }
}

class BleManager {
    /**
     * @param {object} [opts]
     * @param {object} [opts.noble] vorbereitetes noble-Objekt (Tests)
     * @param {number} [opts.powerOnTimeoutMs]
     * @param {number|null} [opts.hciDevice] Index des Bluetooth-Adapters (hciN); null = Standard
     */
    constructor(opts = {}) {
        this._noble = opts.noble || null;
        this._powerOnTimeoutMs = opts.powerOnTimeoutMs || 15000;
        this._hciDevice = opts.hciDevice === undefined ? null : opts.hciDevice;
        this._preflight = opts.preflight || (() => checkLinuxBluetooth({ hciDevice: this._hciDevice }));
        this._queue = Promise.resolve();
    }

    async init() {
        if (!this._noble) {
            const problem = this._preflight();
            if (problem) {
                throw new Error(problem);
            }
            if (this._hciDevice !== null) {
                // muss vor dem ersten Laden von noble gesetzt sein
                process.env.NOBLE_HCI_DEVICE_ID = String(this._hciDevice);
            }
            try {
                this._noble = require('@abandonware/noble');
            } catch (e) {
                throw new Error(
                    `BLE-Bibliothek @abandonware/noble konnte nicht geladen werden (${e.message}). ` +
                        'Bluetooth-Voraussetzungen/Build-Tools pruefen (siehe README).',
                );
            }
        }
        const noble = this._noble;
        if (noble.state !== 'poweredOn') {
            await Promise.race([
                noble.waitForPoweredOnAsync(),
                new Promise((_, rej) =>
                    setTimeout(
                        () => rej(new Error(`Bluetooth-Adapter nicht bereit (Status: ${noble.state})`)),
                        this._powerOnTimeoutMs,
                    ),
                ),
            ]);
        }
    }

    /** Serialisiert Funkzugriffe */
    _lock(fn) {
        const run = this._queue.then(fn, fn);
        this._queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Sucht per Scan das Geraet mit der angegebenen MAC und verbindet es.
     * Scan und Connect laufen unter einem Lock (kein paralleler Scan beim Verbinden).
     *
     * @param {string} mac z.B. "aa:bb:cc:dd:ee:ff"
     * @param {object} [o]
     * @param {number} [o.scanTimeoutMs]
     * @param {number} [o.connectTimeoutMs]
     * @returns {Promise<object>} verbundene noble-Peripheral
     */
    connect(mac, o = {}) {
        const scanTimeoutMs = o.scanTimeoutMs || 15000;
        const connectTimeoutMs = o.connectTimeoutMs || 15000;
        return this._lock(async () => {
            const peripheral = await this._scanFor(mac, scanTimeoutMs);
            await withTimeout(peripheral.connectAsync(), connectTimeoutMs, 'BLE connect Timeout');
            return peripheral;
        });
    }

    _scanFor(mac, timeoutMs) {
        const noble = this._noble;
        const wanted = mac.toLowerCase();
        return new Promise((resolve, reject) => {
            let done = false;
            let timer;
            const finish = async (err, p) => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                noble.removeListener('discover', onDiscover);
                try {
                    await noble.stopScanningAsync();
                } catch {
                    /* ignorieren */
                }
                if (err) {
                    reject(err);
                } else {
                    resolve(p);
                }
            };
            const onDiscover = p => {
                const addr = String(p.address || '').toLowerCase();
                if (addr === wanted) {
                    void finish(null, p);
                }
            };
            timer = setTimeout(
                () => void finish(new Error(`Geraet ${mac} per Scan nicht gefunden (Reichweite? eingeschaltet? App geschlossen?)`)),
                timeoutMs,
            );
            noble.on('discover', onDiscover);
            // allowDuplicates=true: robust gegen noble-interne Dedup-Listen; wir stoppen sofort nach Treffer
            noble.startScanningAsync([], true).catch(e => void finish(e));
        });
    }

    async shutdown() {
        if (this._noble) {
            try {
                await this._noble.stopScanningAsync();
            } catch {
                /* ignorieren */
            }
        }
    }
}

function withTimeout(promise, ms, msg) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(msg)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/** noble-UUIDs: lowercase, ohne Bindestriche */
function nobleUuid(uuid) {
    return uuid.replace(/-/g, '').toLowerCase();
}

module.exports = { BleManager, checkLinuxBluetooth, listAdapters, parseHciconfig, withTimeout, nobleUuid };
