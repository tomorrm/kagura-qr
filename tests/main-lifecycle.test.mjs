import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function canvas(){
  return {width:100,height:100,getContext:()=>({drawImage(){}})};
}
function bitmap(){
  return {...canvas(),closed:0,close(){this.closed++;}};
}
const repaired=(value='fresh')=>({matches:[value],canvas:canvas(),steps:1});
function harness(overrides={}){
  const nodes=new Map(),windowEvents=new Map(),downloads=[];
  function node(id){
    if(nodes.has(id))return nodes.get(id);
    const listeners=new Map();
    const element={
      ...canvas(),value:'',files:[],textContent:'',hidden:false,disabled:false,
      dataset:{},style:{setProperty(){}},readyState:2,videoWidth:100,videoHeight:100,
      classList:{add(){},remove(){},toggle(){}},
      addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},
      async fire(type,event={}){return Promise.all((listeners.get(type)||[]).map(fn=>fn(event)));},
      setAttribute(){},removeAttribute(){},scrollIntoView(){},focus(){},click(){},pause(){},play:async()=>{},
    };
    nodes.set(id,element);return element;
  }
  node('content-input').value='original';node('signature-expiry').value='60';
  node('error-level').value='M';
  const context=vm.createContext({
    AbortController,DOMException,Blob,Set,Date,JSON,Number,Math,performance:{now:()=>1000},
    setTimeout:()=>1,clearTimeout(){},requestAnimationFrame:fn=>fn(),
    document:{
      getElementById:node,querySelector:node,querySelectorAll:()=>[],
      createElement:()=>node(Symbol()),documentElement:node('root'),addEventListener(){},
    },
    window:{addEventListener:(type,fn)=>windowEvents.set(type,fn),matchMedia:()=>({matches:false})},
    navigator:{mediaDevices:{getUserMedia:async()=>stream()}},
    qrMatrix:()=>[[true]],drawQR(){},
    selectDisplayedPayload:(value,original,encoded,override)=>({
      value:override??value,signed:!!override,signedOriginal:override?value:original,signedEncoded:override??encoded,
    }),
    inspectQRPrint:()=>({status:'pass',issues:[]}),
    inspectContent:()=>({caution:'',url:null}),
    createReplayGuard:()=>{
      const seen=new Set();
      return {observe(key,nonce){const id=key+nonce,had=seen.has(id);seen.add(id);return had;}};
    },
    createSigningIdentity:async()=>({fingerprint:'key'}),
    importSigningIdentity:async data=>data,
    decryptSigningIdentity:async data=>data,
    encryptSigningIdentity:async data=>data,
    verifySignedPayload:async()=>({status:'valid-untrusted',fingerprint:'key'}),
    signPayload:async()=> 'KQR2.signed',
    verifyRevocationList:async()=>({status:'trusted',revokedFingerprints:new Set(),issuedAt:1,expiresAt:Date.now()+10000}),
    bitmapFromFile:async()=>bitmap(),renderSource:()=>canvas(),transformCanvas:()=>canvas(),
    perspectiveRectify:()=>canvas(),readCanvas:async()=>[],autoRepair:async()=>repaired(),
    detectQRCorners:async()=>[],downloadBlob:(...args)=>downloads.push(args),exportCSV:JSON.stringify,
    ...overrides,
  });
  vm.runInContext(source+`;globalThis.app={state,verification,loadRepair,presentResult,renderSignatureVerification,switchTab,resetCorners,startCamera,stopCamera};`,context);
  return {app:context.app,node,context,downloads,pagehide:()=>windowEvents.get('pagehide')()};
}
function stream(){
  const listeners=new Set();
  const track={stopped:0,readyState:'live',stop(){this.stopped++;this.readyState='ended';},
    addEventListener(type,fn){if(type==='ended')listeners.add(fn);},
    removeEventListener(type,fn){if(type==='ended')listeners.delete(fn);},
    end(){this.readyState='ended';for(const fn of [...listeners])fn();},
    get listeners(){return listeners.size;},
    get endedCallback(){return [...listeners][0];},
  };
  return {track,getTracks:()=>[track]};
}
function file(text='{}'){return {size:10,text:async()=>text};}

