import {qrMatrix, renderSVG, drawQR, wifiPayload, downloadBlob} from './generator.js';
import {bitmapFromFile, renderSource, transformCanvas, perspectiveRectify, detectQRCorners, readCanvas, autoRepair} from './processor.js';
import {inspectContent} from './security.js';
import {inspectQRPrint} from './quality.js';
import {parseCSV, makeZIP, exportCSV} from './batch.js';
import {watermarkCanvas} from './watermark.js';
import {createReplayGuard, createSigningIdentity, importSigningIdentity, signPayload, signRevocationList, verifyRevocationList, verifySignedPayload} from './signature.js';
import {encryptSigningIdentity,decryptSigningIdentity} from './key-backup.js';
import {selectDisplayedPayload} from './signed-display.js';
import {scanPdfFile, validatePdfFile} from './pdf-reader.js';

const $ = id => document.getElementById(id);
const state = {tab:'create', format:'url', color:'#17191f', payload:'https://example.com', matrix:null, repairBitmap:null, repairText:'', scanText:'', stream:null, scanToken:0, scanAbort:null, cameraAbort:null, batchAbort:null, cornerAbort:null, pdfAbort:null, toastTimer:null, busy:false, repairAbort:null, identity:null, revocationIdentity:null, revocationIssuedAt:0, revocationExpiresAt:0, perspectiveMode:false, perspectivePoints:[], signedOriginal:null, signedEncoded:null};
const replayGuard=createReplayGuard();
const verification={scan:{generation:0,occurrence:null},repair:{generation:0,occurrence:null}};
let signGeneration=0,identityGeneration=0,adminGeneration=0,revocationGeneration=0;
let cornerGeneration=0;
function invalidateCorners(){
  cornerGeneration++;state.cornerAbort?.abort();state.cornerAbort=null;
  $('perspective-auto-detect').disabled=false;
}
function beginRepair(){
  state.repairAbort?.abort();
  const controller=new AbortController();state.repairAbort=controller;state.busy=true;
  return controller;
}
function isCurrentRepair(controller){return state.repairAbort===controller&&!controller.signal.aborted;}
function refreshVerifications(){
  for(const panel of ['scan','repair']){
    verification[panel].generation++;
    const payload=panel==='scan'?state.scanText:state.repairText;
    void renderSignatureVerification(payload,panel,{observeReplay:false});
  }
}
const revokedFingerprints=new Set();
let signedRevocationFingerprints=new Set();

function activeRevocations(){
  return new Set([...revokedFingerprints,...signedRevocationFingerprints]);
}

function refreshRevocationStatus(){
  if(!state.revocationExpiresAt)return '';
  const expired=Date.now()>=state.revocationExpiresAt;
  const warning=expired?'失効リストが期限切れです。既知の失効情報は維持します。新しい署名付きリストを読み込んでください。':'';
  $('scan-revocation-status').textContent=warning||
    `信頼済み管理者署名を検証しました。${signedRevocationFingerprints.size}件を適用中。有効期限: ${new Date(state.revocationExpiresAt).toLocaleString()}`;
  return warning;
}

function icon(name){return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;}
function notice(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>t.classList.remove('show'),3200);}
function showError(id,msg){const el=$(id);el.hidden=!msg;el.textContent=msg || '';}
function copyCanvas(source,target){target.width=source.width;target.height=source.height;target.getContext('2d').drawImage(source,0,0);}

function switchTab(tab){
  if(!['create','repair','scan'].includes(tab))return;
  if(tab!=='scan'){stopCamera();state.scanAbort?.abort();state.pdfAbort?.abort();state.batchAbort?.abort();}
  if(tab!=='repair'){state.repairAbort?.abort();invalidateCorners();}
  state.tab=tab;
  if(tab==='scan')refreshRevocationStatus();
  for (const type of ['create','repair','scan']) {
    $('panel-'+type).hidden=tab!==type;
    const el=$('tab-'+type);el.classList.toggle('is-current',tab===type);el.setAttribute('aria-selected',String(tab===type));el.tabIndex=tab===type?0:-1;
    document.querySelectorAll(`[data-go="${type}"]`).forEach(n=>n.classList.toggle('is-active',tab===type));
  }
  $('crumb-current').textContent={create:'Generate',repair:'Enhance',scan:'Scan'}[tab];
  document.querySelector('.version-pill').textContent={create:'01 / 03',repair:'02 / 03',scan:'03 / 03'}[tab];
}

document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>switchTab(el.dataset.go)));
document.querySelector('.tab-strip').addEventListener('keydown',event=>{
  const tabs=['create','repair','scan']; const index=tabs.indexOf(state.tab);
  let target=null;
  if(event.key==='ArrowRight')target=tabs[(index+1)%3];
  if(event.key==='ArrowLeft')target=tabs[(index+2)%3];
  if(event.key==='Home')target=tabs[0];
  if(event.key==='End')target=tabs[2];
  if(target){event.preventDefault();switchTab(target);$('tab-'+target).focus();}
});

