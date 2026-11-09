import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getEventListeners} from 'node:events';
import {runInNewContext} from 'node:vm';
import {pdfRasterSize,validatePdfFile} from '../src/pdf-reader.js';

test('PDF uploads are type-checked and byte bounded',()=>{
  assert.throws(()=>validatePdfFile({name:'image.png',type:'image/png',size:100}));
  assert.throws(()=>validatePdfFile({name:'scan.pdf',type:'application/pdf',size:7}));
  assert.throws(()=>validatePdfFile({name:'scan.pdf',type:'application/pdf',size:20*1024*1024+1}));
  assert.doesNotThrow(()=>validatePdfFile({name:'scan.pdf',type:'application/pdf',size:100}));
  assert.doesNotThrow(()=>validatePdfFile({name:'scan.PDF',type:'',size:100}));
});

test('PDF raster dimensions fit edge and pixel budgets before canvas allocation',()=>{
  const size=pdfRasterSize(3200,2400);
  assert.ok(size.width<=1600&&size.height<=1600);
  assert.ok(size.width*size.height<=2_400_000);
  assert.deepEqual(pdfRasterSize(450,450),{width:450,height:450});
  assert.throws(()=>pdfRasterSize(0,100));
  assert.throws(()=>pdfRasterSize(100_001,100));
  assert.throws(()=>pdfRasterSize(NaN,100));
});

for(const stage of ['loading','page','before-render','rendering']) {
  test(`PDF cancellation during ${stage} destroys once and releases abort listeners`,async()=>{
    const controller=new AbortController();
    let destroyed=0,allocated=0,rendered=0,cleaned=0,progress=0;
    let reachStage;
    const reached=new Promise(resolve=>{reachStage=resolve;});
    const pending=new Promise(()=>{});
    let rejectRender;
    const renderPromise=new Promise((resolve,reject)=>{rejectRender=reject;});
    const page={
      getViewport:()=>({width:100,height:100}),
      render:()=>{
        rendered++;reachStage();
        return {promise:renderPromise,cancel:()=>rejectRender(new Error('Rendering cancelled'))};
      },
      cleanup:()=>{cleaned++;}
    };
    const documentProxy={
      numPages:1,
      getPage:()=>{
        if(stage==='page'){reachStage();return pending;}
        if(stage==='before-render'){
          const result=Promise.resolve(page);
          result.then(()=>controller.abort());
          return result;
        }
        return Promise.resolve(page);
      }
    };
    const source=(await readFile(new URL('../src/pdf-reader.js',import.meta.url),'utf8'))
      .replace(/^import .*;\n/gm,'')
      .replace("await import('pdfjs-dist/legacy/build/pdf.mjs')",'mockPdfjs')
      .replaceAll('export ','')
      .replaceAll('import.meta.url',JSON.stringify(import.meta.url));
    const scan=runInNewContext(`${source}\nscanPdfFile`,{
      URL,DOMException,Uint8Array,
      mockPdfjs:{
        GlobalWorkerOptions:{},AnnotationMode:{DISABLE:0},
        getDocument:()=>{
          if(stage==='loading')reachStage();
          return {promise:stage==='loading'?pending:Promise.resolve(documentProxy),
            destroy:async()=>{destroyed++;}};
        }
      },
      autoRepair:()=>{throw new Error('Cancelled PDF must not be decoded');},
      document:{createElement:()=>{
        allocated++;
        return {width:0,height:0,getContext:()=>({fillRect:()=>{}})};
      }}
    });
    const result=scan({name:'test.pdf',type:'application/pdf',size:8,
      arrayBuffer:async()=>new ArrayBuffer(8)},{
      signal:controller.signal,onProgress:()=>{progress++;}
    });
    const rejected=assert.rejects(result,{name:'AbortError'});
    if(stage!=='before-render'){await reached;controller.abort();}
    await rejected;
    assert.equal(destroyed,1);
    assert.equal(progress,0);
    assert.equal(allocated,stage==='rendering'?1:0);
    assert.equal(rendered,stage==='rendering'?1:0);
    assert.equal(cleaned,stage==='rendering'?1:0);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
  });
}
