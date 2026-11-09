import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyLicenses} from './verify-licenses.mjs';
const root=new URL('../dist/', import.meta.url);
const required=['index.html','styles.css','src/main.js','src/generator.js','src/processor.js','src/batch.js',
  'src/quality.js','src/signature.js','src/security.js','src/watermark.js',
  'src/decode-worker.js','src/worker-reader.js','src/key-backup.js','src/signed-display.js',
  'vendor/qrcode.mjs','vendor/jsQR.js','vendor/qrcode-LICENSE','vendor/jsQR-LICENSE',
  'vendor/zxing-reader.js','vendor/zxing_reader.wasm','vendor/zxing-wasm-LICENSE','vendor/zxing-cpp-LICENSE','vendor/zxing-core-LICENSE',
  'src/pdf-reader.js','vendor/pdf.mjs','vendor/pdf.worker.mjs','vendor/pdfjs-LICENSE',
  'src/finder.js','src/finder-worker.js',
  'vendor/pdf-standard-fonts/LICENSE_FOXIT','vendor/pdf-standard-fonts/LICENSE_LIBERATION',
  'vendor/pdf-cmaps/LICENSE','vendor/pdf-wasm/LICENSE_OPENJPEG','vendor/pdf-wasm/LICENSE_QCMS',
  'manifest.webmanifest','SHA256SUMS.txt','sbom.cdx.json','_headers','service-worker.js'];
for(const file of required)await access(new URL(file,root));
const generator=await readFile(new URL('src/generator.js',root),'utf8');
const html=await readFile(new URL('index.html',root),'utf8');
const sw=await readFile(new URL('service-worker.js',root),'utf8');
if(generator.includes("from 'qrcode-generator'"))throw Error('Unresolved bare import');
const pdfReader=await readFile(new URL('src/pdf-reader.js',root),'utf8');
if(!pdfReader.includes("import('../vendor/pdf.mjs')"))throw Error('PDF.js lazy local import missing');
if(sw.includes('__PRECACHE_ASSETS__') || sw.includes('__CACHE_ID__'))throw Error('Unrendered service worker');
for(const asset of required.filter(f=>!['service-worker.js','SHA256SUMS.txt','_headers'].includes(f))) {
  if(!sw.includes('./'+asset))throw Error(`Offline precache missing: ${asset}`);
}
if(/<script[^>]+src=["']https?:/i.test(html))throw Error('Unexpected third-party scripts');
if(!html.includes('Content-Security-Policy'))throw Error('No CSP');
const worker=await readFile(new URL('src/decode-worker.js',root),'utf8');
if(!worker.includes("importScripts('../vendor/jsQR.js')"))throw Error('Non-local worker reader');
if(!worker.includes("importScripts('../vendor/zxing-reader.js')")||
   !worker.includes("new URL('../vendor/zxing_reader.wasm',self.location.href)"))throw Error('Non-local WASM reader');
const readerBinary=await readFile(new URL('vendor/zxing_reader.wasm',root));
const {ZXING_WASM_SHA256}=await import('zxing-wasm/reader');
if(createHash('sha256').update(readerBinary).digest('hex')!==ZXING_WASM_SHA256)throw Error('WASM package integrity mismatch');
const policy=html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const headers=await readFile(new URL('_headers',root),'utf8');
if(!policy?.includes("'wasm-unsafe-eval'")||!headers.includes("'wasm-unsafe-eval'")||
   /'unsafe-eval'/.test(policy+headers))throw Error('WASM CSP permission is missing or overly broad');
const stylesHash=createHash('sha256').update(await readFile(new URL('styles.css',root))).digest('hex').slice(0,12);
if(!html.includes(`./styles.css?v=${stylesHash}`))throw Error('Stylesheet URL is not content-versioned');
if(!sw.includes('ignoreSearch: true'))throw Error('Service worker cannot match versioned asset URLs offline');
const bom=JSON.parse(await readFile(new URL('sbom.cdx.json',root),'utf8'));
if(bom.bomFormat!=='CycloneDX'||bom.components.length!==4)throw Error('SBOM incomplete');
if(bom.components.find(item=>item.name==='zxing-wasm')?.licenses?.[0]?.expression!=='MIT AND Apache-2.0')
  throw Error('Reader wrapper and compiled-code licenses missing from SBOM');
console.log(`Static distribution checks passed (${required.length} core assets, local-only scripts and CSP).`);

const lines=(await readFile(new URL('SHA256SUMS.txt',root),'utf8')).trim().split('\n');
for(const line of lines){
  const matched=/^([a-f0-9]{64})  ([a-zA-Z0-9_.\/-]+)$/.exec(line);
  if(!matched||matched[2].includes('..'))throw Error('Malformed checksum line');
  const actual=createHash('sha256').update(await readFile(new URL(matched[2],root))).digest('hex');
  if(actual!==matched[1])throw Error('Release checksum mismatch: '+matched[2]);
}
console.log(`${lines.length} release checksums verified.`);
const notices=await verifyLicenses(fileURLToPath(new URL('../',import.meta.url)),fileURLToPath(root));
console.log(`${notices.length} shipped license notices match their source copies.`);
