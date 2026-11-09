import {decodeInWorker} from './worker-reader.js';
import {preprocessInWorker} from './preprocess-reader.js';
import {findQRCorners} from './finder.js';
// All processing is local. Avoid keeping raw decoded content in localStorage/logs.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2600;
const MAX_DECODE_PIXELS = 40_000_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function validateImage(file) {
  if (!file || !ALLOWED_MIME.has(file.type)) throw new Error('PNG / JPEG / WebP形式の画像を選択してください。');
  if (!Number.isSafeInteger(file.size) || file.size < 24) throw new Error('画像が空か破損しています。');
  if (file.size > MAX_FILE_BYTES) throw new Error('20MB以下の画像を選択してください。');
}

/** Read image dimensions from the compressed header BEFORE allocating a decoded bitmap. */
export function probeImageDimensions(bytes, mime) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mime === 'image/png' && data.length >= 24 &&
      [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((n,i)=>data[i]===n) &&
      String.fromCharCode(...data.subarray(12,16)) === 'IHDR') {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {width:view.getUint32(16), height:view.getUint32(20)};
  }
  if (mime === 'image/webp' && data.length >= 30 &&
      String.fromCharCode(...data.subarray(0,4)) === 'RIFF' &&
      String.fromCharCode(...data.subarray(8,12)) === 'WEBP') {
    const format = String.fromCharCode(...data.subarray(12,16));
    if (format === 'VP8X') return {width:1+data[24]+(data[25]<<8)+(data[26]<<16), height:1+data[27]+(data[28]<<8)+(data[29]<<16)};
    if (format === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a)
      return {width:(data[26]|(data[27]<<8))&0x3fff, height:(data[28]|(data[29]<<8))&0x3fff};
    if (format === 'VP8L' && data[20] === 0x2f)
      return {width:1+data[21]+((data[22]&63)<<8), height:1+(data[22]>>6)+(data[23]<<2)+((data[24]&15)<<10)};
  }
  if (mime === 'image/jpeg' && data.length >= 11 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 4 < data.length) {
      if (data[i] !== 0xff) break;
      let marker = data[++i]; while (marker === 0xff && i + 1 < data.length) marker = data[++i];
      i++;
      if (marker === 0xda || marker === 0xd9) break;
      if (i + 1 >= data.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (data[i]<<8)|data[i+1];
      if (length < 2 || i + length > data.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 7) break;
        return {height:(data[i+3]<<8)|data[i+4], width:(data[i+5]<<8)|data[i+6]};
      }
      i += length;
    }
  }
  return null;
}

export function assertImageDimensions(dimensions) {
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width > 15000 || dimensions.height > 15000 ||
      dimensions.width * dimensions.height > MAX_DECODE_PIXELS) {
    throw new Error('画像の寸法を確認できないか、大きすぎます（最大4,000万画素）。');
  }
}

export async function bitmapFromFile(file) {
  validateImage(file);
  const header = new Uint8Array(await file.slice(0, 131072).arrayBuffer());
  assertImageDimensions(probeImageDimensions(header, file.type));
  // createImageBitmap is not universal in older WebKit contexts. Use an
  // HTMLImageElement fallback with the same width/height/close interface.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try { assertImageDimensions({width:bitmap.width, height:bitmap.height}); }
    catch (e) { bitmap.close(); throw e; }
    return bitmap;
  }
  const url=URL.createObjectURL(file);
  try {
    const image=new Image();
    image.decoding='async';
    image.src=url;
    await image.decode();
    assertImageDimensions({width:image.naturalWidth,height:image.naturalHeight});
    return {width:image.naturalWidth,height:image.naturalHeight,
      image, close(){image.src='';URL.revokeObjectURL(url);}};
  } catch(error) {URL.revokeObjectURL(url);throw error;}
}

export function renderSource(bitmap, rotation = 0, maxEdge = MAX_IMAGE_EDGE) {
  const ratio = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const rotated = ((rotation % 360) + 360) % 360;
  const flip = rotated === 90 || rotated === 270;
  const canvas = document.createElement('canvas'); canvas.width = flip ? h : w; canvas.height = flip ? w : h;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(rotated * Math.PI / 180);
  ctx.drawImage(bitmap.image || bitmap, -w/2, -h/2, w, h);
  return canvas;
}