function currentContent(){
  if(state.format==='wifi')return wifiPayload({ssid:$('wifi-ssid').value,password:$('wifi-pass').value,auth:$('wifi-auth').value});
  return $('content-input').value;
}
function refreshQR(override){
  try {
    const display=selectDisplayedPayload(currentContent(),state.signedOriginal,state.signedEncoded,override);
    if(display.dropped)notice('内容が変わったため署名を解除しました。必要なら再署名してください。');
    state.signedOriginal=display.signedOriginal;state.signedEncoded=display.signedEncoded;
    const content=display.value,signed=display.signed;
    state.payload=content;state.matrix=qrMatrix(content,$('error-level').value);
    drawQR($('qr-canvas'),state.matrix,{dark:state.color,pixelSize:12});
    $('qr-canvas').hidden=false;$('qr-placeholder').hidden=true;
    $('qr-meta').textContent=signed ? `QR Code · Ed25519 signed · Level ${$('error-level').value}` : `QR Code · Level ${$('error-level').value}`;
    $('qr-size').textContent=`${state.matrix.length} × ${state.matrix.length}`;
    showError('create-error','');$('download-png').disabled=false;$('download-svg').disabled=false;
    renderPrintQuality();
  }catch(err){state.matrix=null;$('qr-canvas').hidden=true;$('qr-placeholder').hidden=false;$('qr-placeholder').textContent=err.message;showError('create-error',err.message);$('download-png').disabled=true;$('download-svg').disabled=true;$('qr-size').textContent='—';}
}
function applyFormat(format){
  signGeneration++;
  state.format=format;
  document.querySelectorAll('[data-format]').forEach(b=>b.classList.toggle('is-selected',b.dataset.format===format));
  $('main-input-field').hidden=format==='wifi';$('wifi-fields').hidden=format!=='wifi';
  $('content-label').textContent=format==='url'?'リンク先のURL':'QRに含めるテキスト';
  $('content-input').placeholder=format==='url'?'https://example.com':'テキストを入力してください';
  if(format==='url' && !$('content-input').value.trim()) $('content-input').value='https://example.com';
  if(format==='text' && $('content-input').value==='https://example.com')$('content-input').value='';
  refreshQR();
}
document.querySelectorAll('[data-format]').forEach(b=>b.addEventListener('click',()=>applyFormat(b.dataset.format)));
['content-input','wifi-ssid','wifi-pass','wifi-auth','error-level'].forEach(id=>$(id).addEventListener('input',()=>{signGeneration++;refreshQR();}));
$('signature-expiry').addEventListener('input',()=>{signGeneration++;});
document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{state.color=b.dataset.color;document.querySelectorAll('[data-color]').forEach(x=>x.classList.toggle('selected',x===b));refreshQR();}));
$('download-png').addEventListener('click',async()=>{
  if(!state.matrix)return;
  try{
    const canvas=document.createElement('canvas');drawQR(canvas,state.matrix,{dark:state.color,pixelSize:20});
    if($('png-watermark').checked)await watermarkCanvas(canvas,state.payload);
    canvas.toBlob(blob=>blob?downloadBlob(blob,'kagura-qr.png'):notice('PNGの生成に失敗しました'),'image/png');
  }catch(error){notice(error.message||'PNGの生成に失敗しました');}
});
$('print-qr').addEventListener('click',()=>{
  if(!state.matrix)return;
  const size=Number($('print-mm').value);
  if(!Number.isFinite(size)||size<5||size>1000){notice('印刷幅は5〜1000mmで指定してください。');return;}
  document.documentElement.style.setProperty('--print-qr-size',`${size}mm`);
  window.print();
});
$('download-svg').addEventListener('click',()=>{
  if(!state.matrix)return;
  const svg=renderSVG(state.matrix,{dark:state.color});downloadBlob(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}),'kagura-qr.svg');
});

function renderPrintQuality() {
  try {
    if(!state.matrix) return;
    const result=inspectQRPrint(state.matrix, {foreground:state.color,
      widthMm:Number($('print-mm').value), dpi:Number($('print-dpi').value)});
    $('quality-result').classList.toggle('caution',result.status==='caution');
    $('quality-result').textContent=`${result.status==='pass'?'✓ 基本項目に警告なし':'注意が必要です'} · コントラスト ${result.ratio}:1\n`+
      `1モジュール ${result.moduleMm}mm / ${result.pixelsPerModule}px\n`+
      (result.issues.length?result.issues.join('\n'):'余白と出力設定の簡易チェックを通過しました。');
  }catch(error){$('quality-result').classList.add('caution');$('quality-result').textContent=error.message;}
}
for(const id of ['print-mm','print-dpi'])$(id).addEventListener('input',renderPrintQuality);

$('batch-generate').addEventListener('click',async()=>{
  const file=$('batch-csv').files?.[0], status=$('batch-status'),button=$('batch-generate');
  if(!file){status.textContent='先にCSVを選択してください。';return;}
  button.disabled=true; status.textContent='生成しています…';
  try{
    if(file.size>128*1024)throw new Error('CSVは128KB以下にしてください。');
    const contents=parseCSV(await file.text());
    const files=[], rows=[['file','status']];
    for(let i=0;i<contents.length;i++){
      const name=`qr-${String(i+1).padStart(3,'0')}.svg`;
      try{
        const matrix=qrMatrix(contents[i],$('error-level').value);
        files.push({name,data:renderSVG(matrix,{dark:state.color})});rows.push([name,'ok']);
      }catch{rows.push([name,'failed-capacity']);}
      if(i%8===0){status.textContent=`生成中 ${i+1} / ${contents.length}`;await new Promise(requestAnimationFrame);}
    }
    if(!files.length)throw new Error('生成できるデータがありませんでした。');
    files.push({name:'summary.csv',data:exportCSV(rows)});
    downloadBlob(makeZIP(files),'kagura-qr-batch.zip');
    status.textContent=`${files.length-1}件をZIPに保存しました。失敗件数 ${contents.length-files.length+1}件。`;
  }catch(error){status.textContent=error.message||'一括生成に失敗しました。';}
  finally{button.disabled=false;}
});

