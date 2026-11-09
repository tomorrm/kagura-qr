import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {createHash} from 'node:crypto';
import {prepareZXingModule,readBarcodes,ZXING_WASM_SHA256} from 'zxing-wasm/reader';
import {qrMatrix} from '../src/generator.js';

const binary=await readFile(new URL('../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',import.meta.url));
prepareZXingModule({overrides:{wasmBinary:binary}});

function raster(text,scale=3){
  const matrix=qrMatrix(text,'M'),width=(matrix.length+8)*scale;
  const data=new Uint8ClampedArray(width*width*4).fill(255);
  for(let y=0;y<width;y++)for(let x=0;x<width;x++){
    const bit=matrix[Math.floor(y/scale)-4]?.[Math.floor(x/scale)-4];
    if(bit){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
  }
  return {data,width,height:width};
}

test('pinned reader WASM matches its package integrity hash',()=>{
  assert.equal(createHash('sha256').update(binary).digest('hex'),ZXING_WASM_SHA256);
});

for(const expected of ['plain synthetic QR','日本語と絵文字 🦊\n改行','https://example.test/?x=%20','\u0000binary-text\u0001']){
  test(`local WASM preserves exact text fixture ${JSON.stringify(expected)}`,async()=>{
    const results=await readBarcodes(raster(expected),{formats:['QRCode'],textMode:'Plain',maxNumberOfSymbols:16});
    assert.deepEqual(results.filter(r=>r.isValid).map(r=>r.text),[expected]);
  });
}

test('local WASM returns no fabricated payload for seeded noise',async()=>{
  const width=400,data=new Uint8ClampedArray(width*width*4);
  let state=20261105;
  for(let i=0;i<data.length;i+=4){
    for(let c=0;c<3;c++){state=(Math.imul(state,1664525)+1013904223)>>>0;data[i+c]=state>>>24;}
    data[i+3]=255;
  }
  assert.deepEqual(await readBarcodes({data,width,height:width},{formats:['QRCode'],tryHarder:true}),[]);
});

async function workerHarness(){
  const messages=[],imports=[],options=[];
  const self={location:{href:'https://example.test/subpath/src/decode-worker.js'},
    postMessage:message=>messages.push(message),ZXingWASM:{
      prepareZXingModule:config=>{options.push(config);return Promise.resolve();},
      readBarcodes:async(_frame,config)=>{options.push(config);return [{isValid:true,text:'exact'},{isValid:false,text:'bad'}];}
    }};
  runInNewContext(await readFile(new URL('../src/decode-worker.js',import.meta.url),'utf8'),{
    self,WebAssembly:{},URL,Uint8ClampedArray,ArrayBuffer,Array,Number,Error,String,Set,
    importScripts:path=>imports.push(path)
  });
  return {self,messages,imports,options,input:()=>({data:{id:1,rgba:new ArrayBuffer(16),width:2,height:2}})};
}

test('worker initializes once with only a subpath-safe local WASM URL',async()=>{
  const h=await workerHarness();
  await h.self.onmessage(h.input());
  await h.self.onmessage(h.input());
  assert.deepEqual(h.imports,['../vendor/zxing-reader.js']);
  assert.equal(h.options[0].overrides.locateFile('unexpected-name.wasm'),'https://example.test/subpath/vendor/zxing_reader.wasm');
  assert.equal(h.options[1].maxNumberOfSymbols,1);
  assert.equal(h.options[1].textMode,'Plain');
  assert.deepEqual(Array.from(h.messages[0].matches),['exact']);
});

test('worker module initialization failures are explicit and reveal no private input',async()=>{
  const h=await workerHarness();
  h.self.ZXingWASM.prepareZXingModule=()=>Promise.reject(new Error('private data must not be reported'));
  await h.self.onmessage(h.input());
  assert.deepEqual({...h.messages[0]},{id:1,error:'Local QR decoder failed'});
});

test('malformed tile regions are rejected before loading or decoding WASM',async()=>{
  const h=await workerHarness();
  await h.self.onmessage({data:{...h.input().data,regions:[{x:-1,y:0,width:2,height:2}]}});
  assert.equal(h.imports.length,0);
  assert.equal(h.messages[0].error,'Local QR decoder failed');
});

test('explicit multi-QR mode is preserved when a small raster has no tile regions',async()=>{
  const h=await workerHarness();
  await h.self.onmessage({data:{...h.input().data,multi:true,regions:[]}});
  assert.equal(h.options[1].maxNumberOfSymbols,16);
  const invalid=await workerHarness();
  await invalid.self.onmessage({data:{...invalid.input().data,multi:'true'}});
  assert.equal(invalid.imports.length,0);
  assert.equal(invalid.messages[0].error,'Local QR decoder failed');
});

test('worker reader forwards explicit multi-QR mode independently of tile selection',async()=>{
  const saved=globalThis.Worker;
  let message;
  globalThis.Worker=class {
    postMessage(data){message=data;queueMicrotask(()=>this.onmessage({data:{id:data.id,matches:[]}}));}
    terminate(){}
  };
  try{
    const module=await import('../src/worker-reader.js?small-multi');
    await module.decodeInWorker({data:new Uint8ClampedArray(16),width:2,height:2},[],undefined,true);
    assert.equal(message.multi,true);
    module.cancelWorkerDecoding();
  }finally{globalThis.Worker=saved;}
});

test('concurrent worker messages share pending module initialization and retain request IDs',async()=>{
  const h=await workerHarness();
  let release,initializations=0;
  const ready=new Promise(resolve=>{release=resolve;});
  h.self.ZXingWASM.prepareZXingModule=()=>{initializations++;return ready;};
  const first=h.self.onmessage(h.input());
  const second=h.self.onmessage({data:{...h.input().data,id:2}});
  assert.equal(initializations,1);
  assert.equal(h.messages.length,0);
  release();
  await Promise.all([first,second]);
  assert.deepEqual(h.messages.map(message=>message.id),[1,2]);
});

test('worker reader rejects decoder errors rather than retrying on the UI thread',async()=>{
  const saved=globalThis.Worker;
  let instance;
  globalThis.Worker=class {
    constructor(){instance=this;}
    postMessage({id}){queueMicrotask(()=>this.onmessage({data:{id,error:'decoder failed'}}));}
    terminate(){}
  };
  try{
    const {decodeInWorker,cancelWorkerDecoding}=await import('../src/worker-reader.js?wasm-failure');
    await assert.rejects(decodeInWorker({data:new Uint8ClampedArray(16),width:2,height:2}),/読取エンジン/);
    cancelWorkerDecoding();
    assert.ok(instance);
  }finally{
    if(saved===undefined)delete globalThis.Worker;else globalThis.Worker=saved;
  }
});