/** A local-mean threshold, robust against gradients and uneven illumination. */
export function adaptiveThreshold(grayscale, width, height, radius = 15, bias = 7) {
  if (width < 1 || height < 1 || grayscale.length !== width * height || width * height > MAX_IMAGE_EDGE ** 2) {
    throw new Error('画像のサイズが不正です。');
  }
  const stride = width + 1;
  // Number is important: summing 2600² pixels can overflow a Uint32 under future limits.
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y++) {
    let sum = 0;
    const src = (y - 1) * width;
    const dest = y * stride, above = dest - stride;
    for (let x = 1; x <= width; x++) {
      sum += grayscale[src + x - 1];
      integral[dest + x] = integral[above + x] + sum;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
    const topRow = top * stride, bottomRow = bottom * stride;
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
      const sum = integral[bottomRow + right] - integral[topRow + right] -
                  integral[bottomRow + left] + integral[topRow + left];
      const mean = sum / ((right - left) * (bottom - top));
      out[y * width + x] = grayscale[y * width + x] > mean - bias ? 255 : 0;
    }
  }
  return out;
}

export function cropCenter(source, fraction = 0.75) {
  const width = Math.max(1, Math.floor(source.width * fraction));
  const height = Math.max(1, Math.floor(source.height * fraction));
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  c.getContext('2d', {willReadFrequently:true}).drawImage(source,
    Math.floor((source.width - width) / 2), Math.floor((source.height - height) / 2),
    width, height, 0, 0, width, height);
  return c;
}

/** Maps unit-square coordinates to a four-corner quadrilateral. Corners: TL, TR, BR, BL. */
export function perspectiveMap(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))) {
    throw new Error('左上・右上・右下・左下の四隅を選んでください。');
  }
  const cross = (a,b,c) => (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
  const turns = points.map((p,i) => cross(p,points[(i+1)%4],points[(i+2)%4]));
  if (turns.some(t=>Math.abs(t)<1e-5) || turns.some(t=>t*turns[0] <= 0)) {
    throw new Error('四隅は交差しない四角形になるように選択してください。');
  }
  const [tl,tr,br,bl]=points;
  const dx1=tr.x-br.x, dx2=bl.x-br.x, dx3=tl.x-tr.x+br.x-bl.x;
  const dy1=tr.y-br.y, dy2=bl.y-br.y, dy3=tl.y-tr.y+br.y-bl.y;
  const den=dx1*dy2-dx2*dy1;
  if (Math.abs(den)<1e-6) throw new Error('座標の変換を計算できません。');
  const g=(dx3*dy2-dx2*dy3)/den;
  const h=(dx1*dy3-dx3*dy1)/den;
  const a=tr.x-tl.x+g*tr.x, b=bl.x-tl.x+h*bl.x;
  const d=tr.y-tl.y+g*tr.y, e=bl.y-tl.y+h*bl.y;
  return (u,v) => {
    const w=g*u+h*v+1;
    if (Math.abs(w)<1e-8) throw new Error('台形補正に失敗しました。');
    return {x:(a*u+b*v+tl.x)/w,y:(d*u+e*v+tl.y)/w};
  };
}

export function perspectiveRectify(source, points, size = 800) {
  if (!Number.isInteger(size) || size<100 || size>1300) throw new Error('補正画像サイズが不正です。');
  if (points.some(p=>p.x<0 || p.y<0 || p.x>source.width || p.y>source.height)) throw new Error('画像の外側が指定されています。');
  const map=perspectiveMap(points);
  const pixels=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height);
  const output=document.createElement('canvas');output.width=output.height=size;
  const ctx=output.getContext('2d',{willReadFrequently:true});
  const image=ctx.createImageData(size,size);
  for (let y=0; y<size; y++) for(let x=0; x<size; x++) {
    const dest=(y*size+x)*4;
    if(x<32||y<32||x>=size-32||y>=size-32){
      image.data[dest]=image.data[dest+1]=image.data[dest+2]=image.data[dest+3]=255;
      continue;
    }
    const pos=map((x-32+.5)/(size-64)*1.04-.02,(y-32+.5)/(size-64)*1.04-.02);
    const sx=Math.max(0,Math.min(source.width-1,Math.round(pos.x)));
    const sy=Math.max(0,Math.min(source.height-1,Math.round(pos.y)));
    const src=(sy*source.width+sx)*4;
    image.data[dest]=pixels.data[src];image.data[dest+1]=pixels.data[src+1];
    image.data[dest+2]=pixels.data[src+2];image.data[dest+3]=255;
  }
  ctx.putImageData(image,0,0);
  return output;
}

