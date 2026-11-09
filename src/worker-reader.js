/** Bounded, lazy browser worker. Only missing Worker support allows fallback. */
let worker=null;
let sequence=0;
const pending=new Map();
function shutdown(error){
  worker?.terminate();worker=null;
  for(const job of pending.values()){
    job.cleanup();
    if(error)job.reject(error);else job.resolve(null);
  }
  pending.clear();
}
function ensureWorker(){
  if(typeof Worker==='undefined')return null;
  if(worker)return worker;
  try {
    worker=new Worker(new URL('./decode-worker.js',import.meta.url));
    const instance=worker;
    worker.onmessage=({data})=>{
      if(worker!==instance)return;
      const job=pending.get(data?.id);if(!job)return;
      if(data?.error){shutdown(new Error('ローカルQR読取エンジンの実行に失敗しました。再読み込みしてお試しください。'));return;}
      const valid=!data?.error && Array.isArray(data?.matches) && data.matches.length<=16 &&
        data.matches.every(value=>typeof value==='string' && value.length>0 && value.length<=8192);
      if(!valid){shutdown(new Error('QR読取ワーカーの応答が不正です。'));return;}
      pending.delete(data.id);job.cleanup();job.resolve(data.matches);
    };
    worker.onerror=worker.onmessageerror=()=>{
      if(worker===instance)shutdown(new Error('QR読取ワーカーを実行できません。再度お試しください。'));
    };
  } catch {throw new Error('QR読取ワーカーを開始できません。ブラウザの設定をご確認ください。');}
  return worker;
}
export function cancelWorkerDecoding(){shutdown(new DOMException('Cancelled','AbortError'));}
export async function decodeInWorker(imageData, regions=[], signal, multi=regions.length>0){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const current=ensureWorker();if(!current)return null;
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{signal?.removeEventListener('abort',abort);clearTimeout(timeout);};
    const abort=()=>{
      pending.delete(id);cleanup();reject(new DOMException('Cancelled','AbortError'));
      shutdown(new DOMException('Cancelled','AbortError'));
    };
    const timeout=setTimeout(()=>shutdown(new Error('QR読み取りが時間制限を超えました。画像を縮小して再度お試しください。')),15000);
    pending.set(id,{resolve,reject,cleanup});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try {
      current.postMessage({id,width:imageData.width,height:imageData.height,
        rgba:imageData.data.buffer,regions,multi},[imageData.data.buffer]);
    }catch {shutdown(new Error('画像をQR読取ワーカーへ渡せませんでした。再度お試しください。'));}
  });
}
