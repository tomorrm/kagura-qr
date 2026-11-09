import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectQRPrint,contrastRatio} from '../src/quality.js';
import {parseCSV,makeZIP,crc32,exportCSV} from '../src/batch.js';

test('print checks warn for low contrast, reversed luminance and insufficient resolution',()=>{
  const m=Array.from({length:21},(_,y)=>Array.from({length:21},(_,x)=>(x+y)%2===0));
  const good=inspectQRPrint(m);
  assert.equal(good.status,'pass');assert.ok(good.ratio>15);
  assert.equal(inspectQRPrint(m,{foreground:'#ededed'}).status,'caution');
  assert.equal(inspectQRPrint(m,{foreground:'#ffffff',background:'#000000'}).status,'caution');
  assert.equal(inspectQRPrint(m,{widthMm:5,dpi:72}).status,'caution');
  assert.throws(()=>inspectQRPrint([[true],[false]]));
  assert.throws(()=>contrastRatio('red','#fff'));
});

test('CSV parser accepts quoted comma, escaped double quotes, BOM, Japanese and LF/CRLF',()=>{
  assert.deepEqual(parseCSV('\uFEFFcontent\r\n"https://a.test?q=x,y"\r\n"日本語"\r\n"say ""hello"""\r\n'),['https://a.test?q=x,y','日本語','say "hello"']);
  assert.throws(()=>parseCSV('content\na,b'));
  assert.throws(()=>parseCSV('content\n"unterminated'));
  assert.throws(()=>parseCSV('x\n'.repeat(103)));
  assert.throws(()=>parseCSV('x'.repeat(131073)));
});

test('store-only ZIP produces correct header, file count and CRC32',async()=>{
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  const zip=makeZIP([{name:'0001.svg',data:'<svg/>'},{name:'report.csv',data:'日本語'}]);
  const b=new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...b.subarray(0,4)],[80,75,3,4]);
  assert.deepEqual([...b.subarray(-22,-18)],[80,75,5,6]);
  assert.equal(b[b.length-12],2);
  assert.throws(()=>makeZIP([{name:'../secrets',data:'no'}]));
  assert.throws(()=>makeZIP([{name:'a',data:new Uint8Array(20*1024*1024+1)}]));
});

test('CSV export neutralizes spreadsheet formulas and escapes untrusted cells',()=>{
  const csv=exportCSV([['content','status'],['=HYPERLINK("evil")','ok'],['-1','ok'],['日本語,改行\n2','ok']]);
  assert.ok(csv.includes("'="));
  assert.ok(csv.includes("'-1"));
  assert.ok(csv.includes('日本語,改行\n2'));
  assert.throws(()=>exportCSV(Array.from({length:513},()=>['x'])));
});
