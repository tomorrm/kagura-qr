import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {getEventListeners} from 'node:events';

async function harness(){
  const source=await readFile(new URL('../src/processor.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('export async function autoRepair')).replace('export async','async');
  const timers=new Map(),canvases=[];
  let serial=0,reading=false;
  let markStarted;
  const started=new Promise(resolve=>{markStarted=resolve;});
  const canvas=()=>{const result={width:2,height:2};canvases.push(result);return result;};
  const context={
    AbortController,DOMException,Error,Math,
    setTimeout(callback,delay){assert.equal(delay,15000);timers.set(++serial,callback);return serial;},
    clearTimeout(id){timers.delete(id);},
    repairProfiles:()=>[{}],renderSource:canvas,
    transformCanvasAsync:async()=>canvas(),
    readCanvas:(_canvas,{signal})=>new Promise((resolve,reject)=>{
      reading=true;
      markStarted();
      signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
    }),
  };
  runInNewContext(body+'\nglobalThis.run=autoRepair;',context);
  return {run:context.run,timers,canvases,context,started,isReading:()=>reading};
}

test('repair has a shared 15-second budget rather than unbounded per-profile retries',async()=>{
  const h=await harness(),owner=new AbortController();
  const result=h.run({},()=>{},{signal:owner.signal});
  const rejected=assert.rejects(result,/時間制限/);
  await h.started;
  assert.equal(h.isReading(),true);
  h.timers.values().next().value();
  await rejected;
  assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
  assert.equal(h.timers.size,0);
  assert.equal(getEventListeners(owner.signal,'abort').length,0);
});

test('explicit repair cancellation remains AbortError, not a time-limit error',async()=>{
  const h=await harness(),owner=new AbortController();
  const result=h.run({},()=>{},{signal:owner.signal});
  const rejected=assert.rejects(result,{name:'AbortError'});
  await h.started;
  owner.abort();
  await rejected;
  assert.equal(h.timers.size,0);
  assert.equal(getEventListeners(owner.signal,'abort').length,0);
  assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
});

test('repair deadline wakes a suspended animation-frame yield',async()=>{
  const h=await harness();
  let scheduled=false,cancelled=false;
  let markScheduled;
  const ready=new Promise(resolve=>{markScheduled=resolve;});
  h.context.readCanvas=async()=>[];
  h.context.requestAnimationFrame=()=>{scheduled=true;markScheduled();return 7;};
  h.context.cancelAnimationFrame=id=>{assert.equal(id,7);cancelled=true;};
  const result=h.run({});
  const rejected=assert.rejects(result,/時間制限/);
  await ready;
  assert.equal(scheduled,true);
  h.timers.values().next().value();
  await rejected;
  assert.equal(cancelled,true);
  assert.equal(h.timers.size,0);
});

test('successful repair clears its deadline without releasing the returned canvas',async()=>{
  const h=await harness(),owner=new AbortController();
  h.context.readCanvas=async()=>['expected'];
  const result=await h.run({},()=>{},{signal:owner.signal});
  assert.equal(result.canvas.width,2);
  assert.equal(result.matches[0],'expected');
  assert.equal(h.timers.size,0);
  assert.equal(getEventListeners(owner.signal,'abort').length,0);
});

test('invalid profile arguments also release the deadline and owner listener',async()=>{
  const h=await harness(),owner=new AbortController();
  await assert.rejects(h.run({},()=>{},{signal:owner.signal,maxProfiles:Symbol('invalid')}),{name:'TypeError'});
  assert.equal(h.timers.size,0);
  assert.equal(getEventListeners(owner.signal,'abort').length,0);
});