$('scan-batch-run').addEventListener('click',async()=>{
  const files=[...$('scan-batch-files').files],status=$('scan-batch-status'),button=$('scan-batch-run'),cancel=$('scan-batch-cancel');
  if(!files.length){status.textContent='画像を選択してください。';return;}
  if(files.length>30){status.textContent='最大30枚までです。';return;}
  state.batchAbort?.abort();
  const controller=new AbortController();state.batchAbort=controller;
  button.disabled=true;cancel.hidden=false;
  const rows=[['file','status','content']];
  try{
    for(let i=0;i<files.length;i++){
      status.textContent=`解析中 ${i+1} / ${files.length}`;
      let bmp;
      try {
        bmp=await bitmapFromFile(files[i]);
        controller.signal.throwIfAborted();
        const result=await autoRepair(bmp,()=>{}, {maxProfiles:8,signal:controller.signal});
        try{
          controller.signal.throwIfAborted();
          if(result.matches.length)for(const match of result.matches)rows.push([files[i].name,'ok',match]);
          else rows.push([files[i].name,'unreadable','']);
        }finally{result.canvas.width=result.canvas.height=0;}
      }catch(error){if(controller.signal.aborted||error.name==='AbortError')throw error;rows.push([files[i].name,'error',error.message||'failed']);}
      finally{bmp?.close();}
      await new Promise(requestAnimationFrame);
      controller.signal.throwIfAborted();
    }
    downloadBlob(new Blob([exportCSV(rows)],{type:'text/csv;charset=utf-8'}),'kagura-qr-scan-results.csv');
    status.textContent=`処理完了 · ${files.length}枚 / 検出 ${rows.filter(r=>r[1]==='ok').length}件。`;
  }catch(e){if(state.batchAbort===controller)status.textContent=controller.signal.aborted?'一括処理を中断しました。':e.message||'一括処理に失敗しました。';}
  finally{if(state.batchAbort===controller){state.batchAbort=null;button.disabled=false;cancel.hidden=true;}}
});
$('scan-batch-cancel').addEventListener('click',()=>state.batchAbort?.abort());

$('scan-pdf-run').addEventListener('click',async()=>{
  const file=$('scan-pdf-file').files?.[0],button=$('scan-pdf-run'),cancel=$('scan-pdf-cancel');
  if(!file){$('scan-pdf-status').textContent='先にPDFを選択してください。';return;}
  try{validatePdfFile(file);}catch(error){$('scan-pdf-status').textContent=error.message;return;}
  state.pdfAbort?.abort();
  const controller=new AbortController();state.pdfAbort=controller;
  button.disabled=true;cancel.hidden=false;$('scan-pdf-status').textContent='PDFをローカルで解析しています…';
  try{
    const result=await scanPdfFile(file,{signal:controller.signal,onProgress:(page,total,outcome)=>{
      if(controller.signal.aborted)return;
      const count=outcome.status==='ok'?outcome.matches.length:0;
      $('scan-pdf-status').textContent=`解析中 ${page}/${total}ページ · ${count}件検出`;
    }});
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    const rows=[['page','status','content']];
    for(const outcome of result.results){
      const label=`page-${String(outcome.page).padStart(2,'0')}`;
      if(outcome.status==='ok')for(const match of outcome.matches)rows.push([label,'ok',match]);
      else rows.push([label,outcome.status,outcome.error||'']);
    }
    downloadBlob(new Blob([exportCSV(rows)],{type:'text/csv;charset=utf-8'}),'kagura-qr-pdf-scan.csv');
    const found=result.results.reduce((total,page)=>total+(page.matches?.length||0),0);
    $('scan-pdf-status').textContent=`完了 · ${result.pageCount}ページ / ${found}件検出。CSVを保存しました。`;
  }catch(error){
    $('scan-pdf-status').textContent=error.name==='AbortError'?'PDFの読み取りを中断しました。':error.message||'PDFを読み取れませんでした。';
  }finally{
    if(state.pdfAbort===controller)state.pdfAbort=null;
    button.disabled=false;cancel.hidden=true;
  }
});
$('scan-pdf-cancel').addEventListener('click',()=>state.pdfAbort?.abort());

