/** Pure, bounded QR luminance / threshold transformation. No DOM access. */
export function enhanceRGBA(pixels,width,height,{contrast=0,threshold='none',invert=false}={}) {
  if (!(pixels instanceof Uint8ClampedArray) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width<1 || height<1 || width*height>2600**2 || pixels.length!==width*height*4 ||
      !Number.isFinite(contrast) || Math.abs(contrast)>200 ||
      !['none','auto','adaptive'].includes(threshold) || typeof invert!=='boolean') throw Error('Invalid enhancement input');
  const factor=(259*(contrast+255))/(255*(259-contrast));
  const gray=new Uint8Array(width*height), histogram=new Uint32Array(256);
  for(let p=0,i=0;p<gray.length;p++,i+=4){
    const raw=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2];
    const v=Math.round(Math.max(0,Math.min(255,factor*(raw-128)+128)));
    gray[p]=v; histogram[v]++;
  }
  let limit=128;
  if(threshold==='auto') {
    let sum=0; for(let i=0;i<256;i++)sum+=i*histogram[i];
    let bgCount=0,bgSum=0,max=-1;
    for(let i=0;i<256;i++){
      bgCount+=histogram[i]; bgSum+=i*histogram[i];
      const fgCount=gray.length-bgCount;
      if(!bgCount||!fgCount)continue;
      const variance=(bgSum/bgCount-(sum-bgSum)/fgCount)**2*bgCount*fgCount;
      if(variance>max){max=variance;limit=i;}
    }
  }
  let binary=null;
  if(threshold==='adaptive'){
    const stride=width+1,integral=new Float64Array(stride*(height+1));
    for(let y=1;y<=height;y++){
      let line=0;const src=(y-1)*width,base=y*stride,previous=(y-1)*stride;
      for(let x=1;x<=width;x++){line+=gray[src+x-1];integral[base+x]=integral[previous+x]+line;}
    }
    binary=new Uint8Array(width*height);
    const radius=Math.max(9,Math.min(35,Math.round(Math.min(width,height)/55)));
    for(let y=0;y<height;y++){
      const y0=Math.max(0,y-radius),y1=Math.min(height,y+radius+1);
      for(let x=0;x<width;x++){
        const x0=Math.max(0,x-radius),x1=Math.min(width,x+radius+1);
        const mean=(integral[y1*stride+x1]-integral[y0*stride+x1]-integral[y1*stride+x0]+integral[y0*stride+x0])/((x1-x0)*(y1-y0));
        binary[y*width+x]=gray[y*width+x]>mean-7?255:0;
      }
    }
  }
  for(let p=0,i=0;p<gray.length;p++,i+=4){
    let v=binary?binary[p]:threshold==='auto'?(gray[p]>limit?255:0):gray[p];
    if(invert)v=255-v;
    pixels[i]=pixels[i+1]=pixels[i+2]=v;
  }
  return pixels;
}
