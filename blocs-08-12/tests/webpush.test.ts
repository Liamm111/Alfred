import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, createVerify } from 'node:crypto';
import { VapidSigner, buildPushRequest, classify, encryptPayload, generateVapidKeys, parseRetryAfter, topicFor, vapidJwt } from '../src/outbox/webpush.ts';

const u = (s: string) => Buffer.from(s, 'base64url');

test('RFC 8291 §5 / Annexe A : vecteur de test officiel reproduit octet pour octet', () => {
  const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), senderKey: { publicKey: u('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'), privateKey: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') } });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number) { const prk = createHmac('sha256', salt).update(ikm).digest(); return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len); }
function decryptAsUA(body: Buffer, uaPriv: Buffer, uaPub: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16), idlen = body[20]!, asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(uaPriv);
  const ikm = hkdf(auth, ecdh.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const d = createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 0x02, 'délimiteur de dernier enregistrement');
  return pt.subarray(0, pt.length - 1);
}

test('aller-retour : un agent utilisateur déchiffre ce que l’émetteur chiffre ; mauvaise clé → échec', () => {
  const ua = createECDH('prime256v1'); ua.generateKeys(); const auth = Buffer.from('0123456789abcdef');
  const msg = Buffer.from(JSON.stringify({ title: 'Vous êtes sollicité', n: 1 }));
  const body = encryptPayload(msg, ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
  assert.deepEqual(decryptAsUA(body, ua.getPrivateKey(), ua.getPublicKey(), auth), msg);
  const other = createECDH('prime256v1'); other.generateKeys();
  assert.throws(() => decryptAsUA(body, other.getPrivateKey(), other.getPublicKey(), auth));
  assert.throws(() => encryptPayload(Buffer.alloc(5000), ua.getPublicKey().toString('base64url'), auth.toString('base64url')));
});

test('VAPID : JWT ES256 vérifiable avec la clé publique, aud/exp/sub corrects, exp ≤ 24 h, régénéré avant expiration', () => {
  const keys = generateVapidKeys();
  const now = 1_800_000_000_000;
  const { jwt, exp } = vapidJwt(keys, 'https://web.push.apple.com/abc/def', 'mailto:ops@example.org', now);
  const [h, b, s] = jwt.split('.');
  const pub = u(keys.publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  assert.ok(createVerify('SHA256').update(`${h}.${b}`).verify({ key, dsaEncoding: 'ieee-p1363' }, u(s!)));
  const claims = JSON.parse(u(b!).toString());
  assert.equal(claims.aud, 'https://web.push.apple.com'); assert.equal(claims.sub, 'mailto:ops@example.org'); assert.equal(claims.exp, exp);
  assert.throws(() => vapidJwt(keys, 'https://web.push.apple.com/x', 'mailto:a@b.c', now, 25 * 3600));
  const signer = new VapidSigner(keys, 'mailto:ops@example.org');
  const h1 = signer.header('https://web.push.apple.com/x', now), h1b = signer.header('https://web.push.apple.com/y', now + 60_000);
  assert.equal(h1, h1b, 'JWT mis en cache par origine');
  const h2 = signer.header('https://web.push.apple.com/x', now + 11.9 * 3600_000);
  assert.notEqual(h2, h1, 'régénéré à < 10 min de l’expiration');
  assert.match(h1, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
});

test('requête push : TTL, Urgency, Topic ≤ 32 car. stable par événement, corps chiffré', () => {
  const keys = generateVapidKeys(); const ua = createECDH('prime256v1'); ua.generateKeys();
  const req = buildPushRequest({ endpoint: 'https://web.push.apple.com/x', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url'), payload: { secret: 'texte clair' }, address_event_id: 'q-1:alert', urgency: 'urgent', ttl_s: 120, vapid: new VapidSigner(keys, 'mailto:a@b.c'), nowMs: 1_800_000_000_000 });
  assert.equal(req.headers.TTL, '120'); assert.equal(req.headers.Urgency, 'high'); assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(req.headers.Topic!.length <= 32 && /^[\w-]+$/.test(req.headers.Topic!));
  assert.equal(req.headers.Topic, topicFor('q-1:alert'));
  assert.notEqual(topicFor('q-1:alert'), topicFor('q-2:alert'));
  assert.ok(!req.body.toString('latin1').includes('texte clair'));
});

test('classification des réponses du service push : 201 = accepté (pas lu), 404/410 gone, 429 + Retry-After, 401/403, 5xx', () => {
  const now = 1_000_000;
  assert.deepEqual(classify({ status: 201 }, now), { kind: 'accepted', http: 201 });
  assert.equal(classify({ status: 410 }, now).kind, 'gone'); assert.equal(classify({ status: 404 }, now).kind, 'gone');
  assert.deepEqual(classify({ status: 429, retry_after: '30' }, now), { kind: 'rate_limited', http: 429, retry_after_ms: 30_000 });
  assert.equal(classify({ status: 403 }, now).kind, 'auth'); assert.equal(classify({ status: 401 }, now).kind, 'auth');
  assert.equal(classify({ status: 503 }, now).kind, 'transient'); assert.equal(classify({ status: 413 }, now).kind, 'invalid'); assert.equal(classify({ status: 302 }, now).kind, 'invalid');
  assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(parseRetryAfter('abc', now), null); assert.equal(parseRetryAfter(null, now), null);
});
