'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fetchUserId, LoginError, isPhone, isEmail } = require('../lib/login');

function mockFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body });
        const r = handler(url, body);
        return {
            ok: r.status === undefined || r.status < 400,
            status: r.status || 200,
            json: async () => r.json,
        };
    };
    fn.calls = calls;
    return fn;
}
const okReply = id => ({ json: { code: '0', message: 'Success', data: { user: { userId: id } } } });

test('Eingabe-Erkennung', () => {
    assert.ok(isEmail('a@b.de'));
    assert.ok(!isEmail('abc'));
    assert.ok(isPhone('+8613812345678'));
    assert.ok(!isPhone('12'));
});

test('Erfolgreiche Anmeldung: Payload und User-ID', async () => {
    const f = mockFetch(() => okReply(1234567890123456789n.toString()));
    const id = await fetchUserId({ identifier: ' me@example.com ', password: 'pä"ss\\word', region: 'api-e' }, f);
    assert.strictEqual(id, '1234567890123456789');
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, 'https://api-e.ecoflow.com/auth/login');
    const b = f.calls[0].body;
    assert.strictEqual(b.email, 'me@example.com');
    assert.strictEqual(b.scene, 'IOT_APP');
    assert.strictEqual(b.userType, 'ECOFLOW');
    assert.strictEqual(b.oauth.bundleId, 'com.ef.EcoFlow');
    assert.strictEqual(Buffer.from(b.password, 'base64').toString('utf8'), 'pä"ss\\word');
});

test('Auto: unbekanntes Konto -> naechster Host', async () => {
    const f = mockFetch(url =>
        url.includes('//api.ecoflow.com') ? { json: { code: '1006', message: 'The account does not exist' } } : okReply('42'),
    );
    assert.strictEqual(await fetchUserId({ identifier: 'me@example.com', password: 'x' }, f), '42');
    assert.deepStrictEqual(
        f.calls.map(c => new URL(c.url).hostname),
        ['api.ecoflow.com', 'api-e.ecoflow.com'],
    );
});

test('Auto: falsches Passwort bricht sofort ab (keine weiteren Hosts)', async () => {
    const f = mockFetch(() => ({ json: { code: '2026', message: 'Password is incorrect' } }));
    await assert.rejects(() => fetchUserId({ identifier: 'me@example.com', password: 'x' }, f), /Password is incorrect/);
    assert.strictEqual(f.calls.length, 1);
});

test('Telefonnummer: api-cn mit Telefon-Feld ohne +86', async () => {
    const f = mockFetch(() => okReply('7'));
    await fetchUserId({ identifier: '+8613812345678', password: 'x' }, f);
    assert.strictEqual(new URL(f.calls[0].url).hostname, 'api-cn.ecoflow.com');
    assert.strictEqual(f.calls[0].body.phone, '13812345678');
    assert.strictEqual(f.calls[0].body.email, undefined);
});

test('Eingabefehler', async () => {
    const f = mockFetch(() => okReply('1'));
    await assert.rejects(() => fetchUserId({ identifier: '', password: '' }, f), LoginError);
    await assert.rejects(() => fetchUserId({ identifier: 'kein-mail', password: 'x' }, f), /Ungültige/);
    await assert.rejects(() => fetchUserId({ identifier: 'a@b.de', password: 'x', region: 'mars' }, f), /Unbekannte Region/);
    await assert.rejects(() => fetchUserId({ identifier: 'a@b.de', password: 'x', region: 'api-cn' }, f), /Telefonnummer/);
    assert.strictEqual(f.calls.length, 0);
});

test('HTTP-/Netzfehler', async () => {
    const f500 = mockFetch(() => ({ status: 500, json: {} }));
    await assert.rejects(() => fetchUserId({ identifier: 'a@b.de', password: 'x', region: 'api' }, f500), /HTTP 500/);
    const down = async () => {
        throw new Error('ENOTFOUND');
    };
    await assert.rejects(() => fetchUserId({ identifier: 'a@b.de', password: 'x', region: 'api' }, down), /nicht erreichbar/);
});

test('Unaufgeloeste Admin-Platzhalter werden erkannt', async () => {
    const f = mockFetch(() => okReply('1'));
    await assert.rejects(() => fetchUserId({ identifier: '${data._loginEmail}', password: '${data._loginPassword}' }, f), /nicht übergeben/);
    assert.strictEqual(f.calls.length, 0);
});

test('Admin-Konfiguration: Button nutzt jsonData mit allen drei Feldern und ergibt gueltiges JSON', () => {
    const cfg = require('../admin/jsonConfig.json').items.getUserId;
    assert.strictEqual(cfg.type, 'sendTo');
    assert.strictEqual(cfg.command, 'getUserId');
    assert.strictEqual(cfg.data, undefined, 'data wird vom Admin nicht ausgewertet');
    const filled = cfg.jsonData
        .replace('${data._loginEmail}', 'me@example.com')
        .replace('${data._loginPassword}', 'geheim')
        .replace('${data._loginRegion}', 'auto');
    assert.deepStrictEqual(JSON.parse(filled), { email: 'me@example.com', password: 'geheim', region: 'auto' });
});
