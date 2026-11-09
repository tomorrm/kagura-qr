import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const LICENSE_FILES=[
  ['licenses/qrcode-generator.LICENSE','vendor/qrcode-LICENSE'],
  ['node_modules/jsqr/LICENSE','vendor/jsQR-LICENSE'],
  ['node_modules/zxing-wasm/LICENSE','vendor/zxing-wasm-LICENSE'],
  ['licenses/zxing-cpp.LICENSE','vendor/zxing-cpp-LICENSE'],
  ['licenses/zxing-core.LICENSE','vendor/zxing-core-LICENSE'],
  ['node_modules/pdfjs-dist/LICENSE','vendor/pdfjs-LICENSE'],
  ['node_modules/pdfjs-dist/cmaps/LICENSE','vendor/pdf-cmaps/LICENSE'],
  ['node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT','vendor/pdf-standard-fonts/LICENSE_FOXIT'],
  ['node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION','vendor/pdf-standard-fonts/LICENSE_LIBERATION'],
  ['node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG','vendor/pdf-wasm/LICENSE_OPENJPEG'],
  ['node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG','vendor/pdf-wasm/LICENSE_PDFJS_OPENJPEG'],
  ['node_modules/pdfjs-dist/wasm/LICENSE_QCMS','vendor/pdf-wasm/LICENSE_QCMS'],
  ['node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_QCMS','vendor/pdf-wasm/LICENSE_PDFJS_QCMS'],
];

export async function verifyLicenses(root,distribution){
  const notices=[];
  for(const [source,target] of LICENSE_FILES){
    const original=await readFile(path.join(root,source));
    const shipped=await readFile(path.join(distribution,target));
    if(!original.length||!original.equals(shipped))throw Error(`Missing or modified license notice: ${target}`);
    notices.push({path:target,sha256:createHash('sha256').update(shipped).digest('hex')});
  }
  return notices;
}
