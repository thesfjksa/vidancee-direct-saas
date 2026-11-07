'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {durationVerified}=require('../src/provider/aivid.js');
const html=fs.readFileSync(require.resolve('../public/index.html'),'utf8');
test('AIVID duration verified against slider value, ARIA, and displayed 15s label',()=>{
  const base={value:15,ariaNow:null,ariaText:null,labels:[15],min:4,max:15,step:1};
  assert.equal(durationVerified(base,15),true);
  assert.equal(durationVerified({...base,labels:[14]},15),false);
  assert.equal(durationVerified({...base,ariaNow:14},15),false);
  assert.equal(durationVerified({...base,ariaText:14},15),false);
  assert.equal(durationVerified({...base,value:14},15),false);
  assert.equal(durationVerified({...base,labels:[]},15),true);
});
test('Premium Video Studio honors each model default and preserves a chosen duration on resolution changes',()=>{
  assert.match(html,/m\.premium\s*&&\s*durations\.some\(d=>Number\(d\.seconds\)===preferred\)/);
  assert.match(html,/const preferred=Number\(m\.premium\?m\.defaultDuration:NaN\)/);
});
