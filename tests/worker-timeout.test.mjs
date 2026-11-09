import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';

for(const name of ['worker-reader','preprocess-reader']){
  for(const failure of ['error','messageerror','postMessage','invalid','reported']){
    test(`${name} ${failure} rejects all owners, releases resources and permits a fresh worker`,async()=>{
      const saved=globalThis.Worker,workers=[];
      let failSend=false;
      class FakeWorker{
        constructor(){workers.push(this);}
        postMessage(data){if(failSend)throw new Error('private data');this.last=data;}
        terminate(){this.terminated=true;}
      }
      globalThis.Worker=FakeWorker;
      try{
        const module=await import(`../src/${name}.js?failure-${failure}`);
        const image=()=>({width:2,height:2,data:new Uint8ClampedArray(16)});
        const run=signal=>name==='worker-reader'
          ?module.decodeInWorker(image(),[],signal)
          :module.preprocessInWorker(image(),{},signal);
        const owner=new AbortController(),first=run(owner.signal);
        const a=assert.rejects(first,error=>error.message!=='private data');
        failSend=failure==='postMessage';
        const second=run(),b=assert.rejects(second);
        const instance=workers[0];
        if(failure==='error')instance.onerror({message:'private data'});
        if(failure==='messageerror')instance.onmessageerror?.({});
        if(failure==='invalid')instance.onmessage({data:{id:instance.last.id,matches:[{}],buffer:new ArrayBuffer(3)}});
        if(failure==='reported')instance.onmessage({data:{id:instance.last.id,error:'private data'}});
        await Promise.all([a,b]);
        assert.equal(instance.terminated,true);
        assert.equal(getEventListeners(owner.signal,'abort').length,0);
        failSend=false;
        const next=run();
        assert.equal(workers.length,2);
        const {id}=workers[1].last;
        workers[1].onmessage({data:name==='worker-reader'
          ?{id,matches:['ok']}
          :{id,width:2,height:2,buffer:new ArrayBuffer(16)}});
        assert.notEqual(await next,null);
        if(name==='worker-reader')module.cancelWorkerDecoding();
      }finally{globalThis.Worker=saved;}
    });
  }
  test(`${name} constructor failure is explicit; missing Worker alone allows compatibility fallback`,async()=>{
    const saved=globalThis.Worker;
    try{
      globalThis.Worker=class {constructor(){throw new Error('private data');}};
      const module=await import(`../src/${name}.js?constructor-error`);
      const image=()=>({width:2,height:2,data:new Uint8ClampedArray(16)});
      const run=()=>name==='worker-reader'?module.decodeInWorker(image()):module.preprocessInWorker(image(),{});
      await assert.rejects(run(),error=>error.message!=='private data');
      globalThis.Worker=undefined;
      assert.equal(await run(),null);
    }finally{globalThis.Worker=saved;}
  });
  test(`${name} abort rejects concurrent owners instead of sending them to synchronous fallback`,async()=>{
    const saved=globalThis.Worker;
    const workers=[];
    class FakeWorker{
      constructor(){workers.push(this);}
      postMessage(data){this.last=data;}
      terminate(){this.terminated=true;}
    }
    globalThis.Worker=FakeWorker;
    try{
      const module=await import(`../src/${name}.js?abort-regression`);
      const image=()=>({width:2,height:2,data:new Uint8ClampedArray(16)});
      const run=signal=>name==='worker-reader'
        ?module.decodeInWorker(image(),[],signal)
        :module.preprocessInWorker(image(),{},signal);
      const firstOwner=new AbortController(),secondOwner=new AbortController();
      const first=run(firstOwner.signal),second=run(secondOwner.signal);
      const rejected=Promise.all([
        assert.rejects(first,{name:'AbortError'}),
        assert.rejects(second,{name:'AbortError'})
      ]);
      firstOwner.abort();
      await rejected;
      assert.equal(workers[0].terminated,true);
      assert.equal(getEventListeners(firstOwner.signal,'abort').length,0);
      assert.equal(getEventListeners(secondOwner.signal,'abort').length,0);
      const next=run();
      assert.equal(workers.length,2);
      const {id}=workers[1].last;
      workers[1].onmessage({data:name==='worker-reader'
        ?{id,matches:['ok']}
        :{id,width:2,height:2,buffer:new ArrayBuffer(16)}});
      assert.notEqual(await next,null);
    }finally{
      for(const instance of workers)instance.terminate();
      globalThis.Worker=saved;
    }
  });
  test(`${name} timeout terminates all pending work without retrying on the UI thread`,async()=>{
    const saved={Worker:globalThis.Worker,setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
    const workers=[],timers=new Map();
    let timerId=0;
    class FakeWorker{
      constructor(){workers.push(this);}
      postMessage(data){this.last=data;}
      terminate(){this.terminated=true;}
    }
    globalThis.Worker=FakeWorker;
    globalThis.setTimeout=callback=>{timers.set(++timerId,callback);return timerId;};
    globalThis.clearTimeout=id=>timers.delete(id);
    try{
      const module=await import(`../src/${name}.js?timeout-regression`);
      const image=()=>({width:2,height:2,data:new Uint8ClampedArray(16)});
      const run=()=>name==='worker-reader'?module.decodeInWorker(image()):module.preprocessInWorker(image(),{});
      const first=run(),second=run();
      const rejected=Promise.all([
        assert.rejects(first,/時間制限/),
        assert.rejects(second,/時間制限/)
      ]);
      assert.equal(workers.length,1);
      timers.values().next().value();
      await rejected;
      assert.equal(workers[0].terminated,true);
      assert.equal(timers.size,0);
      const next=run();
      assert.equal(workers.length,2,'a fresh request must not be forced into synchronous fallback');
      const {id}=workers[1].last;
      workers[1].onmessage({data:name==='worker-reader'
        ?{id,matches:['ok']}
        :{id,width:2,height:2,buffer:new ArrayBuffer(16)}});
      assert.notEqual(await next,null);
      assert.equal(timers.size,0);
      if(name==='worker-reader')module.cancelWorkerDecoding();
    }finally{
      for(const instance of workers)instance.terminate();
      Object.assign(globalThis,saved);
    }
  });
}