function validCorners(corners,source) {
  if(!Array.isArray(corners)||corners.length!==4)return false;
  if(corners.some(point=>!Number.isFinite(point?.x)||!Number.isFinite(point?.y)||
      point.x<0||point.y<0||point.x>source.width||point.y>source.height))return false;
  try {perspectiveMap(corners);return true;}catch{return false;}
}

function findInWorker(frame,signal) {
  if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  if(typeof Worker!=='function')return Promise.resolve(findQRCorners(frame.data,frame.width,frame.height));
  return new Promise((resolve,reject)=>{
    let worker;
    try {worker=new Worker(new URL('./finder-worker.js',import.meta.url),{type:'module'});}
    catch {
      reject(new DOMException('四隅検出ワーカーを開始できません。','NotSupportedError'));
      return;
    }
    let finished=false;
    const finish=(error,corners)=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker.terminate();
      if(error)reject(error);else resolve(corners);
    };
    const cancel=()=>finish(new DOMException('Cancelled','AbortError'));
    const timer=setTimeout(()=>finish(new Error('四隅検出が時間制限を超えました。手動で指定してください。')),5000);
    signal?.addEventListener('abort',cancel,{once:true});
    worker.onmessage=({data})=>{
      if(data?.error)finish(new Error(data.error));
      else if(data?.corners===null||validCorners(data?.corners,frame))finish(null,data.corners);
      else finish(new Error('四隅検出の応答が不正です。'));
    };
    worker.onerror=()=>finish(new DOMException('四隅検出ワーカーを実行できません。','NotSupportedError'));
    try {
      if(signal?.aborted){cancel();return;}
      worker.postMessage({rgba:frame.data.buffer,width:frame.width,height:frame.height},[frame.data.buffer]);
    }
    catch(error){finish(error);}
  });
}

export async function detectQRCorners(source, Detector=globalThis.BarcodeDetector,{signal}={}) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  let nativeError;
  if(typeof Detector==='function'){
    try{
      const formats=await waitWithSignal(Detector.getSupportedFormats(),signal);
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      if(formats.includes('qr_code')){
        const results=await waitWithSignal(new Detector({formats:['qr_code']}).detect(source),signal);
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        for(const result of results){
          if(result?.format!=='qr_code'||!Array.isArray(result.cornerPoints)||result.cornerPoints.length!==4)continue;
          const corners=result.cornerPoints.map(point=>({x:point.x,y:point.y}));
          if(validCorners(corners,source))return corners;
        }
      }
    }catch(error){
      if(signal?.aborted||error?.name==='AbortError')throw error;
      nativeError=error;
    }
  }
  const corners=await locateFinderCorners(source,signal);
  if(corners)return corners;
  throw new Error('QRコードの四隅を検出できませんでした。手動で指定してください。',{cause:nativeError});
}

async function locateFinderCorners(source,signal) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const reduced=renderSource(source,0,960);
  try{
    const frame=reduced.getContext('2d',{willReadFrequently:true}).getImageData(0,0,reduced.width,reduced.height);
    let corners;
    try {corners=await findInWorker(frame,signal);}
    catch(error){
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      if(error?.name!=='NotSupportedError')throw error;
      const local=reduced.getContext('2d',{willReadFrequently:true}).getImageData(0,0,reduced.width,reduced.height);
      corners=findQRCorners(local.data,local.width,local.height);
    }
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(corners){
      const scaled=corners.map(p=>({x:p.x*source.width/reduced.width,y:p.y*source.height/reduced.height}));
      if(validCorners(scaled,source))return scaled;
    }
  }finally{reduced.width=reduced.height=0;}
  return null;
}

