/** Experimental LSB watermark restricted to white quiet-zone pixels of our PNG output.
 * This is neither a signature, tamper-evidence, nor a robust steganographic scheme.
 * JPEG, resizing, screenshots and normal image editing may destroy the watermark.
 */
import {crc32} from './batch.js';
const MAGIC=new Uint8Array([0x4b,0x51,0x57,0x31]); // KQW1
const PAYLOAD=24; // magic 4 + digest16 + CRC32 4
const CHANNEL_BITS=PAYLOAD*8;

function readableImage(image){
  if(!image || !Number.isInteger(image.width)||!Number.isInteger(image.height)||image.width<CHANNEL_BITS||image.height<5 ||
     image.data?.length!==image.width*image.height*4)throw new Error('透かしの画像サイズが不正です。');
}
function buildPayload(digest){
  if(!(digest instanceof Uint8Array)||digest.length<16)throw new Error('透かしにはSHA-256ハッシュが必要です。');
  const bytes=new Uint8Array(PAYLOAD);bytes.set(MAGIC);bytes.set(digest.subarray(0,16),4);
  new DataView(bytes.buffer).setUint32(20,crc32(bytes.subarray(0,20)),false);
  return bytes;
}
/** Mutates only the red-channel LSB of the first row (within white quiet zone). */
export function embedWatermark(image,digest){
  readableImage(image);
  const bytes=buildPayload(digest);
  for(let bit=0;bit<CHANNEL_BITS;bit++)if(image.data[bit*4]<250 || image.data[bit*4+1]<250 || image.data[bit*4+2]<250)
    throw new Error('白い余白が不足し、透かしを安全に埋め込めません。');
  for(let bit=0;bit<CHANNEL_BITS;bit++)image.data[bit*4]=(image.data[bit*4]&254)|((bytes[bit>>3]>>(7-(bit&7)))&1);
  return image;
}
export function extractWatermark(image){
  readableImage(image);
  const bytes=new Uint8Array(PAYLOAD);
  for(let bit=0;bit<CHANNEL_BITS;bit++)bytes[bit>>3]|=(image.data[bit*4]&1)<<(7-(bit&7));
  if(!MAGIC.every((value,i)=>bytes[i]===value))return null;
  if(crc32(bytes.subarray(0,20))!==new DataView(bytes.buffer).getUint32(20,false))return null;
  return bytes.subarray(4,20);
}
export async function watermarkCanvas(canvas,text){
  if(!globalThis.crypto?.subtle)throw new Error('透かしにはHTTPSまたはlocalhostが必要です。');
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const image=ctx.getImageData(0,0,canvas.width,canvas.height);
  embedWatermark(image,digest);
  ctx.putImageData(image,0,0);
  return canvas;
}
