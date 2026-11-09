/**
 * Kagura QR signed-envelope v2. No network, no key persistence.
 * NOTE: A self-contained public key proves internal integrity, NOT issuer identity.
 * Trust requires an independently distributed SHA-256 public-key fingerprint.
 */
const DOMAIN = 'KAGURA-QR-SIGNATURE-v1\n';
const DOMAIN_V2 = 'KAGURA-QR-SIGNATURE-v2\n';
const REVOCATION_DOMAIN = 'KAGURA-QR-REVOCATIONS-v1\n';
const PREFIX_V1 = 'KQR1.';
const PREFIX_V2 = 'KQR2.';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_ENVELOPE_BYTES = 8000;
const MAX_MESSAGE_BYTES = 1200;
const MAX_EXPIRY_SECONDS = 366 * 24 * 60 * 60;
const MAX_REVOCATIONS = 5000;
const MAX_REVOCATION_BYTES = 512 * 1024;

function bytesToBase64Url(bytes) {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_ENVELOPE_BYTES * 2) throw new Error('署名データの形式が不正です。');
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const s = atob(b64);
  const bytes = Uint8Array.from(s, ch => ch.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error('正規形式ではない署名データです。');
  return bytes;
}
const bytesToHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function requireCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error('電子署名にはHTTPSまたはlocalhostとWeb Crypto APIが必要です。');
  return globalThis.crypto.subtle;
}

export async function fingerprintPublicKey(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length !== 32) throw new Error('公開鍵は32バイトである必要があります。');
  const hash = await requireCrypto().digest('SHA-256', rawBytes);
  return bytesToHex(new Uint8Array(hash));
}

export async function createSigningIdentity() {
  const subtle = requireCrypto();
  const pair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const rawPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {privateKey: pair.privateKey, publicKey: pair.publicKey,
    fingerprint: await fingerprintPublicKey(rawPublic)};
}

export async function importSigningIdentity(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
    throw new Error('Ed25519の秘密鍵JWKファイルを選択してください。');
  }
  const subtle = requireCrypto();
  const publicBytes = base64UrlToBytes(jwk.x);
  if (publicBytes.length !== 32 || base64UrlToBytes(jwk.d).length !== 32) throw new Error('鍵データの長さが不正です。');
  const priv = await subtle.importKey('jwk', {...jwk, key_ops:['sign'], ext:true}, 'Ed25519', true, ['sign']);
  const pub = await subtle.importKey('raw', publicBytes, 'Ed25519', true, ['verify']);
  // Ensure the private/public halves actually form a working pair.
  const sample = encoder.encode(DOMAIN + 'key-self-test');
  const testSig = await subtle.sign('Ed25519', priv, sample);
  if (!await subtle.verify('Ed25519', pub, testSig, sample)) throw new Error('秘密鍵と公開鍵が一致しません。');
  return {privateKey: priv, publicKey: pub, fingerprint: await fingerprintPublicKey(publicBytes)};
}

export async function exportPrivateJwk(identity) {
  if (!identity?.privateKey) throw new Error('鍵が生成されていません。');
  return await requireCrypto().exportKey('jwk', identity.privateKey);
}

export async function signPayload(payload, identity, {expiresInSeconds=null, now=Date.now()}={}) {
  if (!identity?.privateKey || !identity?.publicKey) throw new Error('先に署名鍵を生成・読み込みしてください。');
  if (typeof payload !== 'string' || !payload.trim()) throw new Error('署名する情報を入力してください。');
  if (encoder.encode(payload).length > MAX_MESSAGE_BYTES) throw new Error('署名付きQRの内容は1,200バイト以内にしてください。');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('署名時刻が不正です。');
  if (expiresInSeconds !== null && (!Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 60 || expiresInSeconds > MAX_EXPIRY_SECONDS)) {
    throw new Error('有効期限は1分以上366日以内にしてください。');
  }
  const subtle = requireCrypto();
  const raw = new Uint8Array(await subtle.exportKey('raw', identity.publicKey));
  const issuedAt = Math.floor(now / 1000);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const body = {v:2, alg:'Ed25519', payload, pk:bytesToBase64Url(raw),
    iat:issuedAt, exp:expiresInSeconds === null ? null : issuedAt + expiresInSeconds,
    jti:bytesToBase64Url(nonce)};
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(body)));
  const signature = new Uint8Array(await subtle.sign('Ed25519', identity.privateKey, encoder.encode(DOMAIN_V2 + encoded)));
  return `${PREFIX_V2}${encoded}.${bytesToBase64Url(signature)}`;
}

