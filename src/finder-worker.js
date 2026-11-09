import {findQRCorners} from './finder.js';

self.onmessage=({data})=>{
  try{
    const corners=findQRCorners(new Uint8ClampedArray(data.rgba),data.width,data.height);
    self.postMessage({corners});
  }catch(error){self.postMessage({error:error instanceof Error?error.message:'四隅を検出できません。'});}
};
