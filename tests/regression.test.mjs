import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeImageDimensions, validateImage, bitmapFromFile, assertImageDimensions} from '../src/processor.js';

const pngHeader=(w=80,h=60)=>{
  const bytes=new Uint8Array(24);
  bytes.set([0x89,0x50,0x4e,0x47,13,10,26,10],0);
  bytes.set([73,72,68,82],12);
  new DataView(bytes.buffer).setUint32(16,w);
  new DataView(bytes.buffer).setUint32(20,h);
  return bytes;
};

test('PNG dimensions require complete signature and IHDR marker',()=>{
  const good=pngHeader();
  assert.deepEqual(probeImageDimensions(good,'image/png'),{width:80,height:60});
  for(const i of [0,3,4,7,12,15]){
    const corrupt=good.slice();corrupt[i]^=0xff;
    assert.equal(probeImageDimensions(corrupt,'image/png'),null);
  }
  assert.throws(()=>assertImageDimensions({width:65535,height:65535}));
});

test('image uploads reject missing, undersized, malformed or excessive metadata',()=>{
  assert.throws(()=>validateImage({size:0,type:'image/png'}));
  assert.throws(()=>validateImage({size:-1,type:'image/jpeg'}));
  assert.throws(()=>validateImage({size:NaN,type:'image/png'}));
  assert.throws(()=>validateImage({size:20*1024*1024+1,type:'image/webp'}));
  assert.doesNotThrow(()=>validateImage({size:100,type:'image/png'}));
  assert.throws(()=>assertImageDimensions({width:0,height:1}));
});

test('image bitmap fallback decodes locally and revokes blob URL on close', async()=>{
  const original={Image:globalThis.Image,createImageBitmap:globalThis.createImageBitmap};
  const originalMake=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  let revoked=0;
  try {
    globalThis.createImageBitmap=undefined;
    URL.createObjectURL=()=> 'blob:test-image';URL.revokeObjectURL=()=>{revoked++;};
    globalThis.Image=class {naturalWidth=80;naturalHeight=60;src='';async decode(){}};
    const header=pngHeader();
    const file={size:100,type:'image/png',slice:()=>({arrayBuffer:async()=>header.buffer})};
    const result=await bitmapFromFile(file);
    assert.equal(result.width,80);assert.equal(result.height,60);
    assert.ok(result.image);result.close();assert.equal(revoked,1);
  } finally {
    globalThis.Image=original.Image;globalThis.createImageBitmap=original.createImageBitmap;
    URL.createObjectURL=originalMake;URL.revokeObjectURL=originalRevoke;
  }
});

test('invalid worker output rejects rather than retrying the transform synchronously',async()=>{
  const Original=globalThis.Worker;
  class CorruptWorker {
    constructor(){this.onmessage=null;}
    postMessage({id}){queueMicrotask(()=>this.onmessage?.({data:{id,width:2,height:2,buffer:new ArrayBuffer(3)}}));}
    terminate(){}
  }
  try{
    globalThis.Worker=CorruptWorker;
    const {preprocessInWorker}=await import('../src/preprocess-reader.js?bad-reply');
    const frame={width:2,height:2,data:new Uint8ClampedArray(16)};
    await assert.rejects(preprocessInWorker(frame,{threshold:'auto'}),/応答が不正/);
  } finally {globalThis.Worker=Original;}
});

test('unknown worker decoded values do not bypass QR result validation',async()=>{
  const Original=globalThis.Worker;
  class CorruptWorker {
    constructor(){this.onmessage=null;}
    postMessage({id}){queueMicrotask(()=>this.onmessage?.({data:{id,matches:[{evil:1}]}}));}
    terminate(){}
  }
  try{
    globalThis.Worker=CorruptWorker;
    const {decodeInWorker}=await import('../src/worker-reader.js?bad-reply');
    const frame={width:2,height:2,data:new Uint8ClampedArray(16)};
    await assert.rejects(decodeInWorker(frame),/応答が不正/);
  } finally {globalThis.Worker=Original;}
});
