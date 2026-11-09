import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createSigningIdentity,signPayload,verifySignedPayload} from '../src/signature.js';
import {encryptSigningIdentity,decryptSigningIdentity} from '../src/key-backup.js';
import {selectDisplayedPayload} from '../src/signed-display.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

test('signatures survive visual settings, but content edits force unsigned mode',async()=>{
  const identity=await createSigningIdentity();
  const original='https://example.com';
  const signed=await signPayload(original,identity);
  const first=selectDisplayedPayload(original,null,null,signed);
  assert.equal(first.signed,true);
  const changedColor=selectDisplayedPayload(original,first.signedOriginal,first.signedEncoded);
  assert.equal(changedColor.value,signed);
  assert.equal((await verifySignedPayload(changedColor.value,identity.fingerprint)).status,'trusted');
  const changedText=selectDisplayedPayload('https://other.example',first.signedOriginal,first.signedEncoded);
  assert.equal(changedText.value,'https://other.example');
  assert.equal(changedText.signed,false);
  assert.equal(changedText.dropped,true);
  assert.equal(changedText.signedEncoded,null);
});

test('encrypted private-key backup roundtrip and wrong password or tamper reject',async()=>{
  const identity=await createSigningIdentity();
  const saved=await encryptSigningIdentity(identity,'a-long-passphrase-🦊-not-stored');
  assert.equal(saved.format,'KQR-ENCRYPTED-KEY');
  assert.ok(!JSON.stringify(saved).includes('"d":'));
  const recovered=await decryptSigningIdentity(saved,'a-long-passphrase-🦊-not-stored');
  assert.equal(recovered.fingerprint,identity.fingerprint);
  assert.equal((await verifySignedPayload(await signPayload('復号テスト',recovered),identity.fingerprint)).status,'trusted');
  await assert.rejects(decryptSigningIdentity(saved,'incorrect-password'));
  await assert.rejects(decryptSigningIdentity({...saved,fingerprint:'0'.repeat(64)},'a-long-passphrase-🦊-not-stored'));
  await assert.rejects(encryptSigningIdentity(identity,'short'));
  await assert.rejects(decryptSigningIdentity({...saved,iterations:1},'a-long-passphrase-🦊-not-stored'));
});

test('worker validates input and returns per-tile decoded QR without DOM access',async()=>{
  const script=await readFile(new URL('../src/decode-worker.js',import.meta.url),'utf8');
  const messages=[];
  const self={jsQR:(pixels,w,h)=>pixels[0]===71?{data:'local-result'}:null,postMessage:(message)=>messages.push(message)};
  const context={self,WebAssembly:undefined,Uint8ClampedArray,ArrayBuffer,Array,Number,Error,String,Set,importScripts:()=>{},console};
  runInNewContext(script,context);
  const w=500,h=500,pixels=new Uint8ClampedArray(w*h*4);
  pixels[(250*w+250)*4]=71;
  await self.onmessage({data:{id:1,rgba:pixels.buffer,width:w,height:h,regions:[{x:250,y:250,width:200,height:200}]}});
  assert.equal(messages[0].id,1);
  assert.deepEqual(Array.from(messages[0].matches),['local-result']);
  await self.onmessage({data:{id:2,rgba:new ArrayBuffer(2),width:w,height:h,regions:[]}});
  assert.equal(messages[1].error,'Local QR decoder failed');
});

test('worker-reader supports fallback and immediate abort without exposing pixels',async()=>{
  const saved=globalThis.Worker;
  const queued=[];
  class FakeWorker {
    constructor(url){this.url=url;this.terminated=false;}
    postMessage(payload){queued.push({worker:this,payload});}
    terminate(){this.terminated=true;}
  }
  globalThis.Worker=FakeWorker;
  try {
    const {decodeInWorker,cancelWorkerDecoding}=await import('../src/worker-reader.js');
    const image=()=>({width:2,height:2,data:new Uint8ClampedArray(16)});
    const first=decodeInWorker(image());
    assert.equal(queued.length,1);
    queued[0].worker.onmessage({data:{id:queued[0].payload.id,matches:['ok']}});
    assert.deepEqual(await first,['ok']);
    const controller=new AbortController();
    const second=decodeInWorker(image(),[],controller.signal);
    controller.abort();
    await assert.rejects(second,{name:'AbortError'});
    const next=decodeInWorker(image());
    assert.equal(queued[1].worker.terminated,true);
    cancelWorkerDecoding();
    await assert.rejects(next,{name:'AbortError'});
  } finally {
    if(saved===undefined)delete globalThis.Worker;
    else globalThis.Worker=saved;
  }
});
