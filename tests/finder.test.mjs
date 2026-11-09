import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qrMatrix} from '../src/generator.js';
import {findQRCorners} from '../src/finder.js';
import {detectQRCorners} from '../src/processor.js';
import {getEventListeners} from 'node:events';

function frame(matrix,{rotate=false,damage=false}={}) {
  const module=6,border=30,size=matrix.length*module+border*2;
  const data=new Uint8ClampedArray(size*size*4).fill(255);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const mx=Math.floor((x-border)/module),my=Math.floor((y-border)/module);
    if(mx<0||my<0||mx>=matrix.length||my>=matrix.length)continue;
    if(damage&&mx>=matrix.length-7&&my<7)continue;
    const dark=rotate?matrix[matrix.length-1-mx][my]:matrix[my][mx];
    if(dark){const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=0;}
  }
  return {data,size,border,module};
}

for(const rotate of [false,true])test(`finder geometry locates QR bounds without decoding (rotated=${rotate})`,()=>{
  const matrix=qrMatrix('finder regression payload','H');
  const {data,size,border,module}=frame(matrix,{rotate});
  const corners=findQRCorners(data,size,size);
  assert.ok(corners);
  for(const p of corners){
    assert.ok(Math.min(Math.abs(p.x-border),Math.abs(p.x-(border+matrix.length*module)))<4);
    assert.ok(Math.min(Math.abs(p.y-border),Math.abs(p.y-(border+matrix.length*module)))<4);
  }
});

test('finder rejects missing finder, blank images, noise and invalid dimensions',()=>{
  const {data,size}=frame(qrMatrix('missing finder','H'),{damage:true});
  assert.equal(findQRCorners(data,size,size),null);
  assert.equal(findQRCorners(new Uint8ClampedArray(128*128*4).fill(255),128,128),null);
  const noise=Uint8ClampedArray.from({length:128*128*4},(_,i)=>(i*31+i*i)%256);
  assert.equal(findQRCorners(noise,128,128),null);
  assert.throws(()=>findQRCorners(new Uint8ClampedArray(4),961,961));
  assert.throws(()=>findQRCorners(new Uint8ClampedArray(4),NaN,1));
});

test('finder fits a projective quadrilateral from three nested rings, not decoded bytes',()=>{
  const matrix=qrMatrix('projective finder geometry','H'),size=500,n=matrix.length+8;
  const data=new Uint8ClampedArray(size*size*4).fill(255);
  const project=(u,v)=>({x:(350*u+40*v+40)/(1+.3*v),y:(30*u+400*v+30)/(1+.3*v)});
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=350,b=40-.3*x,c=30,d=400-.3*y;
    const determinant=a*d-b*c;
    const u=((x-40)*d-b*(y-30))/determinant;
    const v=(a*(y-30)-(x-40)*c)/determinant;
    const mx=Math.floor(u*n)-4,my=Math.floor(v*n)-4;
    if(mx>=0&&my>=0&&mx<matrix.length&&my<matrix.length&&matrix[my][mx]){
      const i=(y*size+x)*4;data[i]=data[i+1]=data[i+2]=0;
    }
  }
  const corners=findQRCorners(data,size,size);
  assert.ok(corners);
  const lo=4/n,hi=(n-4)/n;
  const expected=[[lo,lo],[hi,lo],[hi,hi],[lo,hi]].map(([u,v])=>project(u,v));
  for(let i=0;i<4;i++)assert.ok(Math.hypot(corners[i].x-expected[i].x,corners[i].y-expected[i].y)<4);
});

test('finder worker abort and invalid response release worker, listeners and canvas',async()=>{
  const savedDocument=globalThis.document,savedWorker=globalThis.Worker;
  const canvases=[],workers=[];
  globalThis.document={createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({
      translate(){},rotate(){},drawImage(){},
      getImageData:()=>({width:100,height:100,data:new Uint8ClampedArray(40000).fill(255)})
    })};
    canvases.push(canvas);return canvas;
  }};
  globalThis.Worker=class{
    constructor(){workers.push(this);}
    postMessage(){}
    terminate(){this.terminated=true;}
  };
  try{
    const controller=new AbortController();
    const pending=detectQRCorners({width:100,height:100},null,{signal:controller.signal});
    controller.abort();
    await assert.rejects(pending,{name:'AbortError'});
    assert.equal(workers[0].terminated,true);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    assert.equal(canvases[0].width,0);
    const invalid=detectQRCorners({width:100,height:100},null);
    workers[1].onmessage({data:{corners:[{x:NaN,y:0}]}});
    await assert.rejects(invalid,/応答が不正/);
    assert.equal(workers[1].terminated,true);
    assert.equal(canvases[1].width,0);
  }finally{
    if(savedDocument===undefined)delete globalThis.document;else globalThis.document=savedDocument;
    if(savedWorker===undefined)delete globalThis.Worker;else globalThis.Worker=savedWorker;
  }
});

for(const failure of ['construction','load'])test(`finder falls back after worker ${failure} failure with fresh non-detached pixels`,async()=>{
  const savedDocument=globalThis.document,savedWorker=globalThis.Worker;
  const image=frame(qrMatrix('worker compatibility','H'));
  let reads=0,terminated=false,detached=false;
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({
    translate(){},rotate(){},drawImage(){},
    getImageData:()=>{reads++;return {width:image.size,height:image.size,data:new Uint8ClampedArray(image.data)};}
  })})};
  globalThis.Worker=class{
    constructor(){if(failure==='construction')throw new Error('module workers unsupported');}
    postMessage(data,transfer){
      structuredClone(data,{transfer});
      detached=data.rgba.byteLength===0;
      queueMicrotask(()=>this.onerror());
    }
    terminate(){terminated=true;}
  };
  try{
    const controller=new AbortController();
    const points=await detectQRCorners({width:image.size,height:image.size},null,{signal:controller.signal});
    assert.equal(points.length,4);
    assert.equal(reads,2);
    assert.equal(getEventListeners(controller.signal,'abort').length,0);
    if(failure==='load'){assert.ok(detached);assert.ok(terminated);}
  }finally{
    if(savedDocument===undefined)delete globalThis.document;else globalThis.document=savedDocument;
    if(savedWorker===undefined)delete globalThis.Worker;else globalThis.Worker=savedWorker;
  }
});
