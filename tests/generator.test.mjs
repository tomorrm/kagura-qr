import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qrMatrix,renderSVG,wifiPayload} from '../src/generator.js';
import {inspectContent} from '../src/security.js';

test('creates a valid square matrix for ASCII',()=>{const m=qrMatrix('https://example.com');assert.equal(m.length,m[0].length);assert.ok(m.length>=21);});
test('handles Japanese UTF8 content',()=>{const m=qrMatrix('こんにちは・神楽QR');assert.ok(m.length>=21);});
test('SVG keeps four-module quiet zone',()=>{const m=qrMatrix('https://example.com');const s=renderSVG(m);assert.ok(s.includes(`viewBox="0 0 ${m.length+8} ${m.length+8}"`));});
test('recovery level changes code density',()=>{const s='https://example.com/very/long/test/path'.repeat(5);assert.ok(qrMatrix(s,'H').length>=qrMatrix(s,'L').length);});
test('rejects empty or excessively long content',()=>{assert.throws(()=>qrMatrix(''));assert.throws(()=>qrMatrix('あ'.repeat(1000)));});
test('wifi payload escapes separators',()=>assert.ok(wifiPayload({ssid:'foo;bar',password:'hello:world'}).includes('foo\\;bar')));
test('blocks dangerous URL schemes',()=>{assert.equal(inspectContent('javascript:alert(1)').kind,'blocked');assert.equal(inspectContent('https://example.com').kind,'url');});

test('non-ASCII QR matrix is deterministic and square', () => {
  const a=qrMatrix('日本語と絵文字 🐧', 'Q');
  const b=qrMatrix('日本語と絵文字 🐧', 'Q');
  assert.deepEqual(a,b);
  assert.ok(a.every(row => row.length === a.length));
});

test('QR URL parser warns on invisible Unicode controls and credentials',()=>{
  assert.equal(inspectContent('https://example.com/\u202Eabc').kind,'caution');
  assert.equal(inspectContent('https://user:pass@example.com').kind,'caution');
  assert.notEqual(inspectContent('data:text/html,aaa').kind,'url');
});