test('signing cannot commit after content, expiry, or identity changes',async()=>{
  for(const change of [
    h=>{h.node('content-input').value='new';return h.node('content-input').fire('input');},
    h=>{h.node('signature-expiry').value='120';return h.node('signature-expiry').fire('input');},
    h=>{h.app.state.identity={fingerprint:'new'};},
    async h=>{h.node('content-input').value='new';await h.node('content-input').fire('input');h.node('content-input').value='original';await h.node('content-input').fire('input');},
  ]){
    const pending=deferred(),h=harness({signPayload:()=>pending.promise});
    h.app.state.identity={fingerprint:'old'};
    const work=h.node('sign-create').fire('click');
    await change(h);pending.resolve('KQR2.stale');await work;
    assert.notEqual(h.app.state.payload,'KQR2.stale');
  }
});

test('newest signing operation wins over stale success and failure',async()=>{
  for(const fail of [false,true]){
    const a=deferred(),b=deferred();let count=0;
    const h=harness({signPayload:()=>++count===1?a.promise:b.promise});
    const first=h.node('sign-create').fire('click'),second=h.node('sign-create').fire('click');
    b.resolve('KQR2.new');await second;
    if(fail)a.reject(new Error('stale'));else a.resolve('KQR2.old');
    await first;assert.equal(h.app.state.payload,'KQR2.new');assert.equal(h.node('sign-error').textContent,'');
  }
});

test('verification pin and occurrence generations reject same-payload stale trust',async()=>{
  const pending=[],h=harness({verifySignedPayload:()=>{
    const d=deferred();pending.push(d);return d.promise;
  }});
  h.app.state.scanText='KQR2.same';
  const first=h.app.renderSignatureVerification('KQR2.same','scan');
  h.node('scan-trusted-key').value='new-pin';
  await h.node('scan-trusted-key').fire('input');
  pending[1].resolve({status:'revoked',reason:'new-context'});await tick();
  pending[0].resolve({status:'trusted'});await first;
  assert.match(h.node('scan-verdict').textContent,/new-context/);
  const third=h.app.renderSignatureVerification('KQR2.same','scan');
  const fourth=h.app.renderSignatureVerification('KQR2.same','scan');
  pending[3].resolve({status:'replayed',reason:'fresh-occurrence'});await fourth;
  pending[2].resolve({status:'trusted'});await third;
  assert.match(h.node('scan-verdict').textContent,/fresh-occurrence/);
});

test('duplicate occurrence remains replayed through verify, pin, and revocation refresh',async()=>{
  const h=harness({verifySignedPayload:async(value,pin,{replayGuard}={})=>({
    status:replayGuard?.observe('issuer','nonce')?'replayed':'trusted',reason:'duplicate',
  })});
  h.app.presentResult('KQR2.same');await tick();
  assert.match(h.node('scan-verdict').textContent,/✓/);
  h.app.presentResult('KQR2.same');await tick();
  for(const refresh of [
    ()=>h.node('scan-verify').fire('click'),
    ()=>h.node('scan-trusted-key').fire('input'),
    ()=>{h.node('scan-revocation-file').files=[file()];return h.node('scan-revocation-file').fire('change');},
  ]){
    await refresh();await tick();
    assert.match(h.node('scan-verdict').textContent,/duplicate/);
    assert.equal(h.node('scan-revoke').hidden,true);
  }
});

test('stale verification cannot observe replay state before a newer occurrence or pin refresh',async()=>{
  for(const freshOccurrence of [false,true]){
    const pending=[];let observations=0;
    const h=harness({
      createReplayGuard:()=>({observe(){return observations++>0;}}),
      verifySignedPayload:async(_value,_pin,{replayGuard})=>{
        const d=deferred();pending.push(d);await d.promise;
        return {status:replayGuard.observe('issuer','nonce')?'replayed':'trusted',reason:'duplicate'};
      },
    });
    h.app.state.scanText='KQR2.same';
    const old=h.app.renderSignatureVerification('KQR2.same','scan');
    if(!freshOccurrence)h.node('scan-trusted-key').value='new-pin';
    const current=h.app.renderSignatureVerification('KQR2.same','scan',{observeReplay:freshOccurrence});
    const occurrence=h.app.verification.scan.occurrence;
    pending[0].resolve();await old;
    assert.equal(observations,0);
    assert.equal(occurrence.observed,false);
    pending[1].resolve();await current;
    assert.equal(observations,1);
    assert.equal(occurrence.observed,true);
    assert.equal(occurrence.replayed,false);
    assert.match(h.node('scan-verdict').textContent,/✓/);
  }
});

