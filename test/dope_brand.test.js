'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { customerModelId, storedModelId, customerModelLabel, customerProviderAccess }=require('../src/dope_brand.js');
const { publicId, isWxksaiModel, wxksaiMediaModels }=require('../src/wxksai_models.js');
const { publicVideoModel }=require('../src/provider_models.js');
const { serializeGeneration }=require('../src/generations.js');
const { hideVendors, hideVendorsInBody }=require('../src/vendor_names.js');

const ALL_MODELS=[
  'sd 2.5掺水板',
  'seedance-2.5-special2','seedance-2.5-full-720p-9img',
  'seedance-2.5-full-720p-15-30s','seedance-2.5-bd-2',
  'wan3.0-video','seedance-2.0-full-720p-900','seedance2.5-buff',
];

test('all eight Dope catalog IDs are public aliases of existing stable WXKSAI rows',()=>{
  for(const id of ALL_MODELS){
    const legacy=publicId(id),brand=customerModelId(legacy);
    assert.match(legacy,/^wxksai_/);
    assert.match(brand,/^dope_/);
    assert.equal(storedModelId(brand),legacy);
    assert.ok(isWxksaiModel(brand));
    assert.ok(isWxksaiModel(legacy)); // Existing jobs and saved links remain valid.
  }
  assert.equal(isWxksaiModel('dope_unknown_model'),false);
  assert.equal(customerModelId('other_model'), 'other_model');
  assert.equal(storedModelId('other_model'), 'other_model');
});

test('public catalog offers Dope model names/IDs without upstream brand in payload',()=>{
  const saved=wxksaiMediaModels({data:ALL_MODELS.map(id=>({id}))});
  assert.equal(saved.length,8);
  for(const row of saved){
    // Old imports may carry old WXKSAI labels. Public output must still be white-labeled.
    const model={...row.options,provider:'wxksai',publicModelId:row.publicModelId,label:row.label,
      durations:row.options.durations,resolutions:row.options.resolutions,aspectRatios:row.options.aspectRatios};
    const payload=publicVideoModel(model);
    assert.match(payload.id,/^dope_/);
    assert.match(payload.label,/Dope/);
    assert.doesNotMatch(JSON.stringify(payload),/wxksai/i);
    assert.equal(storedModelId(payload.id),row.publicModelId);
    assert.ok(payload.capabilities.image);
  }
});

test('old user video histories and failures render exclusively as Dope',()=>{
  const raw={id:'test-id',media_type:'video',provider:'wxksai',model:publicId(ALL_MODELS[0]),
    duration:15,aspect_ratio:'16:9',status:'failed',credits_cost:100,provider_cost:2,
    error_message:'WXKSAI returned HTTP 502. WXKSAI task history should be checked.',
    generation_options:'{}',output_url:null};
  const record=serializeGeneration(raw);
  assert.match(record.model,/^dope_/);
  assert.match(record.error_message,/Dope/);
  assert.doesNotMatch(JSON.stringify(record),/wxksai/i);
  assert.equal(raw.model,publicId(ALL_MODELS[0])); // DB values stay unchanged.
});

test('source access and generic error replies expose Dope, not WXKSAI',()=>{
  const access=customerProviderAccess({aivid:true,wxksai:true,api888:false});
  assert.deepEqual(access,{aivid:true,api888:false,dope:true});
  assert.doesNotMatch(JSON.stringify(access),/wxksai/i);
  const response={error:'WXKSAI video is unavailable',nested:{message:'WXKSAI_TIMEOUT; WXKSAI returned HTTP 502.'}};
  hideVendorsInBody(response);
  assert.doesNotMatch(JSON.stringify(response),/wxksai/i);
  assert.match(JSON.stringify(response),/Dope/i);
  assert.equal(customerModelLabel('Seedance 2.5 Full · wxksai'),'Seedance 2.5 Full · Dope');
  assert.match(hideVendors('WXKSAI failed'),/Dope/);
});
