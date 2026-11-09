/** Source privacy/security release guard. Complements (does not replace) runtime CSP and CodeQL/Trivy. */
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const sourceDir=join(root,'src');
const files=(await readdir(sourceDir)).filter(x=>x.endsWith('.js'));
for(const name of files){
  const body=await readFile(join(sourceDir,name),'utf8');
  const forbidden=[/\b(?:eval|Function)\s*\(/,/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/,
    /\b(?:localStorage|sessionStorage)\s*(?:\.|\[|=)/,/\bimport\s*\(\s*['"]https?:/,/\bimportScripts\(\s*['"]https?:/];
  for(const pattern of forbidden){if(pattern.test(body))throw Error(`${name}: prohibited browser/network/private-storage primitive ${pattern}`);}
}
const html=await readFile(join(root,'index.html'),'utf8');
if(/<script[^>]+src=["']https?:/i.test(html)||/<iframe\b/i.test(html))throw Error('Remote scripts or frames are not allowed');
const headers=await readFile(join(root,'public/_headers'),'utf8');
if(!headers.includes("connect-src 'self'")||!headers.includes("object-src 'none'")||!headers.includes("form-action 'none'"))throw Error('Hosting security headers are incomplete');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const lock=await readFile(join(root,'pnpm-lock.yaml'),'utf8');
for(const [name,version] of Object.entries(pkg.dependencies||{})){
  if(!lock.includes(`      ${name}:\n        specifier: ${version}\n        version: ${version}`))throw Error(`Lockfile does not match ${name}@${version}`);
  if(!lock.includes(`  ${name}@${version}:`))throw Error(`Lockfile resolution missing: ${name}@${version}`);
}
console.log(`Static security audit passed: ${files.length} source files, exact lockfile dependencies, CSP and no outbound/secret-storage primitives.`);