test('revocation refresh invalidates pending same-payload trust on both panels',async()=>{
  const pending=[],h=harness({verifySignedPayload:()=>{
    const d=deferred();pending.push(d);return d.promise;
  }});
  h.app.state.scanText=h.app.state.repairText='KQR2.same';
  const scan=h.app.renderSignatureVerification('KQR2.same','scan');
  const repair=h.app.renderSignatureVerification('KQR2.same','repair');
  h.node('scan-revocation-file').files=[file()];
  await h.node('scan-revocation-file').fire('change');
  pending[2].resolve({status:'revoked',reason:'revoked-now'});
  pending[3].resolve({status:'revoked',reason:'revoked-now'});await tick();
  pending[0].resolve({status:'trusted'});pending[1].resolve({status:'trusted'});
  await Promise.all([scan,repair]);
  for(const panel of ['scan','repair'])assert.match(h.node(`${panel}-verdict`).textContent,/revoked-now/);
});

test('revocation imports enforce latest request, commit watermark, and captured authority',async()=>{
  const pending=[],h=harness({verifyRevocationList:()=>{
    const d=deferred();pending.push(d);return d.promise;
  }});
  const start=()=>{h.node('scan-revocation-file').files=[file()];return h.node('scan-revocation-file').fire('change');};
  const first=start();await tick();const second=start();await tick();
  const result=issuedAt=>({status:'trusted',issuedAt,expiresAt:Date.now()+10000,revokedFingerprints:new Set()});
  pending[1].resolve(result(20));await second;pending[0].resolve(result(10));await first;
  assert.equal(h.app.state.revocationIssuedAt,20);
  const third=start();await tick();h.app.state.revocationIssuedAt=30;
  pending[2].resolve(result(25));await third;assert.equal(h.app.state.revocationIssuedAt,30);
  const fourth=start();await tick();
  h.node('scan-revocation-authority').value='other';await h.node('scan-revocation-authority').fire('input');
  pending[3].resolve(result(40));await fourth;assert.equal(h.app.state.revocationIssuedAt,30);
});

test('identity and administrator imports/generation cannot overwrite newer keys or passphrases',async()=>{
  for(const prefix of ['key','revocation-key']){
    const first=deferred(),second=deferred();let count=0;
    const h=harness({createSigningIdentity:()=>++count===1?first.promise:second.promise});
    const a=h.node(`${prefix}-generate`).fire('click'),b=h.node(`${prefix}-generate`).fire('click');
    second.resolve({fingerprint:'new'});await b;first.resolve({fingerprint:'old'});await a;
    const field=prefix==='key'?'identity':'revocationIdentity';
    assert.equal(h.app.state[field].fingerprint,'new');
    const text=deferred();h.node(`${prefix}-import-file`).files=[{size:10,text:()=>text.promise}];
    h.node(`${prefix}-passphrase`).value='old-pass';
    const imported=h.node(`${prefix}-import-file`).fire('change');
    await h.node(`${prefix}-generate`).fire('click');
    h.node(`${prefix}-passphrase`).value='new-pass';text.resolve('{"fingerprint":"stale"}');await imported;
    assert.equal(h.app.state[field].fingerprint,'new');
    assert.equal(h.node(`${prefix}-passphrase`).value,'new-pass');
  }
});

test('late key decryption cannot replace a newer generated identity',async()=>{
  for(const prefix of ['key','revocation-key']){
    const pending=deferred(),h=harness({decryptSigningIdentity:()=>pending.promise});
    h.node(`${prefix}-import-file`).files=[file('{"format":"KQR-ENCRYPTED-KEY"}')];
    const imported=h.node(`${prefix}-import-file`).fire('change');await tick();
    await h.node(`${prefix}-generate`).fire('click');
    pending.resolve({fingerprint:'old'});await imported;
    assert.equal(h.app.state[prefix==='key'?'identity':'revocationIdentity'].fingerprint,'key');
  }
});

test('camera resumes after temporary missing frame data instead of abandoning a live stream',async()=>{
  const timers=[],capture=stream();let decoded=0;
  const h=harness({
    navigator:{mediaDevices:{getUserMedia:async()=>capture}},
    setTimeout:fn=>{timers.push(fn);return timers.length;},
    readCanvas:async()=>{decoded++;return ['camera-resumed'];},
  });
  h.node('scan-video').readyState=1;
  const work=h.app.startCamera();await tick();
  assert.equal(decoded,0);
  assert.equal(timers.length,1,'camera should wait for another frame');
  h.node('scan-video').readyState=2;
  timers.shift()();await work;
  assert.equal(h.app.state.scanText,'camera-resumed');
  assert.equal(capture.track.stopped,1);
});

