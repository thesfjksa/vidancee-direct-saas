'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {isRetiredModel}=require('../src/retired_models.js');

test('retire CMM-Mini by current ID, external endpoint or custom display label',()=>{
  for(const id of ['cmm-mini','cmm_mini','CMM Mini','CMM.Mini','studio_cmm-mini','fal_cmm_mini_1']){
    assert.equal(isRetiredModel(id),true,id);
  }
  assert.equal(isRetiredModel({publicModelId:'model_27',providerModelId:'fal-ai/some-image',label:'CMM-Mini'}),true);
  assert.equal(isRetiredModel({publicModelId:'cmm_mini',label:'Other name'}),true);
  for(const value of ['MiniMax H3','nano-banana-mini','cmm-model','mini alone','cmm-millennium']){
    assert.equal(isRetiredModel(value),false,value);
  }
  assert.equal(isRetiredModel({publicModelId:'fal_ai_flux_2',label:'FLUX 2'}),false);
});
