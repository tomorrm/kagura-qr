/* Classic worker; qr pixels never leave the device. jsQR is bundled locally. */
'use strict';
let decoder;
let wasmReady;
async function readFrame(data,width,height,multi) {
  if(typeof WebAssembly!=='object')return null;
  if(!wasmReady){
    importScripts('../vendor/zxing-reader.js');
    wasmReady=self.ZXingWASM.prepareZXingModule({
      overrides:{locateFile:()=>new URL('../vendor/zxing_reader.wasm',self.location.href).href},
      fireImmediately:true
    });
  }
  await wasmReady;
  const results=await self.ZXingWASM.readBarcodes({data,width,height},{
    formats:['QRCode'],tryHarder:true,tryInvert:true,
    maxNumberOfSymbols:multi?16:1,textMode:'Plain'
  });
  return [...new Set(results.filter(result=>result.isValid&&
    typeof result.text==='string'&&result.text.length>0).map(result=>result.text))];
}
function readQR(pixels, width, height) {
  const code = decoder(pixels, width, height, {inversionAttempts:'attemptBoth'});
  return typeof code?.data === 'string' && code.data.length ? code.data : null;
}
function cropRGBA(pixels, fullWidth, region) {
  const {x,y,width,height}=region;
  const out=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++) {
    const from=((y+row)*fullWidth+x)*4;
    out.set(pixels.subarray(from,from+width*4), row*width*4);
  }
  return out;
}
self.onmessage = async event => {
  const {id, rgba, width, height, regions=[], multi}=event.data || {};
  try {
    if(!Number.isSafeInteger(id) || !Number.isInteger(width) || !Number.isInteger(height) ||
        width<1 || height<1 || width*height>2600**2 ||
        !(rgba instanceof ArrayBuffer) || rgba.byteLength!==width*height*4 ||
        !Array.isArray(regions) || regions.length>12 ||
        (multi!==undefined&&typeof multi!=='boolean')) throw Error('Invalid worker input');
    for(const region of regions){
      const {x,y,width:w,height:h}=region || {};
      if(![x,y,w,h].every(Number.isInteger) || x<0 || y<0 || w<1 || h<1 || x+w>width || y+h>height)
        throw Error('Invalid region');
    }
    const data=new Uint8ClampedArray(rgba);
    const matches=await readFrame(data,width,height,multi??regions.length>0);
    if(matches!==null){self.postMessage({id,matches});return;}
    if(!decoder) {
      importScripts('../vendor/jsQR.js');
      if(typeof self.jsQR !== 'function') throw Error('Local decoder unavailable');
      decoder=self.jsQR;
    }
    const found=new Set();
    const first=readQR(data,width,height);
    if(first)found.add(first);
    for(const region of regions) {
      if(found.size>=16)break;
      const {width:w,height:h}=region;
      const result=readQR(cropRGBA(data,width,region),w,h);
      if(result)found.add(result);
    }
    self.postMessage({id, matches:[...found]});
  } catch {
    self.postMessage({id, error:'Local QR decoder failed'});
  }
};