export function createReplayGuard({capacity=512}={}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error('リプレイ検出の上限が不正です。');
  const seen = new Map();
  return {
    observe(fingerprint, nonce) {
      const key = `${fingerprint}:${nonce}`;
      if (seen.has(key)) return true;
      seen.set(key, true);
      if (seen.size > capacity) seen.delete(seen.keys().next().value);
      return false;
    },
    get size() { return seen.size; }
  };
}

export async function signRevocationList(identity,fingerprints,{expiresInSeconds=30*24*60*60,now=Date.now()}={}) {
  if(!identity?.privateKey||!identity?.publicKey)throw new Error('失効リスト用の管理者鍵を生成・読み込みしてください。');
  if(!Array.isArray(fingerprints)||fingerprints.length>MAX_REVOCATIONS)throw new Error('失効指紋は最大5,000件までです。');
  if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(expiresInSeconds)||
      expiresInSeconds<60||expiresInSeconds>MAX_EXPIRY_SECONDS)throw new Error('失効リストの有効期間が不正です。');
  const revoked=[...fingerprints];
  if(revoked.some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))||
      new Set(revoked).size!==revoked.length)throw new Error('失効指紋の形式が不正か重複しています。');
  revoked.sort();
  const issuedAt=Math.floor(now/1000);
  const publicKey=bytesToBase64Url(new Uint8Array(await requireCrypto().exportKey('raw',identity.publicKey)));
  const body={v:1,alg:'Ed25519',iat:issuedAt,exp:issuedAt+expiresInSeconds,revoked,pk:publicKey};
  const encoded=bytesToBase64Url(encoder.encode(JSON.stringify(body)));
  const signature=new Uint8Array(await requireCrypto().sign('Ed25519',identity.privateKey,
    encoder.encode(REVOCATION_DOMAIN+encoded)));
  const envelope={format:'KQR-REVOCATIONS',version:1,body:encoded,signature:bytesToBase64Url(signature)};
  if(encoder.encode(JSON.stringify(envelope)).length>MAX_REVOCATION_BYTES)throw new Error('失効リストが大きすぎます。');
  return envelope;
}

export async function verifyRevocationList(text,trustedAuthorityFingerprint,{
  now=Date.now(),minimumIssuedAt=0
}={}) {
  if(typeof text!=='string'||encoder.encode(text).length>MAX_REVOCATION_BYTES)
    return {status:'invalid',reason:'失効リストの形式またはサイズが不正です。'};
  try {
    const envelope=JSON.parse(text);
    if(envelope?.format!=='KQR-REVOCATIONS'||envelope?.version!==1||
        typeof envelope?.body!=='string'||typeof envelope?.signature!=='string') {
      throw new Error('対応していない失効リストです。');
    }
    const body=JSON.parse(decoder.decode(base64UrlToBytes(envelope.body)));
    if(body?.v!==1||body?.alg!=='Ed25519'||!Number.isSafeInteger(body?.iat)||body.iat<0||
        !Number.isSafeInteger(body?.exp)||body.exp<=body.iat||body.exp-body.iat>MAX_EXPIRY_SECONDS||
        !Array.isArray(body?.revoked)||body.revoked.length>MAX_REVOCATIONS||
        body.revoked.some((value,index)=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||
          (index>0&&body.revoked[index-1]>=value))) {
      throw new Error('失効リストの内容が不正です。');
    }
    const publicBytes=base64UrlToBytes(body.pk);
    const signature=base64UrlToBytes(envelope.signature);
    if(publicBytes.length!==32||signature.length!==64)throw new Error('失効リストの署名または公開鍵が不正です。');
    const subtle=requireCrypto();
    const publicKey=await subtle.importKey('raw',publicBytes,'Ed25519',false,['verify']);
    if(!await subtle.verify('Ed25519',publicKey,signature,encoder.encode(REVOCATION_DOMAIN+envelope.body)))
      return {status:'invalid',reason:'失効リストの署名と内容が一致しません。'};
    const authorityFingerprint=await fingerprintPublicKey(publicBytes);
    if(typeof trustedAuthorityFingerprint!=='string'||
        !/^[a-f0-9]{64}$/i.test(trustedAuthorityFingerprint.trim())||
        authorityFingerprint!==trustedAuthorityFingerprint.trim().toLowerCase()) {
      return {status:'untrusted',authorityFingerprint,reason:'失効リストの管理者鍵が独立して信頼されていません。'};
    }
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(minimumIssuedAt)||minimumIssuedAt<0)
      return {status:'invalid',reason:'検証時刻または更新番号が不正です。'};
    const nowSeconds=Math.floor(now/1000);
    if(body.iat>nowSeconds+300)return {status:'not-yet-valid',authorityFingerprint,reason:'失効リストの発行時刻が未来です。'};
    if(nowSeconds>=body.exp)return {status:'expired',authorityFingerprint,reason:'失効リストの有効期限が切れています。'};
    if(minimumIssuedAt>0&&body.iat<=minimumIssuedAt)
      return {status:'stale',authorityFingerprint,reason:'以前に読み込んだ失効リストと同じか古いため適用しません。'};
    return {status:'trusted',authorityFingerprint,issuedAt:body.iat,expiresAt:body.exp*1000,
      revokedFingerprints:new Set(body.revoked)};
  } catch(error) {
    return {status:'invalid',reason:error instanceof Error?error.message:'失効リストを検証できません。'};
  }
}