// Keys are never persisted by the app. Export is password-encrypted; old plaintext JWK imports supported for migration.
function showKeyStatus() {
  const key = state.identity;
  $('key-status').textContent = key ? `公開鍵の指紋（SHA-256）: ${key.fingerprint}` : '鍵がありません。最初に生成してください。';
  $('sign-create').disabled = !key;
  $('key-export').disabled = !key;
  $('key-copy-fingerprint').disabled = !key;
}
function showRevocationKeyStatus() {
  const key=state.revocationIdentity;
  $('revocation-key-status').textContent=key ?
    `管理者鍵の指紋（SHA-256）: ${key.fingerprint}`:'失効リスト管理者鍵がありません。';
  $('revocation-key-export').disabled=!key;
  $('revocation-list-export').disabled=!key||activeRevocations().size===0;
}
$('key-copy-fingerprint').addEventListener('click', () => state.identity && copyText(state.identity.fingerprint));
$('key-generate').addEventListener('click', async () => {
  const generation=++identityGeneration;signGeneration++;
  try {
    const identity=await createSigningIdentity();
    if(generation!==identityGeneration)return;
    state.identity = identity;
    showKeyStatus(); showError('sign-error','');
    notice('署名鍵を生成しました。必要に応じて秘密鍵を安全に保管してください。');
  } catch (e) { if(generation===identityGeneration)showError('sign-error', e.message); }
});
$('key-import').addEventListener('click', () => $('key-import-file').click());
$('key-import-file').addEventListener('change', async () => {
  const file = $('key-import-file').files?.[0]; $('key-import-file').value = '';
  if (!file) return;
  const generation=++identityGeneration,passphrase=$('key-passphrase').value;signGeneration++;
  try {
    if (file.size > 8192) throw new Error('鍵ファイルが大きすぎます。');
    const data=JSON.parse(await file.text());
    if(generation!==identityGeneration)return;
    const encrypted=data?.format==='KQR-ENCRYPTED-KEY';
    const identity = encrypted ? await decryptSigningIdentity(data,passphrase) : await importSigningIdentity(data);
    if(generation!==identityGeneration)return;
    state.identity=identity;
    showKeyStatus();showError('sign-error','');notice(encrypted?'暗号化された署名鍵を復号しました':'旧形式の平文鍵を読み込みました。暗号化して保存し直してください。');
  } catch (e) { if(generation===identityGeneration)showError('sign-error', e.message || '鍵の読み込みに失敗しました'); }
  finally { if(generation===identityGeneration&&$('key-passphrase').value===passphrase)$('key-passphrase').value=''; }
});
$('key-export').addEventListener('click', async () => {
  if (!state.identity) return;
  const generation=identityGeneration,passphrase=$('key-passphrase').value;
  try {
    const key = await encryptSigningIdentity(state.identity,passphrase);
    if(generation!==identityGeneration)return;
    downloadBlob(new Blob([JSON.stringify(key, null, 2)], {type:'application/json'}), 'kagura-qr-ENCRYPTED-KEY.json');
    notice('秘密鍵をAES-256-GCMで暗号化して保存しました。パスフレーズも安全に保管してください。');
  } catch (e) { if(generation===identityGeneration)showError('sign-error', e.message); }
  finally { if(generation===identityGeneration&&$('key-passphrase').value===passphrase)$('key-passphrase').value=''; }
});
$('sign-create').addEventListener('click', async () => {
  const generation=++signGeneration,identity=state.identity,content=currentContent(),expiryValue=$('signature-expiry').value;
  const current=()=>generation===signGeneration&&identity===state.identity&&content===currentContent()&&expiryValue===$('signature-expiry').value;
  try {
    const expiry=Number(expiryValue);
    const encoded = await signPayload(content,identity,{expiresInSeconds:expiry||null});
    if(!current())return;
    refreshQR(encoded);
    if (!state.matrix) throw new Error('署名付きQRを格納できません。内容を短くするか誤り訂正レベルを下げてください。');
    $('qr-meta').textContent=`QR Code · Ed25519 signed · Level ${$('error-level').value}`;
    showError('sign-error','');notice('署名付きQRを生成しました');
  } catch (e) { if(current())showError('sign-error', e.message); }
});
$('revocation-key-generate').addEventListener('click',async()=>{
  const generation=++adminGeneration;
  try{
    const identity=await createSigningIdentity();
    if(generation!==adminGeneration)return;
    state.revocationIdentity=identity;
    showRevocationKeyStatus();showError('revocation-error','');
    notice('失効リスト管理者鍵を生成しました。発行鍵とは独立して管理してください。');
  }catch(e){if(generation===adminGeneration)showError('revocation-error',e.message);}
});
$('revocation-key-import').addEventListener('click',()=>$('revocation-key-import-file').click());
$('revocation-key-import-file').addEventListener('change',async()=>{
  const file=$('revocation-key-import-file').files?.[0];$('revocation-key-import-file').value='';
  if(!file)return;
  const generation=++adminGeneration,passphrase=$('revocation-key-passphrase').value;
  try{
    if(file.size>8192)throw new Error('鍵ファイルが大きすぎます。');
    const data=JSON.parse(await file.text());
    if(generation!==adminGeneration)return;
    const identity=data?.format==='KQR-ENCRYPTED-KEY'?
      await decryptSigningIdentity(data,passphrase):await importSigningIdentity(data);
    if(generation!==adminGeneration)return;
    state.revocationIdentity=identity;
    showRevocationKeyStatus();showError('revocation-error','');
    notice('失効リスト管理者鍵を読み込みました。');
  }catch(e){if(generation===adminGeneration)showError('revocation-error',e.message||'鍵の読み込みに失敗しました');}
  finally{if(generation===adminGeneration&&$('revocation-key-passphrase').value===passphrase)$('revocation-key-passphrase').value='';}
});
$('revocation-key-export').addEventListener('click',async()=>{
  if(!state.revocationIdentity)return;
  const generation=adminGeneration,passphrase=$('revocation-key-passphrase').value;
  try{
    const key=await encryptSigningIdentity(state.revocationIdentity,passphrase);
    if(generation!==adminGeneration)return;
    downloadBlob(new Blob([JSON.stringify(key,null,2)],{type:'application/json'}),'kagura-qr-revocation-admin-key.json');
    notice('管理者鍵をAES-256-GCMで暗号化して保存しました。');
  }catch(e){if(generation===adminGeneration)showError('revocation-error',e.message);}
  finally{if(generation===adminGeneration&&$('revocation-key-passphrase').value===passphrase)$('revocation-key-passphrase').value='';}
});
$('revocation-list-export').addEventListener('click',async()=>{
  if(!state.revocationIdentity)return;
  try{
    const revoked=[...activeRevocations()].sort();
    if(!revoked.length)throw new Error('失効登録がありません。');
    const list=await signRevocationList(state.revocationIdentity,revoked);
    downloadBlob(new Blob([JSON.stringify(list,null,2)],{type:'application/json'}),'kagura-qr-revocations.json');
    showError('revocation-error','');notice('有効期間30日の署名付き失効リストを保存しました。');
  }catch(e){showError('revocation-error',e.message);}
});
$('scan-revocation-file').addEventListener('change',async()=>{
  const file=$('scan-revocation-file').files?.[0];$('scan-revocation-file').value='';
  if(!file)return;
  const generation=++revocationGeneration,authority=$('scan-revocation-authority').value;
  const current=()=>generation===revocationGeneration&&authority===$('scan-revocation-authority').value;
  const status=$('scan-revocation-status');
  try{
    if(file.size>512*1024)throw new Error('失効リストは512KB以下にしてください。');
    const text=await file.text();
    if(!current())return;
    const result=await verifyRevocationList(text,authority,{
      minimumIssuedAt:state.revocationIssuedAt
    });
    if(!current())return;
    if(result.status!=='trusted')throw new Error(result.reason||'失効リストを信頼できません。');
    if(result.issuedAt<state.revocationIssuedAt)throw new Error('古い失効リストは適用できません。');
    signedRevocationFingerprints=result.revokedFingerprints;
    state.revocationIssuedAt=result.issuedAt;
    state.revocationExpiresAt=result.expiresAt;
    refreshRevocationStatus();
    showRevocationKeyStatus();
    refreshVerifications();
  }catch(e){if(current())status.textContent=e.message||'失効リストを検証できません。';}
});
$('scan-revocation-authority').addEventListener('input',()=>{revocationGeneration++;});

