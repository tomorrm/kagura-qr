import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectContent} from '../src/security.js';
test('decoded QR never creates auto-open links for active schemes or opaque protocols',()=>{
  for(const value of ['javascript:alert(1)','data:text/html,evil','vbscript:foo','file:///etc/passwd']){
    const result=inspectContent(value);assert.equal(result.kind,'blocked');assert.equal(result.url,undefined);
  }
  assert.equal(inspectContent('https://example.com').kind,'url');
  assert.equal(inspectContent('https://user:pw@example.com').url,undefined);
  assert.equal(inspectContent('https://xn--e1afmkfd.xn--p1ai').url,undefined);
});
test('bidi/zero width text cannot produce openable URLs',()=>{
  for(const payload of ['https://a.test/\u202eother.test','https://a.test/\u200badmin']){
    const result=inspectContent(payload);assert.equal(result.kind,'caution');assert.equal(result.url,undefined);
  }
});
test('service worker precaches fixed assets only (no unbounded URL cache)',async()=>{
  const text=await readFile(new URL('../service-worker.js',import.meta.url),'utf8');
  assert.ok(text.includes('cache.addAll(CORE)'));
  assert.ok(!text.includes('cache.put('));
});