export async function repairPerspective(source,{signal}={}) {
  const points=await locateFinderCorners(source,signal);
  if(!points)return null;
  for(const size of [600,800]){
    let canvas=perspectiveRectify(source,points,size),keep=false;
    try{
      const matches=await readCanvas(canvas,{signal});
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      if(matches.length){keep=true;return {matches,canvas};}
    }finally{if(!keep)canvas.width=canvas.height=0;}
  }
  return null;
}

/** Auto repair performs pixel transforms in a module Worker where supported.
 * Browsers without Worker support use the original main-thread path. */
export async function transformCanvasAsync(source,options={},signal){
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const output=document.createElement('canvas');output.width=source.width;output.height=source.height;
  const ctx=output.getContext('2d',{willReadFrequently:true});
  try{
    ctx.drawImage(source,0,0);
    if(!options.contrast && (!options.threshold||options.threshold==='none') && !options.invert)return output;
    const frame=ctx.getImageData(0,0,output.width,output.height);
    const enhanced=await preprocessInWorker(frame,options,signal);
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(enhanced){ctx.putImageData(new ImageData(new Uint8ClampedArray(enhanced.buffer),enhanced.width,enhanced.height),0,0);return output;}
    output.width=output.height=0;
    return transformCanvas(source,options);
  } catch(e){output.width=output.height=0;throw e;}
}

export function transformCanvas(source, {contrast=0, threshold='none', invert=false}={}) {
  const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
  const ctx = canvas.getContext('2d', {willReadFrequently:true}); ctx.drawImage(source, 0, 0);
  if (!contrast && threshold === 'none' && !invert) return canvas;
  const frame = ctx.getImageData(0,0,canvas.width,canvas.height);
  const d = frame.data; const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  let thresholdValue = 128;
  if (threshold === 'auto') {
    const hist = new Uint32Array(256);
    for (let i=0; i<d.length; i+=4) hist[Math.round(.2126*d[i]+.7152*d[i+1]+.0722*d[i+2])]++;
    let total=0, weighted=0; for(let i=0;i<256;i++){total+=hist[i]; weighted+=i*hist[i];}
    let below=0, sumBelow=0, best=-1;
    for(let i=0;i<256;i++) {below+=hist[i];sumBelow+=i*hist[i];if(!below||below===total)continue;
      const between=(weighted*below/total-sumBelow)**2/(below*(total-below));
      if(between>best){best=between;thresholdValue=i;}
    }
  }
  const gray = threshold === 'adaptive' ? new Uint8Array(d.length / 4) : null;
  for (let i=0;i<d.length;i+=4) {
    let v=Math.min(255,Math.max(0,factor*(.2126*d[i]+.7152*d[i+1]+.0722*d[i+2]-128)+128));
    if(threshold==='auto') v=v>thresholdValue?255:0;
    if(gray) gray[i/4] = v;
    if(invert)v=255-v;
    d[i]=d[i+1]=d[i+2]=v;
  }
  if (gray) {
    const radius = Math.max(9, Math.min(35, Math.round(Math.min(canvas.width, canvas.height) / 55)));
    const binary = adaptiveThreshold(gray, canvas.width, canvas.height, radius);
    for (let i=0;i<binary.length;i++) d[i*4]=d[i*4+1]=d[i*4+2]=invert?255-binary[i]:binary[i];
  }
  ctx.putImageData(frame,0,0); return canvas;
}