async function renderSignatureVerification(value, panel,{observeReplay=true}={}) {
  const context=verification[panel],generation=++context.generation;
  if(observeReplay||context.occurrence?.value!==value)context.occurrence={value,observed:false,replayed:false};
  const occurrence=context.occurrence;
  const wrapper = $(`${panel}-verification`);
  const verdict = $(`${panel}-verdict`);
  if (!value?.startsWith('KQR1.') && !value?.startsWith('KQR2.')) {wrapper.hidden = true;return;}
  wrapper.hidden = false;
  const expected = $(`${panel}-trusted-key`).value;
  const current=()=>generation===context.generation&&occurrence===context.occurrence&&
    expected===$(`${panel}-trusted-key`).value&&value===(panel==='scan'?state.scanText:state.repairText);
  verdict.textContent = '署名を検証しています…';verdict.className = 'signature-verdict';
  let result;
  try{
    result = await verifySignedPayload(value, expected,{
      replayGuard:{observe(fingerprint,nonce){
        if(!current())return false;
        if(!occurrence.observed){occurrence.replayed=replayGuard.observe(fingerprint,nonce);occurrence.observed=true;}
        return occurrence.replayed;
      }},revokedFingerprints:activeRevocations()
    });
  }catch(error){
    if(generation!==context.generation)return;
    result={status:'invalid',reason:error.message};
  }
  // Result may have changed while verification was pending.
  if (!current()) return;
  const payloadBox = $(`${panel}-signed-content`);
  payloadBox.hidden = !result.payload;
  payloadBox.textContent = result.payload ? `署名された内容: ${result.payload}` : '';
  const revoke=$(`${panel}-revoke`);
  revoke.hidden=!result.fingerprint || !['trusted','valid-untrusted'].includes(result.status);
  const formatNote=result.version===1?' · 旧形式 KQR1（期限・リプレイ検出なし）':
    result.expiresAt?` · 有効期限 ${new Date(result.expiresAt).toLocaleString()}`:' · 有効期限なし';
  if (result.status === 'trusted') {
    verdict.textContent = `✓ 署名有効・信頼済みの公開鍵と一致${formatNote}`; verdict.classList.add('valid');
  } else if (result.status === 'valid-untrusted') {
    verdict.textContent = `署名の整合性は有効${formatNote}・発行者は未確認（指紋: ${result.fingerprint}）`;
  } else if (result.status === 'replayed' || result.status === 'revoked' ||
      result.status === 'expired' || result.status === 'not-yet-valid') {
    verdict.textContent = `⚠ ${result.reason}`;verdict.classList.add('invalid');
  } else {
    verdict.textContent = `署名検証失敗・内容を信用しないでください。${result.reason || ''}`;
    verdict.classList.add('invalid');
  }
  const revocationWarning=refreshRevocationStatus();
  if(revocationWarning)verdict.textContent+=` · ⚠ ${revocationWarning}`;
}
for (const panel of ['repair','scan']) {
  $(`${panel}-trusted-key`).addEventListener('input',()=>{
    verification[panel].generation++;
    const payload=panel==='scan'?state.scanText:state.repairText;
    void renderSignatureVerification(payload,panel,{observeReplay:false});
  });
  $(`${panel}-verify`).addEventListener('click', () => {
    const payload = panel === 'scan' ? state.scanText : state.repairText;
    if (payload) void renderSignatureVerification(payload, panel,{observeReplay:false});
  });
  $(`${panel}-revoke`).addEventListener('click',async()=>{
    const payload=panel==='scan'?state.scanText:state.repairText;
    if(!payload)return;
    const occurrence=verification[panel].occurrence,generation=verification[panel].generation;
    const result=await verifySignedPayload(payload);
    if(occurrence!==verification[panel].occurrence||generation!==verification[panel].generation)return;
    if(result.fingerprint && ['trusted','valid-untrusted'].includes(result.status)){
      revokedFingerprints.add(result.fingerprint);
      if(revokedFingerprints.size>128)revokedFingerprints.delete(revokedFingerprints.values().next().value);
      showRevocationKeyStatus();
      refreshVerifications();
    }
  });
}

async function copyText(value){
  try {await navigator.clipboard.writeText(value);notice('コピーしました');}catch{notice('コピーできませんでした。HTTPS環境か権限をご確認ください。');}
}

function acceptDrop(zone,fileInput,handle){
  zone.addEventListener('click',()=>fileInput.click());
  zone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileInput.click();}});
  fileInput.addEventListener('change',()=>{if(fileInput.files?.[0])void handle(fileInput.files[0]);fileInput.value='';});
  for (const event of ['dragenter','dragover']) zone.addEventListener(event,e=>{e.preventDefault();zone.classList.add('dragging');});
  for (const event of ['dragleave','drop'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.remove('dragging');});
  zone.addEventListener('drop',e=>{const file=e.dataTransfer?.files[0];if(file)void handle(file);});
}

