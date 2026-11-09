import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';

for(const operation of ['readCanvas','detectQRCorners']){
  for(const stage of ['formats','detect']){
    test(`${operation} cancels a native ${stage} promise that ignores its signal`,async()=>{
      const original=Object.getOwnPropertyDescriptor(globalThis,'BarcodeDetector');
      let markStarted,settle;
      const started=new Promise(resolve=>{markStarted=resolve;});
      const pending=new Promise(resolve=>{settle=resolve;});
      class Detector {
        static getSupportedFormats(){
          if(stage==='formats'){markStarted();return pending;}
          return Promise.resolve(['qr_code']);
        }
        detect(){markStarted();return pending;}
      }
      globalThis.BarcodeDetector=Detector;
      try{
        const processor=await import(`../src/processor.js?native-cancel=${operation}-${stage}`);
        const owner=new AbortController();
        const input={width:10,height:10};
        const result=operation==='readCanvas'
          ? processor.readCanvas(input,{signal:owner.signal})
          : processor.detectQRCorners(input,Detector,{signal:owner.signal});
        const rejected=assert.rejects(result,{name:'AbortError'});
        await started;
        owner.abort();
        await rejected;
        assert.equal(getEventListeners(owner.signal,'abort').length,0);
        settle([]);
        await new Promise(resolve=>setImmediate(resolve));
      }finally{
        if(original)Object.defineProperty(globalThis,'BarcodeDetector',original);
        else delete globalThis.BarcodeDetector;
      }
    });
  }
}

test('successful native reads also remove their cancellation listener',async()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'BarcodeDetector');
  globalThis.BarcodeDetector=class {
    static async getSupportedFormats(){return ['qr_code'];}
    async detect(){return [{rawValue:'public synthetic test'}];}
  };
  try{
    const {readCanvas}=await import('../src/processor.js?native-cancel=success');
    const owner=new AbortController();
    assert.deepEqual(await readCanvas({}, {signal:owner.signal}),['public synthetic test']);
    assert.equal(getEventListeners(owner.signal,'abort').length,0);
  }finally{
    if(original)Object.defineProperty(globalThis,'BarcodeDetector',original);
    else delete globalThis.BarcodeDetector;
  }
});