function waitWithSignal(task,signal) {
  if(!signal)return task;
  return new Promise((resolve,reject)=>{
    const finish=(callback,value)=>{signal.removeEventListener('abort',abort);callback(value);};
    const abort=()=>finish(reject,new DOMException('Cancelled','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(task).then(value=>finish(resolve,value),error=>finish(reject,error));
    if(signal.aborted)abort();
  });
}

let detectorPromise;
async function getDetector() {
  if (!detectorPromise) detectorPromise = (async () => {
    if (!('BarcodeDetector' in globalThis)) return null;
    try {
      const formats=await globalThis.BarcodeDetector.getSupportedFormats();
      return formats.includes('qr_code') ? new globalThis.BarcodeDetector({formats:['qr_code']}) : null;
    } catch {return null;}
  })();
  return detectorPromise;
}

let jsqrPromise;
async function getJsQR() {
  if (typeof globalThis.jsQR === 'function') return globalThis.jsQR;
  if (!jsqrPromise) jsqrPromise = new Promise((resolve) => {
    // Source is vendored by `pnpm build`. No image content is ever sent externally.
    const s=document.createElement('script'); s.src='./vendor/jsQR.js'; s.onload=()=>resolve(globalThis.jsQR || null); s.onerror=()=>resolve(null); document.head.appendChild(s);
  });
  return jsqrPromise;
}

/** Search a large photograph in overlapping tiles after the full-frame scan.
 * This is a fallback for QR regions that are too small to decode after scaling.
 * Never claim that a tile count equals the physical number of printed symbols.
 */
export function tileRegions(width,height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<1 || height<1 || width*height>MAX_IMAGE_EDGE**2)
    throw new Error('タイル探索の画像寸法が不正です。');
  if (Math.min(width,height)<400) return [];
  const out=[];
  for (const scale of [0.66,0.48]) {
    const w=Math.ceil(width*scale),h=Math.ceil(height*scale);
    for (const yf of [0,0.5,1]) for (const xf of [0,0.5,1]) {
      const x=Math.round((width-w)*xf), y=Math.round((height-h)*yf);
      if (!out.some(q=>q.x===x&&q.y===y&&q.width===w&&q.height===h))out.push({x,y,width:w,height:h});
    }
  }
  return out;
}

export async function readCanvas(canvas,{multi=false,signal}={}) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const detector = await waitWithSignal(getDetector(),signal);
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const found=new Set();
  if (detector) {
    try {
      const results=await waitWithSignal(detector.detect(canvas),signal);
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      for(const item of results){if(item.rawValue)found.add(item.rawValue);}
      if(found.size&&!multi)return [...found];
    } catch(error) {
      if(signal?.aborted||error?.name==='AbortError')throw new DOMException('Cancelled','AbortError');
      // Unsupported native image handling falls back to the local decoder.
    }
  }
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if(!ctx)throw new Error('画像の読み取りに失敗しました。');
  const regions=multi ? tileRegions(canvas.width,canvas.height) : [];
  const selected=[...regions.slice(0,9),...[9,13,17].map(i=>regions[i]).filter(Boolean)];
  // The worker owns its transferable RGBA buffer. It also performs tile fallback,
  // avoiding a succession of heavy synchronous jsQR calls on the UI thread.
  const workerResult=await decodeInWorker(ctx.getImageData(0,0,canvas.width,canvas.height),selected,signal,multi);
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  if(workerResult!==null) return [...new Set([...found,...workerResult])];
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const jsQR=await waitWithSignal(getJsQR(),signal);
  if (!jsQR) {
    if(detector)return [...found];
    throw new Error('読取エンジンが見つかりません。READMEに従ってpnpm install後にビルドしてください。');
  }
  const data=ctx.getImageData(0,0,canvas.width,canvas.height);
  const result=jsQR(data.data,data.width,data.height,{inversionAttempts:'attemptBoth'});
  if(result?.data)found.add(result.data);
  if (!multi) return [...found];
  const tile=document.createElement('canvas');
  const tctx=tile.getContext('2d',{willReadFrequently:true});
  try {
    for (const region of selected) {
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      tile.width=region.width;tile.height=region.height;
      tctx.drawImage(canvas,region.x,region.y,region.width,region.height,0,0,region.width,region.height);
      const rgba=tctx.getImageData(0,0,region.width,region.height);
      const foundTile=jsQR(rgba.data,rgba.width,rgba.height,{inversionAttempts:'attemptBoth'});
      if(foundTile?.data)found.add(foundTile.data);
      if(found.size>=16)break;
    }
  } finally {tile.width=tile.height=0;}
  return [...found];
}

