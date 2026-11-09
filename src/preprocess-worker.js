/* Module worker — preprocess locally, with transferable buffers and bounded inputs. */
import {enhanceRGBA} from './transform-kernel.js';
self.onmessage=({data})=>{
  const {id,width,height,buffer,options}=data||{};
  try{
    if(!Number.isSafeInteger(id) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width<1 || height<1 || width*height>2600**2 ||
      !(buffer instanceof ArrayBuffer) || buffer.byteLength!==width*height*4) throw Error('Invalid buffer');
    const rgba=new Uint8ClampedArray(buffer);
    enhanceRGBA(rgba,width,height,options);
    self.postMessage({id,width,height,buffer},[buffer]);
  }catch(e){self.postMessage({id,error:String(e?.message||'Enhancement error')});}
};
