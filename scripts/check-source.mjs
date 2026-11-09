import {readFile, readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const html=await readFile(path.join(root,'index.html'),'utf8');
const main=await readFile(path.join(root,'src/main.js'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
const seen=new Set();for(const id of ids){if(seen.has(id))throw Error(`Duplicate HTML ID: ${id}`);seen.add(id);}
const referenced=[...main.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]);
for(const id of referenced)if(!seen.has(id))throw Error(`Unbound UI element: ${id}`);
if(!html.includes("connect-src 'self'")||!html.includes("worker-src 'self'"))throw Error('Expected local-only CSP and worker CSP');
if(!html.includes('referrer') && html.includes('http-equiv="refresh"'))throw Error('Unexpected redirect');
for(const f of [...await readdir(path.join(root,'src')), ...await readdir(path.join(root,'scripts'))]) {
  if(!f.endsWith('.js')&&!f.endsWith('.mjs'))continue;
  const name=f.endsWith('.mjs')?'scripts':'src';
  execFileSync(process.execPath,['--check',path.join(root,name,f)],{stdio:'pipe'});
}
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(pkg.packageManager!=='pnpm@12.17.0')throw Error('Unexpected pnpm release drift');
console.log(`Source checks passed: ${ids.length} unique UI IDs, ${referenced.length} element bindings, JS syntax, pinned package manager.`);