export function repairProfiles() {
  const profiles = [
    {rotation:0, contrast:0, threshold:'none'},
    {rotation:0, contrast:32, threshold:'none'},
    {rotation:0, contrast:0, threshold:'auto'},
    {rotation:0, contrast:0, threshold:'adaptive'},
    {rotation:0, contrast:35, threshold:'adaptive'},
    {rotation:0, contrast:0, threshold:'none', invert:true},
    {rotation:0, contrast:0, threshold:'adaptive', invert:true},
    {rotation:0, contrast:0, threshold:'auto', invert:true},
    {rotation:90, contrast:0, threshold:'none'},
    {rotation:90, contrast:0, threshold:'adaptive'},
    {rotation:180, contrast:0, threshold:'none'},
    {rotation:180, contrast:0, threshold:'auto'},
    {rotation:270, contrast:0, threshold:'none'},
    {rotation:270, contrast:0, threshold:'adaptive'},
    {rotation:0, contrast:0, threshold:'none', crop:0.72},
    {rotation:0, contrast:0, threshold:'adaptive', crop:0.72},
    {rotation:0, contrast:0, threshold:'auto', crop:0.72},
    {rotation:0, contrast:0, threshold:'adaptive', crop:0.52},
  ];
  // Full-resolution retry for small QR areas in large photographs.
  profiles.push({rotation:0, contrast:0, threshold:'none', maxEdge:2600});
  profiles.push({rotation:0, contrast:0, threshold:'adaptive', maxEdge:2600});
  return profiles;
}

export async function autoRepair(bitmap, onProgress = () => {}, {signal:ownerSignal, maxProfiles=20,perspective=true}={}) {
  if(ownerSignal?.aborted)throw new DOMException('Cancelled','AbortError');
  const controller=new AbortController(),signal=controller.signal;
  const cancel=()=>controller.abort();
  ownerSignal?.addEventListener('abort',cancel,{once:true});
  let expired=false;
  const deadline=setTimeout(()=>{expired=true;controller.abort();},15000);
  let bestCanvas=null, returnedCanvas=null;
  try {
    const all=repairProfiles();
    const profiles=all.slice(0,Math.max(1,Math.min(all.length,Math.trunc(maxProfiles)||20)));
    for (let i=0; i<profiles.length; i++) {
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      const options = profiles[i];
      const base = renderSource(bitmap, options.rotation, options.maxEdge || 1700);
      const input = options.crop ? cropCenter(base, options.crop) : base;
      let candidate;
      try {candidate=await transformCanvasAsync(input, options, signal);}
      finally {
        if(input!==base){input.width=input.height=0;}
        base.width=base.height=0;
      }
      if (i === 3)bestCanvas=candidate;
      try {
        onProgress((i+1)/profiles.length,i+1,profiles.length);
        const matches=await readCanvas(candidate,{multi:i===0||i===3,signal});
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        if (matches.length) {
          returnedCanvas=candidate;
          return {matches,canvas:candidate,steps:i+1,options};
        }
      } finally {
        if(candidate!==bestCanvas&&candidate!==returnedCanvas)candidate.width=candidate.height=0;
      }
      if(typeof requestAnimationFrame==='function'){
        await new Promise(resolve=>{
          const finish=()=>{cancelAnimationFrame(frame);signal.removeEventListener('abort',finish);resolve();};
          const frame=requestAnimationFrame(finish);
          signal.addEventListener('abort',finish,{once:true});
          if(signal.aborted)finish();
        });
      }
    }
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(perspective&&profiles.length===all.length){
      const source=renderSource(bitmap,0,1700);
      let candidate;
      try{
        const corrected=await repairPerspective(source,{signal});
        if(corrected){
          candidate=corrected.canvas;
          returnedCanvas=candidate;
          return {...corrected,steps:profiles.length+1,options:{perspective:true}};
        }
      }finally{
        source.width=source.height=0;
        if(candidate&&candidate!==returnedCanvas)candidate.width=candidate.height=0;
      }
    }
    if(bestCanvas) {returnedCanvas=bestCanvas;return {matches:[],canvas:bestCanvas,steps:profiles.length,options:{}};}
    const base=renderSource(bitmap,0,1700);
    try {returnedCanvas=transformCanvas(base,{threshold:'adaptive'});}
    finally {base.width=base.height=0;}
    return {matches:[],canvas:returnedCanvas,steps:profiles.length,options:{}};
  } catch(error) {
    if(expired&&!ownerSignal?.aborted)throw new Error('自動補正が時間制限を超えました。画像を縮小するか、手動補正をお試しください。');
    throw error;
  } finally {
    clearTimeout(deadline);
    ownerSignal?.removeEventListener('abort',cancel);
    if(bestCanvas && bestCanvas!==returnedCanvas)bestCanvas.width=bestCanvas.height=0;
  }
}