test('camera bounds oversized actual frames and releases its canvas after decoding',async()=>{
  let observed;
  const h=harness({readCanvas:async frame=>{
    observed={width:frame.width,height:frame.height,frame};return ['bounded-camera'];
  }});
  h.node('scan-video').videoWidth=3840;h.node('scan-video').videoHeight=2160;
  await h.app.startCamera();
  assert.equal(observed.width,2600);
  assert.equal(observed.height,1463);
  assert.equal(observed.frame.width,0);
  assert.equal(observed.frame.height,0);
});

test('ended camera tracks release frame waits or decoding and cannot stop a replacement',async()=>{
  for(const stage of ['waiting','decoding']){
    const timers=new Map(),capture=stream(),pending=deferred();let serial=0,frame,signal;
    const h=harness({
      navigator:{mediaDevices:{getUserMedia:async()=>capture}},
      setTimeout:fn=>{timers.set(++serial,fn);return serial;},
      clearTimeout:id=>timers.delete(id),
      readCanvas:(value,options)=>{frame=value;signal=options.signal;return pending.promise;},
    });
    h.node('scan-video').readyState=stage==='waiting'?1:2;
    const work=h.app.startCamera();await tick();
    assert.equal(capture.track.listeners,1);
    const oldEnded=capture.track.endedCallback;
    capture.track.end();
    assert.equal(h.app.state.stream,null);
    assert.equal(capture.track.listeners,0);
    assert.equal(timers.size,0,'camera polling timers must be cleared');
    if(signal)assert.equal(signal.aborted,true);
    pending.resolve(['stale']);await work;
    if(frame)assert.equal(frame.width,0);
    assert.equal(h.app.state.scanText,'');
    const next=stream();
    h.context.navigator.mediaDevices.getUserMedia=async()=>next;
    h.node('scan-video').readyState=1;
    const replacement=h.app.startCamera();await tick();
    oldEnded();
    assert.equal(h.app.state.stream,next);
    assert.equal(next.track.stopped,0);
    h.app.stopCamera();await replacement;
    assert.equal(next.track.listeners,0);
  }
});

test('upload takes camera ownership and late old camera decode failure cannot stop a new stream',async()=>{
  const old=deferred(),newDecode=deferred(),streams=[stream(),stream()];let count=0,decodeCount=0;
  const signals=[],h=harness({
    navigator:{mediaDevices:{getUserMedia:async()=>streams[count++]}},
    readCanvas:(_canvas,{signal})=>{signals.push(signal);return ++decodeCount===1?old.promise:newDecode.promise;},
  });
  const first=h.app.startCamera();await tick();
  const second=h.app.startCamera();await tick();
  assert.equal(signals[0].aborted,true);
  old.reject(new Error('old decoder'));await first;
  assert.equal(h.app.state.stream,streams[1]);assert.equal(streams[1].track.stopped,0);
  h.node('scan-file').files=[file()];
  await h.node('scan-file').fire('change');
  assert.equal(streams[1].track.stopped,1);assert.equal(signals[1].aborted,true);
  newDecode.resolve([]);await second;assert.equal(h.app.state.scanText,'fresh');
});

test('starting camera aborts upload; late upload results and errors do not replace camera UI',async()=>{
  for(const fail of [false,true]){
    const pending=deferred(),decode=deferred();let imageSignal;
    const h=harness({autoRepair:(_bitmap,_progress,{signal})=>{imageSignal=signal;return pending.promise;},readCanvas:()=>decode.promise});
    h.node('scan-file').files=[file()];
    const upload=h.node('scan-file').fire('change');await tick();
    const camera=h.app.startCamera();await tick();assert.equal(imageSignal.aborted,true);
    const result=repaired('stale');
    if(fail)pending.reject(new Error('old upload'));else pending.resolve(result);
    await upload;assert.equal(h.app.state.scanText,'');assert.equal(h.node('scan-error').textContent,'');
    if(!fail)assert.equal(result.canvas.width,0);
    h.app.stopCamera();decode.resolve([]);await camera;
  }
});

test('repair controller exists before bitmap loading and closes late bitmaps after exit',async()=>{
  const pending=deferred(),h=harness({bitmapFromFile:()=>pending.promise});
  const work=h.app.loadRepair(file()),controller=h.app.state.repairAbort;
  assert.ok(controller);h.app.switchTab('scan');assert.equal(controller.signal.aborted,true);
  const bmp=bitmap();pending.resolve(bmp);await work;
  assert.equal(bmp.closed,1);assert.equal(h.app.state.repairBitmap,null);assert.equal(h.app.state.repairText,'');
});

