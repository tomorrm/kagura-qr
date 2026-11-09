import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createReplayGuard, createSigningIdentity, exportPrivateJwk, importSigningIdentity, signPayload, signRevocationList, verifyRevocationList, verifySignedPayload} from '../src/signature.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('sign/verify including Japanese text; untrusted until pinned fingerprint', async () => {
  const identity = await createSigningIdentity();
  const value = await signPayload('重要情報：神楽 QR 🐧', identity);
  assert.ok(value.startsWith('KQR2.'));
  const untrusted = await verifySignedPayload(value);
  assert.equal(untrusted.status, 'valid-untrusted');
  assert.equal(untrusted.payload, '重要情報：神楽 QR 🐧');
  assert.equal((await verifySignedPayload(value, identity.fingerprint)).status, 'trusted');
  assert.equal((await verifySignedPayload(value, '0'.repeat(64))).status, 'valid-untrusted');
});

test('KQR2 checks signed expiry and future issue times without weakening signature verification', async () => {
  const identity = await createSigningIdentity();
  const now = 1_800_000_000_000;
  const value = await signPayload('time-limited', identity, {expiresInSeconds: 3600, now});
  assert.equal((await verifySignedPayload(value, identity.fingerprint, {now})).status, 'trusted');
  assert.equal((await verifySignedPayload(value, identity.fingerprint, {now: now + 3600_000})).status, 'expired');
  assert.equal((await verifySignedPayload(value, identity.fingerprint, {now: now - 301_000})).status, 'not-yet-valid');
  await assert.rejects(signPayload('short expiry', identity, {expiresInSeconds: 59, now}));
  await assert.rejects(signPayload('long expiry', identity, {expiresInSeconds: 366 * 86400 + 1, now}));
});

test('KQR2 session replay guard and issuer revocation are bounded and apply after signature validation', async () => {
  const identity = await createSigningIdentity();
  const first = await signPayload('once', identity, {now: 1_800_000_000_000});
  const other = await signPayload('also once', identity, {now: 1_800_000_000_000});
  const replayGuard = createReplayGuard({capacity: 1});
  const options = {now: 1_800_000_000_000, replayGuard};
  assert.equal((await verifySignedPayload(first, identity.fingerprint, options)).status, 'trusted');
  assert.equal((await verifySignedPayload(first, identity.fingerprint, options)).status, 'replayed');
  assert.equal((await verifySignedPayload(other, identity.fingerprint, options)).status, 'trusted');
  assert.equal(replayGuard.size, 1);
  assert.equal((await verifySignedPayload(first, identity.fingerprint, {
    now: 1_800_000_000_000, revokedFingerprints: new Set([identity.fingerprint])
  })).status, 'revoked');
});

test('KQR1 signatures remain verifiable after KQR2 issuance is introduced', async () => {
  const identity = await createSigningIdentity();
  const publicKey = Buffer.from(await globalThis.crypto.subtle.exportKey('raw', identity.publicKey)).toString('base64url');
  const body = Buffer.from(JSON.stringify({v:1, alg:'Ed25519', payload:'legacy', pk:publicKey})).toString('base64url');
  const signed = new Uint8Array(await globalThis.crypto.subtle.sign(
    'Ed25519', identity.privateKey, new TextEncoder().encode(`KAGURA-QR-SIGNATURE-v1\n${body}`)
  ));
  const legacy = `KQR1.${body}.${Buffer.from(signed).toString('base64url')}`;
  assert.equal((await verifySignedPayload(legacy, identity.fingerprint)).status, 'trusted');
});

test('signed revocation lists require a pinned authority and enforce expiry and monotonic updates', async () => {
  const authority=await createSigningIdentity();
  const target=await createSigningIdentity();
  const now=1_800_000_000_000;
  const list=await signRevocationList(authority,[target.fingerprint],{now,expiresInSeconds:3600});
  const text=JSON.stringify(list);
  assert.equal((await verifyRevocationList(text,authority.fingerprint,{now})).status,'trusted');
  assert.equal((await verifyRevocationList(text,'0'.repeat(64),{now})).status,'untrusted');
  assert.equal((await verifyRevocationList(text,authority.fingerprint,{now:now+3600_000})).status,'expired');
  assert.equal((await verifyRevocationList(text,authority.fingerprint,{now,minimumIssuedAt:1_800_000_001})).status,'stale');
  assert.equal((await verifyRevocationList(text,authority.fingerprint,{now:now-301_000})).status,'not-yet-valid');
  const tampered={...list,body:list.body.slice(0,-1)+(list.body.endsWith('A')?'B':'A')};
  assert.equal((await verifyRevocationList(JSON.stringify(tampered),authority.fingerprint,{now})).status,'invalid');
  await assert.rejects(signRevocationList(authority,[target.fingerprint,target.fingerprint],{now}));
  await assert.rejects(signRevocationList(authority,['invalid'],{now}));
  assert.equal((await verifyRevocationList(' '.repeat(512*1024+1),authority.fingerprint,{now})).status,'invalid');
});

test('tamper modification and wrong signatures must fail closed', async () => {
  const identity = await createSigningIdentity();
  const value = await signPayload('PAY=100', identity);
  const [prefix, body, signature] = value.split('.');
  const wrongSignature = signature.slice(0, -1) + (signature.at(-1) === 'A' ? 'B' : 'A');
  assert.equal((await verifySignedPayload(`${prefix}.${body}.${wrongSignature}`)).status, 'invalid');
  const raw = JSON.parse(new TextDecoder().decode(Buffer.from(body, 'base64url')));
  raw.payload = 'PAY=999';
  const edited = Buffer.from(JSON.stringify(raw)).toString('base64url');
  assert.equal((await verifySignedPayload(`${prefix}.${edited}.${signature}`)).status, 'invalid');
});

test('different key cannot be trusted, exported key can be restored', async () => {
  const a = await createSigningIdentity(), b = await createSigningIdentity();
  const text = await signPayload('signed information', a);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal((await verifySignedPayload(text, b.fingerprint)).status, 'valid-untrusted');
  const recovered = await importSigningIdentity(await exportPrivateJwk(a));
  assert.equal(recovered.fingerprint, a.fingerprint);
  assert.equal((await verifySignedPayload(await signPayload('again', recovered), a.fingerprint)).status, 'trusted');
});

test('invalid envelopes and unsupported or missing keys are rejected', async () => {
  assert.equal((await verifySignedPayload('https://example.org')).status, 'unsigned');
  assert.equal((await verifySignedPayload('KQR2.not_base64!.' + 'A'.repeat(86))).status, 'invalid');
  assert.equal((await verifySignedPayload('KQR2.' + 'A'.repeat(9000))).status, 'invalid');
  await assert.rejects(() => signPayload('hello', {}));
  await assert.rejects(() => importSigningIdentity({kty:'RSA'}));
});
