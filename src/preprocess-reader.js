/** Lazily preprocess off the main thread; fallback only without Worker support. */
let worker=null, serial=0;
const jobs=new Map();
function teardown(error){
  worker?.terminate();worker=null;
  for(const job of jobs.values()){
    job.cleanup();
    if(error)job.reject(error);else job.resolve(null);
  }
  jobs.clear();
}
function ensureWorker(){
  if(typeof Worker==='undefined')return null;
  if(worker)return worker;
  try{
    worker=new Worker(new URL('./preprocess-worker.js',import.meta.url),{type:'module'});
    const instance=worker;
    worker.onmessage=({data})=>{
      if(worker!==instance)return;
      const job=jobs.get(data?.id);if(!job)return;
      const valid=!data?.error && data?.width===job.width && data?.height===job.height &&
        data?.buffer instanceof ArrayBuffer && data.buffer.byteLength===job.width*job.height*4;
      if(!valid){teardown(new Error('画像補正ワーカーの処理に失敗したか、応答が不正です。'));return;}
      jobs.delete(data.id);job.cleanup();job.resolve(data);
    };
    worker.onerror=worker.onmessageerror=()=>{
      if(worker===instance)teardown(new Error('画像補正ワーカーを実行できません。再度お試しください。'));
    };
    return worker;
  }catch{throw new Error('画像補正ワーカーを開始できません。ブラウザの設定をご確認ください。');}
}
export async function preprocessInWorker(imageData,options,signal){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const instance=ensureWorker();if(!instance)return null;
  const id=++serial;
  return new Promise((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{signal?.removeEventListener('abort',abort);clearTimeout(timeout);};
    const abort=()=>{
      if(done)return;done=true;jobs.delete(id);cleanup();
      teardown(new DOMException('Cancelled','AbortError'));
      reject(new DOMException('Cancelled','AbortError'));
    };
    const timeout=setTimeout(()=>teardown(new Error('画像補正が時間制限を超えました。画像を縮小して再度お試しください。')),15000);
    jobs.set(id,{width:imageData.width,height:imageData.height,cleanup,
      resolve:(value)=>{if(!done){done=true;resolve(value);}},
      reject:(error)=>{if(!done){done=true;reject(error);}}});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{instance.postMessage({id,width:imageData.width,height:imageData.height,buffer:imageData.data.buffer,options},[imageData.data.buffer]);}
    catch{teardown(new Error('画像を補正ワーカーへ渡せませんでした。再度お試しください。'));}
  });
}