test('repair replacement rejects old results, progress, errors and cleanup',async()=>{
  for(const fail of [false,true]){
    const pending=[],h=harness({autoRepair:(_bitmap,progress,{signal})=>{
      const d=deferred();pending.push({...d,progress,signal});return d.promise;
    }});
    const old=h.app.loadRepair(file());await tick();
    const fresh=h.app.loadRepair(file());await tick();
    assert.equal(pending[0].signal.aborted,true);
    const currentController=h.app.state.repairAbort;
    if(fail)pending[0].reject(new Error('old repair'));else pending[0].resolve(repaired('old'));
    await old;assert.equal(h.app.state.repairAbort,currentController);assert.equal(h.app.state.busy,true);
    pending[1].resolve(repaired('new'));await fresh;
    const status=h.node('repair-status').textContent;
    pending[0].progress(1,99,99);
    assert.equal(h.node('repair-status').textContent,status);assert.equal(h.app.state.repairText,'new');
  }
});

test('manual and perspective decoding propagate cancellation and cannot commit after exit',async()=>{
  for(const action of ['manual-apply','perspective-apply']){
    const pending=deferred();let signal;
    const h=harness({readCanvas:(_canvas,options)=>{signal=options.signal;return pending.promise;}});
    h.app.state.repairBitmap=bitmap();h.app.state.perspectivePoints=[{},{},{},{}];
    const work=h.node(action).fire('click');await tick();
    h.app.switchTab('scan');assert.equal(signal.aborted,true);
    pending.resolve(['stale']);await work;assert.equal(h.app.state.repairText,'');
  }
});

test('perspective retries 600 then 800 and preserves the successful canvas before releasing both',async()=>{
  const sizes=[],canvases=[];
  const h=harness({
    perspectiveRectify:(_source,_points,size)=>{
      if(canvases.length)assert.equal(canvases[0].width,0);
      sizes.push(size);
      const corrected={...canvas(),width:size,height:size};canvases.push(corrected);return corrected;
    },
    readCanvas:async source=>source.width===600?[]:['KQR-BENCH:perspective-v1'],
    transformCanvas:()=>assert.fail('adaptive fallback must not run after success'),
  });
  h.app.state.perspectivePoints=[{},{},{},{}];
  await h.node('perspective-apply').fire('click');
  assert.deepEqual(sizes,[600,800]);
  assert.equal(h.app.state.repairText,'KQR-BENCH:perspective-v1');
  assert.equal(h.node('repair-enhanced').width,800);
  assert.ok(canvases.every(source=>source.width===0&&source.height===0));
});

test('perspective cancellation between retries prevents the second allocation and decode',async()=>{
  const pending=deferred(),sizes=[],canvases=[];
  const h=harness({
    perspectiveRectify:(_source,_points,size)=>{
      sizes.push(size);const corrected=canvas();canvases.push(corrected);return corrected;
    },
    readCanvas:()=>pending.promise,
  });
  h.app.state.perspectivePoints=[{},{},{},{}];
  const work=h.node('perspective-apply').fire('click');await tick();
  h.app.switchTab('scan');pending.resolve([]);await work;
  assert.deepEqual(sizes,[600]);
  assert.equal(h.app.state.repairText,'');
  assert.equal(canvases[0].width,0);
});

test('perspective adaptive fallback checks cancellation after both bounded sizes fail',async()=>{
  const pending=deferred(),signals=[];let calls=0;
  const h=harness({readCanvas:(_canvas,{signal})=>{
    signals.push(signal);return ++calls<=2?Promise.resolve([]):pending.promise;
  }});
  h.app.state.perspectivePoints=[{},{},{},{}];
  const work=h.node('perspective-apply').fire('click');await tick();
  assert.equal(calls,3);assert.ok(signals.every(signal=>signal===signals[0]));
  h.pagehide();pending.resolve(['stale']);await work;assert.equal(h.app.state.repairText,'');
});

test('current manual, perspective, and corner results still commit',async()=>{
  for(const action of ['manual-apply','perspective-apply']){
    const h=harness({readCanvas:async()=>['current']});
    h.app.state.repairBitmap=bitmap();h.app.state.perspectivePoints=[{},{},{},{}];
    await h.node(action).fire('click');
    assert.equal(h.app.state.repairText,'current');assert.equal(h.app.state.busy,false);
  }
  const h=harness({detectQRCorners:async()=>[{},{},{},{}]});
  h.app.state.repairBitmap=bitmap();await h.node('perspective-auto-detect').fire('click');
  assert.equal(h.app.state.perspectivePoints.length,4);
  assert.equal(h.node('perspective-auto-detect').disabled,false);
  assert.equal(h.node('perspective-status').textContent,'四隅を自動検出しました。補正して読み取ってください。');
});

