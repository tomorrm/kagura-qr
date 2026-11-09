import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveThreshold, probeImageDimensions, assertImageDimensions, repairProfiles, validateImage, detectQRCorners} from '../src/processor.js';

test('adaptive threshold follows illumination gradients and returns bounded binary values', () => {
  const w=48,h=42, gray=new Uint8Array(w*h);
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const shade = 35+Math.round(x*3.7);
    gray[y*w+x] = x>12 && x<29 && y>10 && y<30 ? shade-28 : shade;
  }
  const result=adaptiveThreshold(gray,w,h,12,6);
  assert.equal(result.length,w*h);
  assert.equal(result[20*w+19], 0);
  assert.equal(result[20*w+35], 255);
  assert.ok([...result].every(v=>v===0 || v===255));
});

test('image header dimensions are bounded before rasterization', () => {
  const png = new Uint8Array(24);
  png.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],0);
  png.set([0x49,0x48,0x44,0x52],12);
  new DataView(png.buffer).setUint32(16,1000);
  new DataView(png.buffer).setUint32(20,500);
  assert.deepEqual(probeImageDimensions(png,'image/png'),{width:1000,height:500});
  assert.doesNotThrow(()=>assertImageDimensions({width:1000,height:500}));
  assert.throws(()=>assertImageDimensions({width:9000,height:9000}));
  assert.throws(()=>assertImageDimensions(null));
  const jpeg = new Uint8Array([0xff,0xd8,0xff,0xc0,0,17,8,0,32,0,64,3,0,0,0,0,0,0,0,0,0,0]);
  assert.deepEqual(probeImageDimensions(jpeg,'image/jpeg'),{height:32,width:64});
  assert.throws(()=>validateImage({type:'image/svg+xml',size:100}));
});

test('retry profiles include adaptive, rotated, cropped and full-resolution variants', () => {
  const profiles=repairProfiles();
  assert.ok(profiles.length >= 16);
  assert.equal(profiles[0].maxEdge,undefined);
  assert.ok(profiles.some(p=>p.threshold==='none'&&p.maxEdge===2600));
  assert.ok(profiles.some(p=>p.threshold==='adaptive'));
  assert.ok(profiles.some(p=>p.crop));
  assert.ok(profiles.some(p=>p.rotation===270));
});

test('perspective homography maps each corner accurately; rejects crossing and degenerate corners', async () => {
  const {perspectiveMap}=await import('../src/processor.js');
  const corners=[{x:2,y:3},{x:80,y:8},{x:72,y:62},{x:11,y:52}];
  const f=perspectiveMap(corners);
  for (const [u,v,p] of [[0,0,corners[0]],[1,0,corners[1]],[1,1,corners[2]],[0,1,corners[3]]]) {
    const got=f(u,v);
    assert.ok(Math.abs(got.x-p.x)<1e-7 && Math.abs(got.y-p.y)<1e-7);
  }
  assert.throws(()=>perspectiveMap([corners[0],corners[2],corners[1],corners[3]]));
  assert.throws(()=>perspectiveMap([corners[0],corners[0],corners[2],corners[3]]));
});

test('automatic QR corner detection accepts only bounded convex quadrilaterals',async()=>{
  const expected=[{x:10,y:12},{x:90,y:15},{x:87,y:88},{x:14,y:84}];
  class Detector {
    static async getSupportedFormats(){return ['qr_code'];}
    async detect(){return [{format:'qr_code',cornerPoints:expected}];}
  }
  assert.deepEqual(await detectQRCorners({width:100,height:100},Detector),expected);
  class InvalidDetector extends Detector {
    async detect(){return [{format:'qr_code',cornerPoints:[expected[0],expected[2],expected[1],expected[3]]}];}
  }
  const original=globalThis.document;
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({
    translate(){},rotate(){},drawImage(){},
    getImageData:()=>({data:new Uint8ClampedArray(100*100*4).fill(255),width:100,height:100})
  })})};
  try{
  await assert.rejects(detectQRCorners({width:100,height:100},InvalidDetector),/四隅を検出できません/);
  class UnsupportedDetector {
    static async getSupportedFormats(){return ['aztec'];}
  }
  await assert.rejects(detectQRCorners({width:100,height:100},UnsupportedDetector),/四隅を検出できません/);
  await assert.rejects(detectQRCorners({width:100,height:100},null),/四隅を検出できません/);
  }finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});

test('overlapping tiles are bounded and overlap to reach off-centre QR symbols', async () => {
  const {tileRegions}=await import('../src/processor.js');
  const r=tileRegions(1600,900);
  assert.ok(r.length>=9 && r.length<=18);
  assert.ok(r.some(x=>x.x===0 && x.y===0));
  assert.ok(r.some(x=>x.x+x.width===1600 && x.y+x.height===900));
  assert.ok(r.every(x=>x.x>=0 && x.y>=0 && x.x+x.width<=1600 && x.y+x.height<=900));
  assert.deepEqual(tileRegions(100,100),[]);
  assert.throws(()=>tileRegions(100000,100000));
});