function resetCorners() {
  invalidateCorners();
  state.perspectiveMode=false;state.perspectivePoints=[];
  $('repair-original').classList.remove('corner-active');
  $('perspective-apply').disabled=true;
  $('perspective-status').textContent='未選択';
  document.querySelectorAll('.perspective-point').forEach(el=>el.remove());
}
$('perspective-select').addEventListener('click',()=>{
  if(!state.repairBitmap){notice('先に画像を選択してください');return;}
  resetCorners();state.perspectiveMode=true;
  $('repair-original').classList.add('corner-active');
  $('perspective-status').textContent='1 / 4 : 左上をタップ';
  $('repair-original').scrollIntoView({behavior:'smooth',block:'nearest'});
});
$('perspective-auto-detect').addEventListener('click',async()=>{
  if(!state.repairBitmap){notice('先に画像を選択してください');return;}
  invalidateCorners();
  const generation=cornerGeneration,controller=new AbortController();state.cornerAbort=controller;
  const current=()=>generation===cornerGeneration&&!controller.signal.aborted;
  const button=$('perspective-auto-detect');button.disabled=true;showError('repair-error','');
  try{
    const points=await detectQRCorners($('repair-original'),globalThis.BarcodeDetector,{signal:controller.signal});
    if(!current())return;
    resetCorners();state.perspectivePoints=points;
    $('perspective-apply').disabled=false;
    $('perspective-status').textContent='四隅を自動検出しました。補正して読み取ってください。';
  }catch(error){if(current()&&error.name!=='AbortError')showError('repair-error',error.message||'四隅を自動検出できませんでした。');}
  finally{if(current()){state.cornerAbort=null;button.disabled=false;}}
});
$('perspective-reset').addEventListener('click',resetCorners);
$('repair-original').addEventListener('click',e=>{
  if(!state.perspectiveMode || state.perspectivePoints.length>=4)return;
  const canvas=$('repair-original'), rect=canvas.getBoundingClientRect();
  const stage=canvas.parentElement.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const x=Math.max(0,Math.min(canvas.width, (e.clientX-rect.left)/rect.width*canvas.width));
  const y=Math.max(0,Math.min(canvas.height,(e.clientY-rect.top)/rect.height*canvas.height));
  state.perspectivePoints.push({x,y});
  const dot=document.createElement('span');dot.className='perspective-point';
  dot.style.left=`${e.clientX-stage.left}px`;dot.style.top=`${e.clientY-stage.top}px`;
  canvas.parentElement.appendChild(dot);
  const names=['左上','右上','右下','左下'];
  $('perspective-status').textContent=state.perspectivePoints.length===4 ? '四隅を指定しました' :
    `${state.perspectivePoints.length+1} / 4 : ${names[state.perspectivePoints.length]}をタップ`;
  if(state.perspectivePoints.length===4){state.perspectiveMode=false;canvas.classList.remove('corner-active');$('perspective-apply').disabled=false;}
});
$('perspective-numeric-apply').addEventListener('click',()=>{
  if(!state.repairBitmap){notice('先に画像を選択してください');return;}
  const source=$('repair-original');
  try {
  const corners=['tl','tr','br','bl'].map(name=>{
    const xRaw=$(`corner-${name}-x`).value,yRaw=$(`corner-${name}-y`).value;
    if(xRaw.trim()===''||yRaw.trim()==='')throw Error('四隅の座標を入力してください。');
    const x=Number(xRaw),y=Number(yRaw);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>100||y<0||y>100)throw Error('0〜100%の座標を入力してください。');
    return {x:x/100*source.width,y:y/100*source.height};
  });
    // Reject self-intersecting points without mutating existing selection.
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
    const turns=corners.map((p,i)=>cross(p,corners[(i+1)%4],corners[(i+2)%4]));
    if(turns.some(t=>Math.abs(t)<1e-4||t*turns[0]<=0))throw Error('四隅が交差しています。入力を確認してください。');
    resetCorners();state.perspectivePoints=corners;
    $('perspective-apply').disabled=false;$('perspective-status').textContent='キーボード指定の四隅を適用しました';
    $('perspective-apply').focus();
  }catch(error){showError('repair-error',error.message);}
});
$('perspective-apply').addEventListener('click',async()=>{
  if(state.busy || state.perspectivePoints.length!==4)return;
  const controller=beginRepair();
  verification.repair.generation++;
  showError('repair-error','');$('repair-found').hidden=true;
  let corrected=null,canvas=null;
  try{
    let result=[];
    for(const size of [600,800]){
      if(corrected)corrected.width=corrected.height=0;
      corrected=perspectiveRectify($('repair-original'),state.perspectivePoints,size);
      canvas=corrected;
      result=await readCanvas(corrected,{signal:controller.signal});
      if(!isCurrentRepair(controller))return;
      if(result.length)break;
    }
    if(!result.length){canvas=transformCanvas(corrected,{threshold:'adaptive'});result=await readCanvas(canvas,{signal:controller.signal});}
    if(!isCurrentRepair(controller))return;
    copyCanvas(canvas,$('repair-enhanced'));
    if(result.length){state.repairText=result[0];$('repair-text').textContent=result[0];$('repair-found').hidden=false;
      void renderSignatureVerification(result[0],'repair');$('repair-status').textContent='台形補正で読み取り成功';}
    else {state.repairText='';$('repair-status').textContent='台形補正後も読み取れませんでした';showError('repair-error','四隅の位置を再確認してください。');}
  }catch(e){if(isCurrentRepair(controller)&&e.name!=='AbortError')showError('repair-error',e.message||'台形補正に失敗しました');}
  finally{
    if(canvas && canvas!==corrected)canvas.width=canvas.height=0;
    if(corrected)corrected.width=corrected.height=0;
    if(state.repairAbort===controller){state.repairAbort=null;state.busy=false;}
  }
});

