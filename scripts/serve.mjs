import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
const root=resolve(process.argv[2]||'.');
const port=Number(process.env.PORT||4173);
const mimes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.wasm':'application/wasm'};
createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    const pathname=decodeURIComponent(url.pathname);
    const file=resolve(root,'.'+pathname,(pathname.endsWith('/')?'index.html':''));
    if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    const info=await stat(file);
    if(!info.isFile())throw Error('not a file');
    res.writeHead(200,{'Content-Type':mimes[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Kagura QR available at http://localhost:${port}`));
