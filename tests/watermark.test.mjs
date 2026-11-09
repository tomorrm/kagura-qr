import {test} from 'node:test';
import assert from 'node:assert/strict';
import {embedWatermark,extractWatermark} from '../src/watermark.js';
const makeImage=()=>({width:256,height:256,data:new Uint8ClampedArray(256*256*4).fill(255)});
test('LSB experimental watermark does not change black modules or green/blue channels',()=>{
  const data=makeImage(),d=new Uint8Array(32);for(let i=0;i<32;i++)d[i]=i;
  const black=(50*256+50)*4;data.data.fill(0,black,black+3);
  embedWatermark(data,d);
  assert.deepEqual([...extractWatermark(data)],[...d.subarray(0,16)]);
  assert.deepEqual([...data.data.subarray(black,black+3)],[0,0,0]);
  assert.ok(data.data.slice(0,192*4).every((v,i)=>i%4===0?v>=254:v===255));
  data.data[24]^=1;
  assert.equal(extractWatermark(data),null);
});
test('white quiet zone is mandatory; watermark rejects non-white modules',()=>{
  const d=makeImage();d.data[0]=0;
  assert.throws(()=>embedWatermark(d,new Uint8Array(32)));
  assert.equal(extractWatermark(makeImage()),null);
});
