import {cp, mkdir, readFile, writeFile, rm, access, readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const registry = (name, rel) => path.join(root, 'node_modules', name, rel);
const required = {
  generator: registry('qrcode-generator', 'dist/qrcode.mjs'),
  generatorLicense: path.join(root, 'licenses/qrcode-generator.LICENSE'),
  reader: registry('jsqr', 'dist/jsQR.js'),
  readerLicense: registry('jsqr', 'LICENSE'),
  wasmReader: registry('zxing-wasm', 'dist/iife/reader/index.js'),
  wasmBinary: registry('zxing-wasm', 'dist/reader/zxing_reader.wasm'),
  wasmLicense: registry('zxing-wasm', 'LICENSE'),
  pdfRenderer: registry('pdfjs-dist', 'legacy/build/pdf.mjs'),
  pdfWorker: registry('pdfjs-dist', 'legacy/build/pdf.worker.mjs'),
  pdfLicense: registry('pdfjs-dist', 'LICENSE'),
};
for (const [label, filename] of Object.entries(required)) {
  try { await access(filename); }
  catch { throw new Error(`Missing ${label}: ${filename}. Run pnpm install --frozen-lockfile first.`); }
}
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
await cp(path.join(root, 'src'), path.join(out, 'src'), {recursive:true});
for (const name of ['index.html', 'styles.css', 'manifest.webmanifest', 'service-worker.js', 'favicon.svg']) {
  await cp(path.join(root, name), path.join(out, name));
}
const indexFile=path.join(out,'index.html');
const indexHtml=await readFile(indexFile,'utf8');
const stylesHash=createHash('sha256').update(await readFile(path.join(out,'styles.css'))).digest('hex').slice(0,12);
const versionedIndex=indexHtml.replace('__STYLES_HASH__',stylesHash);
if(versionedIndex===indexHtml)throw new Error('Stylesheet hash placeholder missing from index.html');
await writeFile(indexFile,versionedIndex);
// Cloudflare Pages / Netlify headers; harmless static file on GitHub Pages.
await cp(path.join(root,'public/_headers'),path.join(out,'_headers'));
// CycloneDX SBOM is included in the artifact and precache hash.
const {execFileSync}=await import('node:child_process');
execFileSync(process.execPath,[path.join(root,'scripts/sbom.mjs'),path.join(out,'sbom.cdx.json')],{stdio:'inherit'});
const dest = path.join(out, 'vendor');
await mkdir(dest);
await cp(required.generator, path.join(dest, 'qrcode.mjs'));
await cp(required.reader, path.join(dest, 'jsQR.js'));
await cp(required.generatorLicense, path.join(dest, 'qrcode-LICENSE'));
await cp(required.readerLicense, path.join(dest, 'jsQR-LICENSE'));
await cp(required.wasmReader, path.join(dest, 'zxing-reader.js'));
await cp(required.wasmBinary, path.join(dest, 'zxing_reader.wasm'));
await cp(required.wasmLicense, path.join(dest, 'zxing-wasm-LICENSE'));
await cp(path.join(root,'licenses/zxing-cpp.LICENSE'),path.join(dest,'zxing-cpp-LICENSE'));
await cp(path.join(root,'licenses/zxing-core.LICENSE'),path.join(dest,'zxing-core-LICENSE'));
await cp(required.pdfRenderer, path.join(dest, 'pdf.mjs'));
await cp(required.pdfWorker, path.join(dest, 'pdf.worker.mjs'));
await cp(required.pdfLicense, path.join(dest, 'pdfjs-LICENSE'));
for(const [source,target] of [
  ['standard_fonts','pdf-standard-fonts'],
  ['cmaps','pdf-cmaps'],
  ['wasm','pdf-wasm']
]) await cp(registry('pdfjs-dist', source), path.join(dest,target), {recursive:true});
// Rewrite one package import to the locally vendored ESM artifact in the final static site.
// The same upstream package is used in Node tests and in browser output.
const sourceFile = path.join(out, 'src/generator.js');
const before = await readFile(sourceFile, 'utf8');
const after = before.replace("from 'qrcode-generator'", "from '../vendor/qrcode.mjs'");
if (before === after) throw new Error('QR import rewrite failed, aborting release.');
await writeFile(sourceFile, after);
const pdfSourceFile=path.join(out,'src/pdf-reader.js');
const pdfBefore=await readFile(pdfSourceFile,'utf8');
const pdfAfter=pdfBefore.replace("import('pdfjs-dist/legacy/build/pdf.mjs')","import('../vendor/pdf.mjs')");
if(pdfBefore===pdfAfter)throw new Error('PDF.js import rewrite failed, aborting release.');
await writeFile(pdfSourceFile,pdfAfter);

const entries=[];
async function walk(dir){
  for(const entry of await readdir(dir, {withFileTypes:true})){
    const abs=path.join(dir, entry.name);
    if(entry.isDirectory()) await walk(abs);
    else if(entry.isFile() && !['service-worker.js','_headers'].includes(entry.name)) entries.push('./' + path.relative(out,abs).split(path.sep).join('/'));
  }
}
await walk(out);
entries.sort();
// Hash file *contents* too: unchanged filenames with changed code need an updated SW.
const digest=createHash('sha256');
for (const relative of entries) {digest.update(relative); digest.update(await readFile(path.join(out,relative)));}
const cache='kagura-qr-'+digest.digest('hex').slice(0,16);
const swFile=path.join(out,'service-worker.js');
const sw=await readFile(swFile,'utf8');
if(!sw.includes('__CACHE_ID__') || !sw.includes('__PRECACHE_ASSETS__')) throw new Error('Service worker placeholder missing');
await writeFile(swFile,sw.replace('__CACHE_ID__',cache).replace('__PRECACHE_ASSETS__',JSON.stringify(['./',...entries])));
console.log(`Static site emitted to ${out}; offline precache ${entries.length} files`);

// Include the final service worker in reproducible release-file checksums.
// SHA256SUMS itself is deliberately not hashed (no circular dependency).
const manifestFiles=[...entries,'./service-worker.js','./_headers'].sort();
const manifest=[];
for(const relative of manifestFiles) {
  const body=await readFile(path.join(out,relative));
  manifest.push(`${createHash('sha256').update(body).digest('hex')}  ${relative.slice(2)}`);
}
await writeFile(path.join(out,'SHA256SUMS.txt'),manifest.join('\n')+'\n');
console.log(`Content checksum manifest emitted for ${manifestFiles.length} files`);
