import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LICENSE_FILES,verifyLicenses} from '../scripts/verify-licenses.mjs';

test('all runtime, font, CMap and WASM notices must be present and unchanged',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'kqr-license-test-'));
  const source=path.join(folder,'source'),dist=path.join(folder,'dist');
  try{
    for(const [original,target] of LICENSE_FILES){
      for(const file of [path.join(source,original),path.join(dist,target)]){
        await mkdir(path.dirname(file),{recursive:true});
        await writeFile(file,`test notice ${target}\n`);
      }
    }
    assert.equal((await verifyLicenses(source,dist)).length,LICENSE_FILES.length);
    const target=path.join(dist,'vendor/pdf-wasm/LICENSE_PDFJS_QCMS');
    await writeFile(target,'modified notice');
    await assert.rejects(verifyLicenses(source,dist),/modified license/);
    await rm(target);
    await assert.rejects(verifyLicenses(source,dist),{code:'ENOENT'});
  }finally{await rm(folder,{recursive:true,force:true});}
});
