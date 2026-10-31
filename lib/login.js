'use strict';

/**
 * Ermittelt die EcoFlow User-ID per Anmeldung an der offiziellen EcoFlow-API.
 * Die Zugangsdaten gehen ausschliesslich an die EcoFlow-Server und werden weder gespeichert
 * noch protokolliert.
 */

const HOSTS = {
    api: 'api.ecoflow.com', // Global / US
    'api-e': 'api-e.ecoflow.com', // Europa
    'api-a': 'api-a.ecoflow.com', // Asien / MEA
    'api-j': 'api-j.ecoflow.com', // Japan
    'api-r': 'api-r.ecoflow.com', // Russland
    'api-cn': 'api-cn.ecoflow.com', // China (nur Telefonnummer)
};
/** Reihenfolge bei "auto" mit E-Mail: das Konto kann auf einem anderen Host liegen als die Region */
const AUTO_ORDER = ['api', 'api-e', 'api-a', 'api-j', 'api-r'];

class LoginError extends Error {
    /**
     * @param {string} message
     * @param {'input'|'network'|'http'|'api'} kind
     */
    constructor(message, kind) {
        super(message);
        this.kind = kind;
    }
}

function isPhone(identifier) {
    const digits = identifier.replace(/^\+/, '').replace(/ /g, '');
    return /^\d+$/.test(digits) && digits.length >= 6 && digits.length <= 15;
}

function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loginOnce(regionKey, identifier, password, fetchFn, timeoutMs) {
    const phone = isPhone(identifier);
    const payload = {
        scene: 'IOT_APP',
        appVersion: '1.0.0',
        password: Buffer.from(password, 'utf8').toString('base64'),
        oauth: { bundleId: 'com.ef.EcoFlow' },
        userType: 'ECOFLOW',
    };
    if (regionKey === 'api-cn' && phone) {
        payload.phone = identifier.replace(/^\+86/, '');
    } else {
        payload.email = identifier;
    }

    let res;
    try {
        res = await fetchFn(`https://${HOSTS[regionKey]}/auth/login`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        throw new LoginError(`${HOSTS[regionKey]} nicht erreichbar (${e.name === 'TimeoutError' ? 'Zeitüberschreitung' : e.message})`, 'network');
    }
    if (!res.ok) {
        throw new LoginError(`Anmeldung fehlgeschlagen (HTTP ${res.status})`, 'http');
    }
    let data;
    try {
        data = await res.json();
    } catch {
        throw new LoginError('Unerwartete Antwort der EcoFlow-API', 'api');
    }
    if (!data || data.code !== '0') {
        throw new LoginError((data && data.message) || 'Anmeldung fehlgeschlagen', 'api');
    }
    const userId = data.data && data.data.user && data.data.user.userId;
    if (!userId) {
        throw new LoginError('Antwort der EcoFlow-API enthält keine User-ID', 'api');
    }
    return String(userId);
}

/**
 * @param {object} o
 * @param {string} o.identifier E-Mail oder Telefonnummer
 * @param {string} o.password
 * @param {string} [o.region] 'auto' (Standard) oder Schluessel aus HOSTS
 * @param {typeof fetch} [fetchFn]
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} User-ID
 */
async function fetchUserId(o, fetchFn = globalThis.fetch, timeoutMs = 15000) {
    const identifier = String((o && o.identifier) || '').trim();
    const password = String((o && o.password) || '');
    const region = (o && o.region) || 'auto';

    if (!identifier || !password) {
        throw new LoginError('Bitte E-Mail/Telefonnummer und Passwort eingeben', 'input');
    }
    if (!isEmail(identifier) && !isPhone(identifier)) {
        throw new LoginError('Ungültige E-Mail-Adresse oder Telefonnummer', 'input');
    }
    if (region !== 'auto' && !HOSTS[region]) {
        throw new LoginError(`Unbekannte Region "${region}"`, 'input');
    }
    if (typeof fetchFn !== 'function') {
        throw new LoginError('fetch ist nicht verfügbar (Node.js ≥ 18 erforderlich)', 'input');
    }
    const phone = isPhone(identifier);
    if (region === 'api-cn' && !phone) {
        throw new LoginError('Die Region api-cn erfordert eine Telefonnummer statt einer E-Mail-Adresse', 'input');
    }

    const order = region === 'auto' ? (phone ? ['api-cn'] : AUTO_ORDER) : [region];
    let lastError;
    for (const key of order) {
        try {
            return await loginOnce(key, identifier, password, fetchFn, timeoutMs);
        } catch (e) {
            if (!(e instanceof LoginError)) {
                throw e;
            }
            lastError = e;
            // Weiter zum naechsten Host nur, wenn das Konto dort nicht existiert oder der Host nicht antwortet
            const tryNext = e.kind === 'network' || (e.kind === 'api' && /not exist|does not exist|exist/i.test(e.message));
            if (!tryNext) {
                throw e;
            }
        }
    }
    throw lastError;
}

module.exports = { fetchUserId, LoginError, HOSTS, AUTO_ORDER, isPhone, isEmail };
