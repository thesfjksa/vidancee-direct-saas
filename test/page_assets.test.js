'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {renderAdminPage,renderStudioPage}=require('../src/page_assets');

test('production Admin HTML contains the matching local navigation and other scripts, not cacheable external script URLs',()=>{
  const page=renderAdminPage();
  for(const file of ['dope-performance.js','provider-admin.js','aivid-admin.js','longai-admin.js']){
    assert.ok(page.includes('data-inline-asset="'+file+'"'),file);
    assert.doesNotMatch(page, new RegExp('<script src="/'+file.replace('.','\\.')+'(?:[?"]|$)'));
  }
  assert.match(page,/data-provider-source="huiqu"/);
  assert.match(page,/const cards = \(\) => \[\.\.\.document.querySelectorAll\('\[data-provider-source\]'\)\]/);
  assert.match(page,/if \(key === 'huiqu'\) loadHuiquModels/);
  assert.doesNotMatch(page,/<link rel="stylesheet"/);
  assert.ok(page.indexOf('data-inline-asset="provider-admin.js"')>page.indexOf('id="providerSourceCards"'));
  // Inline assets are explicitly allowlisted; arbitrary remote references or
  // unknown local files stay untouched.
  const raw='<script src="/untrusted.js"></script><script src="/provider-admin.js?v=6"></script>';
  const rendered=renderAdminPage(raw,file=>{assert.equal(file,'provider-admin.js');return 'const x = "</script>";';});
  assert.match(rendered,/<script src="\/untrusted.js"><\/script>/);
  assert.ok(rendered.includes('<\\/script>'));
});
test('studio JS URLs automatically change when the underlying script changes',()=>{
  const raw='<script src="/dope-performance.js?v=7"></script><script src="/voice-picker.js?v=old"></script>';
  const a=renderStudioPage(raw,()=> 'old bytes');
  const b=renderStudioPage(raw,()=> 'new bytes');
  assert.notEqual(a,b);
  assert.match(a,/dope-performance\.js\?v=[0-9a-f]{16}/);
  assert.match(b,/voice-picker\.js\?v=[0-9a-f]{16}/);
  assert.notEqual(renderStudioPage(),fs.readFileSync(require.resolve('../public/index.html'),'utf8'));
});