async function loadRepair(file){
  const controller=beginRepair();resetCorners();
  verification.repair.generation++;
  showError('repair-error','');$('repair-found').hidden=true;$('repair-results').hidden=false;
  state.repairText='';$('repair-progress').style.width='0%';$('repair-status').textContent='画像を解析しています…';$('repair-percent').textContent='0%';
  let bitmap,result,installed=false;
  try {
    bitmap=await bitmapFromFile(file);
    if(!isCurrentRepair(controller))return;
    state.repairBitmap?.close();state.repairBitmap=bitmap;installed=true;
    const original=renderSource(bitmap);copyCanvas(original,$('repair-original'));original.width=original.height=0;
    const begun=performance.now();
    result=await autoRepair(bitmap,(p,i,total)=>{if(!isCurrentRepair(controller))return;$('repair-progress').style.width=`${Math.round(p*100)}%`;$('repair-percent').textContent=`${Math.round(p*100)}%`;$('repair-status').textContent=`解析中 · パターン ${i}/${total}`;},{signal:controller.signal});
    if(!isCurrentRepair(controller))return;
    const elapsed=((performance.now()-begun)/1000).toFixed(1);
    copyCanvas(result.canvas,$('repair-enhanced'));
    result.canvas.width=result.canvas.height=0;
    if(result.matches.length){state.repairText=result.matches[0];$('repair-text').textContent=result.matches[0];$('repair-found').hidden=false;void renderSignatureVerification(result.matches[0], 'repair');$('repair-status').textContent=`読み取り成功 · ${result.steps}回目 · ${elapsed}秒`;notice('QRコードを読み取りました');}
    else{$('repair-status').textContent=`自動補正では読み取れませんでした（${elapsed}秒）`;showError('repair-error','元画像から内容を取得できませんでした。手動調整をお試しください。欠損した情報を推測して復元することはできません。');}
  }catch(e){if(isCurrentRepair(controller)&&e.name!=='AbortError'){$('repair-status').textContent='処理に失敗しました';showError('repair-error',e.message||'画像を処理できませんでした。');}}
  finally{
    if(result?.canvas)result.canvas.width=result.canvas.height=0;
    if(bitmap&&!installed)bitmap.close();
    if(state.repairAbort===controller){state.repairAbort=null;state.busy=false;}
  }
}
acceptDrop($('repair-drop'),$('repair-file'),loadRepair);

$('manual-contrast').addEventListener('input',()=>$('manual-contrast-value').textContent=$('manual-contrast').value);
$('manual-apply').addEventListener('click',async()=>{
  if(!state.repairBitmap||state.busy){notice('先に画像を選択してください');return;}
  const controller=beginRepair();verification.repair.generation++;
  showError('repair-error','');$('repair-found').hidden=true;
  let source=null,candidate=null;
  try{
    const rotation=Number($('manual-rotation').value);
    source=renderSource(state.repairBitmap,rotation);
    candidate=transformCanvas(source,{contrast:Number($('manual-contrast').value),threshold:$('manual-threshold').value,invert:$('manual-invert').checked});
    const matches=await readCanvas(candidate,{signal:controller.signal});
    if(!isCurrentRepair(controller))return;
    copyCanvas(candidate,$('repair-enhanced'));
    if(matches.length){state.repairText=matches[0];$('repair-text').textContent=matches[0];$('repair-found').hidden=false;void renderSignatureVerification(matches[0], 'repair');$('repair-status').textContent='手動補正で読み取り成功';}
    else{state.repairText='';$('repair-status').textContent='まだ検出できません';showError('repair-error','調整後の画像でも読めませんでした。別の設定をお試しください。');}
  }catch(e){if(isCurrentRepair(controller)&&e.name!=='AbortError')showError('repair-error',e.message||'手動補正に失敗しました');}
  finally{
    if(candidate)candidate.width=candidate.height=0;
    if(source)source.width=source.height=0;
    if(state.repairAbort===controller){state.repairAbort=null;state.busy=false;}
  }
});
function regenerate(value){switchTab('create');state.format='text';document.querySelectorAll('[data-format]').forEach(b=>b.classList.toggle('is-selected',b.dataset.format==='text'));$('main-input-field').hidden=false;$('wifi-fields').hidden=true;$('content-label').textContent='QRに含めるテキスト';$('content-input').value=value;refreshQR();document.querySelector('.workspace').scrollIntoView({behavior:'smooth',block:'start'});}
$('repair-regenerate').addEventListener('click',()=>state.repairText&&regenerate(state.repairText));
$('repair-copy').addEventListener('click',()=>state.repairText&&copyText(state.repairText));

