'use strict';

const {SPECS: AIVID_MODELS} = require('./aivid_models.js');

// Retire CMM-Mini, Origin Standard and AIVID from customer-facing selections without deleting
// historical generations or altering other models' permissions/prices.
const CMM_MINI = /(?:^|[^a-z0-9])cmm[\s_.-]*mini(?=$|[^a-z0-9])/i;
// Keep pricing and routing for retired CMM Mini and Origin Standard jobs,
// but block their public listing and new requests.
const RETIRED_IDS = new Set(['seedance_2_0_mini', 'minimax_h3_origin_standard', ...AIVID_MODELS.map(model => model.id)]);
function isRetiredModel(model) {
  const names=typeof model==='string'?[model]:[
    model?.id,model?.publicModelId,model?.providerModelId,model?.label,model?.name,
  ];
  return names.some(v=>typeof v==='string' &&
    (RETIRED_IDS.has(v.toLowerCase()) || CMM_MINI.test(v)));
}
module.exports={isRetiredModel};
