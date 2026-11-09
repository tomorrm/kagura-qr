import {autoRepair} from './processor.js';

const MAX_PDF_BYTES=20*1024*1024;
const MAX_PAGES=10;
const MAX_PAGE_EDGE=1600;
const MAX_PAGE_PIXELS=2_400_000;
const MAX_PAGE_POINTS=100_000;

export function validatePdfFile(file) {
  if(!file || (file.type!=='application/pdf'&&!/\.pdf$/i.test(file.name||'')))
    throw new Error('PDFファイルを選択してください。');
  if(!Number.isSafeInteger(file.size)||file.size<8)throw new Error('PDFが空か破損しています。');
  if(file.size>MAX_PDF_BYTES)throw new Error('PDFは20MB以下にしてください。');
}

export function pdfRasterSize(width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||
      width>MAX_PAGE_POINTS||height>MAX_PAGE_POINTS) {
    throw new Error('PDFページの寸法が不正か大きすぎます。');
  }
  const scale=Math.min(1,MAX_PAGE_EDGE/Math.max(width,height),
    Math.sqrt(MAX_PAGE_PIXELS/(width*height)));
  return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
}

export async function scanPdfFile(file,{signal,onProgress=()=>{}}={}) {
  validatePdfFile(file);
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const data=new Uint8Array(await file.arrayBuffer());
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const pdfjsLib=await import('pdfjs-dist/legacy/build/pdf.mjs');
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  pdfjsLib.GlobalWorkerOptions.workerSrc=new URL('../vendor/pdf.worker.mjs',import.meta.url).href;
  const loadingTask=pdfjsLib.getDocument({
    data,
    isEvalSupported:false,
    enableXfa:false,
    useSystemFonts:true,
    useWorkerFetch:true,
    cMapUrl:new URL('../vendor/pdf-cmaps/',import.meta.url).href,
    cMapPacked:true,
    standardFontDataUrl:new URL('../vendor/pdf-standard-fonts/',import.meta.url).href,
    wasmUrl:new URL('../vendor/pdf-wasm/',import.meta.url).href,
    maxImageSize:MAX_PAGE_PIXELS
  });
  let destruction;
  const destroy=()=>destruction??=Promise.resolve().then(()=>loadingTask.destroy());
  let rejectAbort;
  const cancelled=new Promise((resolve,reject)=>{rejectAbort=reject;});
  const abort=()=>{
    rejectAbort(new DOMException('Cancelled','AbortError'));
    void destroy();
  };
  signal?.addEventListener('abort',abort,{once:true});
  let documentProxy;
  const results=[];
  try {
    if(signal?.aborted)abort();
    documentProxy=await Promise.race([loadingTask.promise,cancelled]);
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    if(documentProxy.numPages<1||documentProxy.numPages>MAX_PAGES) {
      throw new Error(`PDFは1〜${MAX_PAGES}ページまで読み取れます。`);
    }
    for(let pageNumber=1;pageNumber<=documentProxy.numPages;pageNumber++) {
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      let page,canvas,renderTask;
      try {
        page=await Promise.race([documentProxy.getPage(pageNumber),cancelled]);
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        const base=page.getViewport({scale:1});
        const size=pdfRasterSize(base.width,base.height);
        const scale=Math.min(size.width/base.width,size.height/base.height);
        const viewport=page.getViewport({scale});
        canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.floor(viewport.width));
        canvas.height=Math.max(1,Math.floor(viewport.height));
        const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
        if(!context)throw new Error('PDFページの描画に失敗しました。');
        context.fillStyle='#fff';
        context.fillRect(0,0,canvas.width,canvas.height);
        renderTask=page.render({canvasContext:context,viewport,
          annotationMode:pdfjsLib.AnnotationMode.DISABLE,background:'rgb(255,255,255)'});
        const cancel=()=>renderTask.cancel();
        signal?.addEventListener('abort',cancel,{once:true});
        try {await renderTask.promise;}
        finally {signal?.removeEventListener('abort',cancel);}
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        const decoded=await autoRepair(canvas,()=>{},{signal,maxProfiles:8});
        decoded.canvas.width=decoded.canvas.height=0;
        if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
        results.push({page:pageNumber,status:decoded.matches.length?'ok':'unreadable',matches:decoded.matches});
      } catch(error) {
        if(signal?.aborted||error?.name==='AbortError')throw new DOMException('Cancelled','AbortError');
        results.push({page:pageNumber,status:'error',error:error instanceof Error?error.message:'ページを読み取れませんでした。'});
      } finally {
        if(renderTask&&signal?.aborted)renderTask.cancel();
        if(canvas)canvas.width=canvas.height=0;
        page?.cleanup();
      }
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      onProgress(pageNumber,documentProxy.numPages,results.at(-1));
    }
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    return {pageCount:documentProxy.numPages,results};
  } catch(error) {
    if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
    throw error;
  } finally {
    signal?.removeEventListener('abort',abort);
    try {await destroy();}
    catch(error) {
      if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
      throw error;
    }
  }
}
