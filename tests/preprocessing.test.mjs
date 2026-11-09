import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enhanceRGBA} from '../src/transform-kernel.js';
import {preprocessInWorker} from '../src/preprocess-reader.js';
import {readFile} from 'node:fs/promises';

const rgba = (values) => new Uint8ClampedArray(values.flatMap(n=>[n,n,n,255]));
test('pure QR preprocessing preserves bounds and distinguishes threshold variants',()=>{
  const image=rgba([20,40,200,240]);
  const normal=enhanceRGBA(image.slice(),2,2,{threshold:'auto'});
  assert.deepEqual([normal[0],normal[4],normal[8],normal[12]],[0,0,255,255]);
  const inverted=enhanceRGBA(image.slice(),2,2,{threshold:'auto',invert:true});
  assert.deepEqual([inverted[0],inverted[4],inverted[8],inverted[12]],[255,255,0,0]);
  assert.equal(enhanceRGBA(image.slice(),2,2,{threshold:'none'})[0],20);
  const gradient=new Uint8ClampedArray(12*12*4);
  for(let i=0;i<gradient.length;i+=4){gradient[i]=gradient[i+1]=gradient[i+2]=Math.round(i/gradient.length*255);gradient[i+3]=255;}
  const adapt=enhanceRGBA(gradient,12,12,{threshold:'adaptive'});
  assert.equal(adapt.length,gradient.length);
  assert.ok([...adapt].every((v,i)=>i%4===3? v===255:v===0||v===255));
});
test('pixel kernel fails closed on corrupt sizes and untrusted options',()=>{
  for(const [bytes,w,h,options] of [
    [rgba([0]),2,2,{}], [rgba([0]),1,1,{threshold:'unknown'}],
    [rgba([0]),1,1,{contrast:259}], [rgba([0]),0,1,{}],
    [rgba([0]),1,1,{invert:'yes'}]
  ]) assert.throws(()=>enhanceRGBA(bytes,w,h,options));
});
test('preprocess module worker enforces local import and input validation',async()=>{
  const source=await readFile(new URL('../src/preprocess-worker.js',import.meta.url),'utf8');
  assert.match(source,/from '\.\/transform-kernel\.js'/);
  assert.match(source,/buffer\.byteLength!==width\*height\*4/);
  assert.doesNotMatch(source,/fetch\(|https:\/\//);
});
test('preprocess worker respects cancellation before work starts',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(preprocessInWorker({width:1,height:1,data:rgba([0])},{threshold:'auto'},controller.signal),{name:'AbortError'});
});

test('preprocess worker transfers original pixels and returns enhanced RGBA',async()=>{
  const Original=globalThis.Worker;
  class FakeWorker {
    constructor(url,config){assert.match(String(url),/preprocess-worker\.js$/);assert.equal(config.type,'module');this.onmessage=null;}
    postMessage(message,transfer){
      assert.equal(transfer.length,1);assert.equal(transfer[0],message.buffer);
      const data=new Uint8ClampedArray(message.buffer);
      enhanceRGBA(data,message.width,message.height,message.options);
      queueMicrotask(()=>this.onmessage?.({data:{id:message.id,width:message.width,height:message.height,buffer:data.buffer}}));
    }
    terminate(){}
  }
  try {
    globalThis.Worker=FakeWorker;
    const frame={width:2,height:2,data:rgba([0,45,200,255])};
    const result=await preprocessInWorker(frame,{threshold:'auto'});
    assert.deepEqual([...new Uint8ClampedArray(result.buffer).filter((_,i)=>i%4===0)],[0,0,255,255]);
  } finally {globalThis.Worker=Original;}
});