test('corner detection ignores results after manual selection, replacement, reset or exit',async()=>{
  for(const invalidate of [
    h=>h.node('perspective-select').fire('click'),
    h=>h.app.loadRepair(file()),
    h=>h.app.resetCorners(),
    h=>h.app.switchTab('scan'),
  ]){
    const pending=deferred();let signal;
    const h=harness({detectQRCorners:(_source,_detector,options)=>{signal=options.signal;return pending.promise;}});
    h.app.state.repairBitmap=bitmap();
    const work=h.node('perspective-auto-detect').fire('click');await tick();
    await invalidate(h);assert.equal(signal.aborted,true);
    pending.resolve([{x:1,y:1},{x:2,y:1},{x:2,y:2},{x:1,y:2}]);await work;
    assert.equal(h.app.state.perspectivePoints.length,0);
  }
});

test('batch cancellation after bitmap or decoder await closes resources without CSV',async()=>{
  for(const stage of ['bitmap','decode']){
    const pending=deferred(),bmp=bitmap(),result=repaired();let signal;
    const h=harness({
      bitmapFromFile:()=>stage==='bitmap'?pending.promise:Promise.resolve(bmp),
      autoRepair:(_bitmap,_progress,options)=>{signal=options.signal;return pending.promise;},
    });
    h.node('scan-batch-files').files=[file()];
    const work=h.node('scan-batch-run').fire('click');await tick();
    const controller=h.app.state.batchAbort;h.app.switchTab('create');assert.equal(controller.signal.aborted,true);
    if(signal)assert.equal(signal.aborted,true);
    pending.resolve(stage==='bitmap'?bmp:result);await work;
    assert.equal(bmp.closed,1);assert.equal(h.downloads.length,0);
    if(stage==='decode')assert.equal(result.canvas.width,0);
  }
});

test('batch AbortError escapes per-file handling and does not continue or export',async()=>{
  let decoded=0,loaded=0;
  const h=harness({
    bitmapFromFile:async()=>{loaded++;return bitmap();},
    autoRepair:async()=>{decoded++;throw new DOMException('Cancelled','AbortError');},
  });
  h.node('scan-batch-files').files=[file(),file()];
  await h.node('scan-batch-run').fire('click');
  assert.equal(loaded,1);assert.equal(decoded,1);assert.equal(h.downloads.length,0);
});

test('batch cancel aborts the owner and resets controls without stale-finally interference',async()=>{
  const pending=[],h=harness({bitmapFromFile:()=>{
    const d=deferred();pending.push(d);return d.promise;
  }});
  h.node('scan-batch-files').files=[file()];
  h.node('scan-batch-cancel').hidden=true;
  const first=h.node('scan-batch-run').fire('click');
  const oldController=h.app.state.batchAbort;
  assert.equal(h.node('scan-batch-cancel').hidden,false);
  assert.equal(h.node('scan-batch-run').disabled,true);
  await h.node('scan-batch-cancel').fire('click');
  assert.equal(oldController.signal.aborted,true);
  const second=h.node('scan-batch-run').fire('click');
  const currentController=h.app.state.batchAbort;
  pending[0].resolve(bitmap());await first;
  assert.equal(h.app.state.batchAbort,currentController);
  assert.equal(h.node('scan-batch-cancel').hidden,false);
  assert.equal(h.node('scan-batch-run').disabled,true);
  await h.node('scan-batch-cancel').fire('click');
  pending[1].resolve(bitmap());await second;
  assert.equal(h.app.state.batchAbort,null);
  assert.equal(h.node('scan-batch-cancel').hidden,true);
  assert.equal(h.node('scan-batch-run').disabled,false);
  assert.equal(h.downloads.length,0);
  assert.match(h.node('scan-batch-status').textContent,/中断/);
});

test('pagehide aborts every owned controller including pending image and corner work',()=>{
  const h=harness(),controllers=[];
  for(const field of ['scanAbort','cameraAbort','repairAbort','pdfAbort','batchAbort','cornerAbort']){
    const controller=new AbortController();h.app.state[field]=controller;controllers.push(controller);
  }
  h.pagehide();assert.ok(controllers.every(controller=>controller.signal.aborted));
});
