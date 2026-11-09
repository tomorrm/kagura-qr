/** Opt-in password-encrypted Ed25519 JWK backup; never persisted in browser storage. */
import {exportPrivateJwk,importSigningIdentity} from './signature.js';
const enc=new TextEncoder();
const ITERATIONS=310000;
const toB64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
function fromB64(s,bytes){
  if(typeof s!=='string'||s.length>3000||!/^[-_A-Za-z0-9]+$/.test(s))throw Error('鍵ファイルの形式が不正です。');
  const value=Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
  if((bytes!==null&&value.length!==bytes)||toB64(value)!==s)throw Error('鍵ファイルが破損しています。');
  return value;
}
function passwordBytes(password){
  if(typeof password!=='string'||password.length<12||enc.encode(password).length>1024)throw Error('パスフレーズは12文字以上、1024バイト以下にしてください。');
  return enc.encode(password);
}
async function deriveKey(password,salt,iterations){
  const passwordKey=await crypto.subtle.importKey('raw',passwordBytes(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},passwordKey,
    {name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptSigningIdentity(identity,password){
  if(!globalThis.crypto?.subtle||!globalThis.crypto?.getRandomValues)throw Error('HTTPSまたはlocalhostで利用してください。');
  const jwk=await exportPrivateJwk(identity);
  const salt=crypto.getRandomValues(new Uint8Array(16)),nonce=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(password,salt,ITERATIONS);
  const data=enc.encode(JSON.stringify(jwk));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:enc.encode('KQR-KEY-BACKUP-v1')},key,data);
  return {format:'KQR-ENCRYPTED-KEY',version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,
    algorithm:'AES-256-GCM',fingerprint:identity.fingerprint,
    salt:toB64(salt),nonce:toB64(nonce),ciphertext:toB64(new Uint8Array(cipher))};
}
export async function decryptSigningIdentity(data,password){
  if(!data||typeof data!=='object'||data.format!=='KQR-ENCRYPTED-KEY'||data.version!==1||
    data.kdf!=='PBKDF2-SHA256'||data.iterations!==ITERATIONS||data.algorithm!=='AES-256-GCM'||
    typeof data.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(data.fingerprint))throw Error('対応していない鍵ファイルです。');
  const salt=fromB64(data.salt,16),nonce=fromB64(data.nonce,12),cipher=fromB64(data.ciphertext,null);
  if(cipher.length<16||cipher.length>4096)throw Error('鍵ファイルの大きさが不正です。');
  const key=await deriveKey(password,salt,ITERATIONS);
  try {
    const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:enc.encode('KQR-KEY-BACKUP-v1')},key,cipher);
    const identity=await importSigningIdentity(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)));
    if(identity.fingerprint!==data.fingerprint)throw Error('公開鍵指紋が一致しません。');
    return identity;
  } catch {throw Error('復号できません。パスフレーズとファイルを確認してください。');}
}
