const encoder = new TextEncoder();
export const MAX_BATCH = 100;
const MAX_EXPORT_ROWS = 512;

/** RFC 4180-like single-column CSV; CRLF, UTF-8 BOM, escaped double quote supported. */
export function parseCSV(input, {limit=MAX_BATCH}={}) {
  if (typeof input !== 'string' || encoder.encode(input).length > 128 * 1024) throw new Error('CSVは128KB以内にしてください。');
  if (!Number.isInteger(limit) || limit<1 || limit>MAX_BATCH) throw new Error('処理件数が不正です。');
  const source = input.replace(/^\uFEFF/, '');
  const rows=[];let row=[],field='',quoted=false,afterQuote=false;
  for (let i=0; i<source.length; i++) {
    const c=source[i];
    if (quoted) {
      if(c==='"' && source[i+1]==='"'){field+='"';i++;}
      else if(c==='"'){quoted=false;afterQuote=true;}
      else field+=c;
    } else if(c==='"' && !field && !afterQuote){quoted=true;}
    else if(c===','){row.push(field);field='';afterQuote=false;}
    else if(c==='\r' || c==='\n') {
      if (c==='\r' && source[i+1]==='\n') i++;
      row.push(field);rows.push(row);if(rows.length>limit+2)throw new Error(`CSVは最大${limit}件までです。`);
      row=[];field='';afterQuote=false;
    } else {
      if (afterQuote && !/^\s$/.test(c)) throw new Error('CSVの引用符が不正です。');
      if (afterQuote && /^\s$/.test(c)) continue;
      if (c==='"') throw new Error('CSVの引用符が不正です。');
      field+=c;
    }
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません。');
  if (field || row.length || afterQuote) {row.push(field);rows.push(row);}
  const lines=rows.filter(r=>r.some(c=>c.trim()));
  if(lines[0]?.length===1 && /^(content|text|url|value|内容)$/i.test(lines[0][0].trim()))lines.shift();
  if (!lines.length) throw new Error('CSVに内容がありません。');
  if(lines.length>limit)throw new Error(`CSVは最大${limit}件までです。`);
  if (lines.some(r=>r.length!==1 || !r[0].trim() || encoder.encode(r[0]).length>2200))
    throw new Error('CSVは1列（content）で、空白以外の内容を2,200バイト以内で指定してください。');
  return lines.map(r=>r[0]);
}

/** Tiny uncompressed ZIP writer: no external runtime dependency, bounded input. */
const table = new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
export function crc32(data){let crc=0xffffffff;for(const b of data)crc=(crc>>>8)^table[(crc^b)&255];return (crc^0xffffffff)>>>0;}
export function makeZIP(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length>MAX_BATCH+2)throw new Error('ZIPの件数が不正です。');
  const parts=[],central=[];let offset=0,total=0;
  const u16=(v)=>[v&255,(v>>>8)&255];
  const u32=(v)=>[v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255];
  for(const {name,data} of entries){
    const filename=encoder.encode(name), bytes=data instanceof Uint8Array?data:encoder.encode(data);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,90}$/.test(name) || name.includes('..') || filename.length>255)
      throw new Error('ZIPのファイル名が不正です。');
    total+=bytes.byteLength;if(total>20*1024*1024)throw new Error('ZIPサイズは20MB以内にしてください。');
    const checksum=crc32(bytes);
    const local=new Uint8Array([0x50,0x4b,3,4,...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0),...u32(checksum),...u32(bytes.length),...u32(bytes.length),...u16(filename.length),...u16(0)]);
    parts.push(local,filename,bytes);
    central.push(new Uint8Array([0x50,0x4b,1,2,...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0),...u32(checksum),...u32(bytes.length),...u32(bytes.length),...u16(filename.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset)]),filename);
    offset+=local.length+filename.length+bytes.length;
  }
  const centralLength=central.reduce((n,b)=>n+b.length,0);
  const count=entries.length;
  const end=new Uint8Array([0x50,0x4b,5,6,...u16(0),...u16(0),...u16(count),...u16(count),...u32(centralLength),...u32(offset),...u16(0)]);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}

/** CSV export: quote all cells and neutralize spreadsheet formula execution. */
export function csvCell(value) {
  const s=String(value ?? '');
  const safe=/^[\s\uFEFF]*[=+@-]/.test(s) ? "'" + s : s;
  return '"' + safe.replaceAll('"','""') + '"';
}
export function exportCSV(rows) {
  if (!Array.isArray(rows) || rows.length>MAX_EXPORT_ROWS || rows.some(row=>!Array.isArray(row) || row.length>6))
    throw new Error('CSV出力件数が不正です。');
  return '\uFEFF' + rows.map(row=>row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