function presentResult(value,all=[value]){
  const extra=[...new Set(all)].filter(item=>item!==value);
  $('scan-multi').hidden=!extra.length;
  $('scan-multi').textContent=extra.length ? `ほかに${extra.length}件検出しました:\n`+extra.join('\n────\n') : '';
  state.scanText=value;
  void renderSignatureVerification(value, 'scan');
  const audit=inspectContent(value);
  $('scan-result').hidden=false;$('scan-value').textContent=value;$('scan-type').textContent=audit.label;
  $('scan-caution').textContent=audit.caution;$('scan-caution').hidden=!audit.caution;
  const link=$('scan-open');link.hidden=!audit.url;
  if(audit.url)link.href=audit.url;else link.removeAttribute('href');
  showError('scan-error','');
  notice('QRコードを読み取りました');
}
$('scan-copy').addEventListener('click',()=>state.scanText&&copyText(state.scanText));
$('scan-regenerate').addEventListener('click',()=>state.scanText&&regenerate(state.scanText));
$('scan-upload-btn').addEventListener('click',()=>$('scan-file').click());
$('scan-file').addEventListener('change',async()=>{
  const file=$('scan-file').files?.[0];$('scan-file').value='';if(!file)return;
  stopCamera();verification.scan.generation++;
  state.scanAbort?.abort();
  const controller=new AbortController();state.scanAbort=controller;
  $('scan-result').hidden=true;$('scan-multi').hidden=true;showError('scan-error','');
  let bitmap,result;
  try {
    bitmap=await bitmapFromFile(file);
    if(controller.signal.aborted)return;
    result=await autoRepair(bitmap,()=>{},{signal:controller.signal});
    if(controller.signal.aborted)return;
    if(result.matches.length)presentResult(result.matches[0],result.matches);
    else showError('scan-error','QRコードを検出できませんでした。「補正する」でお試しください。');
    result.canvas.width=result.canvas.height=0;
  }catch(e){if(e.name!=='AbortError'&&!controller.signal.aborted)showError('scan-error',e.message);}
  finally{if(result?.canvas)result.canvas.width=result.canvas.height=0;bitmap?.close();if(state.scanAbort===controller)state.scanAbort=null;}
});

function stopCamera(){
  state.scanToken++;
  state.cameraAbort?.abort();state.cameraAbort=null;
  if(state.stream){for(const track of state.stream.getTracks()) track.stop();state.stream=null;}
  const video=$('scan-video');video.pause();video.srcObject=null;video.hidden=true;
  $('camera-empty').hidden=false;$('camera-start').hidden=false;$('camera-stop').hidden=true;
}
function cameraDelay(signal,ms){
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,ms);
    signal.addEventListener('abort',finish,{once:true});
    if(signal.aborted)finish();
  });
}
async function startCamera(){
  state.scanAbort?.abort();
  if(!navigator.mediaDevices?.getUserMedia){showError('scan-error','カメラの利用にはHTTPSまたはlocalhostが必要です。');return;}
  stopCamera();const token=++state.scanToken;showError('scan-error','');
  const controller=new AbortController();state.cameraAbort=controller;
  let canvas,releaseTracks=()=>{};
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    if(token!==state.scanToken){stream.getTracks().forEach(t=>t.stop());return;}
    state.stream=stream;
    const tracks=stream.getTracks();
    const ended=()=>{
      if(token!==state.scanToken)return;
      stopCamera();showError('scan-error','カメラとの接続が終了しました。再度開始してください。');
    };
    releaseTracks=()=>{for(const track of tracks)track.removeEventListener('ended',ended);};
    for(const track of tracks)track.addEventListener('ended',ended,{once:true});
    controller.signal.addEventListener('abort',releaseTracks,{once:true});
    if(tracks.some(track=>track.readyState==='ended')){ended();return;}
    const video=$('scan-video');video.srcObject=stream;video.hidden=false;$('camera-empty').hidden=true;$('camera-start').hidden=true;$('camera-stop').hidden=false;
    await video.play();
    if(token!==state.scanToken)return;
    canvas=document.createElement('canvas');const ctx=canvas.getContext('2d',{willReadFrequently:true});
    let last=0;
    while(token===state.scanToken){
      const now=performance.now();if(video.readyState<2||now-last<180){await cameraDelay(controller.signal,75);continue;}last=now;
      const ratio=Math.min(1,2600/Math.max(video.videoWidth,video.videoHeight));
      canvas.width=Math.round(video.videoWidth*ratio);canvas.height=Math.round(video.videoHeight*ratio);
      if(canvas.width&&canvas.height){ctx.drawImage(video,0,0,canvas.width,canvas.height);try{const results=await readCanvas(canvas,{signal:controller.signal});if(token!==state.scanToken)break;if(results.length){presentResult(results[0]);stopCamera();break;}}catch(err){if(token!==state.scanToken||controller.signal.aborted)break;showError('scan-error',err.message);stopCamera();break;}}
      await cameraDelay(controller.signal,90);
    }
  }catch(e){if(token===state.scanToken){stopCamera();showError('scan-error','カメラを開始できませんでした。ブラウザの権限設定をご確認ください。');}}
  finally{
    releaseTracks();controller.signal.removeEventListener('abort',releaseTracks);
    if(canvas)canvas.width=canvas.height=0;
  }
}
$('camera-start').addEventListener('click',startCamera);
$('camera-stop').addEventListener('click',stopCamera);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();});
window.addEventListener('pagehide',()=>{
  stopCamera();
  state.pdfAbort?.abort();state.scanAbort?.abort();state.repairAbort?.abort();state.batchAbort?.abort();invalidateCorners();
});

const themeBtns=[$('theme-btn'),$('theme-btn-mobile')].filter(Boolean);
function setTheme(dark){document.documentElement.dataset.theme=dark?'dark':'light';for(const themeBtn of themeBtns){themeBtn.innerHTML=icon(dark?'sun':'moon');themeBtn.setAttribute('aria-label',dark?'ライトモードに切替':'ダークモードに切替');}}
setTheme(window.matchMedia?.('(prefers-color-scheme: dark)').matches??false);
themeBtns.forEach(themeBtn=>themeBtn.addEventListener('click',()=>setTheme(document.documentElement.dataset.theme!=='dark')));

refreshQR();
if('serviceWorker' in navigator && globalThis.isSecureContext) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
