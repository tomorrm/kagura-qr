import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const lock=await readFile(path.join(root,'pnpm-lock.yaml'),'utf8');
const licenses={'jsqr':'Apache-2.0','qrcode-generator':'MIT','pdfjs-dist':'Apache-2.0','zxing-wasm':'MIT AND Apache-2.0'};
const components=[];
for(const [name,version] of Object.entries(pkg.dependencies)) {
  const search=lock.split(/\npackages:\n/)[1]?.split(/\nsnapshots:\n/)[0]||'';
  const exact=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp(`^  ${exact}@${version.replaceAll('.','\\.')}:[\\s\\S]*?resolution: \\{integrity: ([^}]+)\\}`,'m');
  const sri=re.exec(search)?.[1];
  if(!sri)throw new Error(`Missing lockfile integrity for ${name}@${version}`);
  components.push({type:'library',name,version,purl:`pkg:npm/${name}@${version}`,
    licenses:[name==='zxing-wasm'?{expression:licenses[name]}:{license:{id:licenses[name]||'NOASSERTION'}}],
    properties:[{name:'npm:integrity',value:sri}]});
}
const bom={bomFormat:'CycloneDX',specVersion:'1.5',version:1,
  metadata:{component:{type:'application',name:pkg.name,version:pkg.version}},components};
const out=process.argv[2]||path.join(root,'dist','sbom.cdx.json');
await writeFile(out,JSON.stringify(bom,null,2)+'\n');
console.log(`SBOM generated with ${components.length} direct dependencies: ${out}`);