export async function verifySignedPayload(text, trustedFingerprint = '', {
  now=Date.now(), replayGuard=null, revokedFingerprints=null
}={}) {
  if (typeof text !== 'string' || (!text.startsWith(PREFIX_V1) && !text.startsWith(PREFIX_V2))) return {status:'unsigned'};
  if (text.length > MAX_ENVELOPE_BYTES) return {status:'invalid', reason:'署名データが長すぎます。'};
  try {
    const parts = text.split('.');
    const version = parts[0] === 'KQR1' ? 1 : parts[0] === 'KQR2' ? 2 : 0;
    if (parts.length !== 3 || !version) throw new Error('署名データの形式が不正です。');
    const body = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
    if (body?.v !== version || body?.alg !== 'Ed25519' || typeof body?.payload !== 'string' || typeof body?.pk !== 'string') throw new Error('対応していない署名形式です。');
    if (encoder.encode(body.payload).length > MAX_MESSAGE_BYTES) throw new Error('署名された内容が長すぎます。');
    if (version === 2 && (!Number.isSafeInteger(body.iat) || body.iat < 0 ||
        !(body.exp === null || (Number.isSafeInteger(body.exp) && body.exp > body.iat &&
          body.exp - body.iat <= MAX_EXPIRY_SECONDS)) ||
        typeof body.jti !== 'string' || base64UrlToBytes(body.jti).length !== 16)) {
      throw new Error('署名の有効期間またはnonceが不正です。');
    }
    const publicBytes = base64UrlToBytes(body.pk);
    const signature = base64UrlToBytes(parts[2]);
    if (publicBytes.length !== 32 || signature.length !== 64) throw new Error('公開鍵または署名の長さが不正です。');
    const subtle = requireCrypto();
    const pub = await subtle.importKey('raw', publicBytes, 'Ed25519', false, ['verify']);
    const ok = await subtle.verify('Ed25519', pub, signature, encoder.encode((version === 1 ? DOMAIN : DOMAIN_V2) + parts[1]));
    if (!ok) return {status:'invalid', reason:'署名とデータが一致しません。'};
    const fingerprint = await fingerprintPublicKey(publicBytes);
    if (version === 2) {
      if (!Number.isSafeInteger(now) || now < 0) return {status:'invalid', reason:'検証時刻が不正です。'};
      const nowSeconds = Math.floor(now / 1000);
      if (body.iat > nowSeconds + 300) return {status:'not-yet-valid', fingerprint, reason:'署名時刻が現在より未来です。端末の時計を確認してください。'};
      if (body.exp !== null && nowSeconds >= body.exp) return {status:'expired', fingerprint, reason:'署名の有効期限が切れています。'};
    }
    if (revokedFingerprints instanceof Set && revokedFingerprints.has(fingerprint)) {
      return {status:'revoked', fingerprint, reason:'このタブの失効リストに登録された鍵です。'};
    }
    if (version === 2 && replayGuard && typeof replayGuard.observe === 'function' &&
        replayGuard.observe(fingerprint, body.jti)) {
      return {status:'replayed', fingerprint, reason:'この署名付きQRは、このタブですでに確認されています。'};
    }
    // Never treat embedded self-declared public keys as a trusted identity.
    const trusted = typeof trustedFingerprint === 'string' && /^[a-f0-9]{64}$/i.test(trustedFingerprint.trim()) &&
      fingerprint === trustedFingerprint.trim().toLowerCase();
    return {status:trusted ? 'trusted' : 'valid-untrusted', version, payload:body.payload, fingerprint,
      expiresAt:version === 2 && body.exp !== null ? body.exp * 1000 : null,
      reason:trusted ? '署名は有効で、信頼した公開鍵と一致します。' : '署名の整合性は確認できましたが、発行者は未確認です。'};
  } catch (error) {
    return {status:'invalid', reason:error instanceof Error ? error.message : '署名検証に失敗しました。'};
  }
}
