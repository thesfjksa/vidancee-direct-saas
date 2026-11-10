'use strict';

const {SPECS: AIVID_MODELS} = require('./aivid_models.js');

// Retire CMM-Mini and AIVID from customer-facing model selections without deleting
// historical generations or altering other models' permissions/prices.
const CMM_MINI = /(?:^|[^a-z0-9])cmm[\s_.-]*mini(?=$|[^a-z0-9])/i;
// This is the actual historical CMM Mini SKU (MiniMax Origin Fast). Keep the
// pricing adapter for old jobs, but block its public listing and new requests.
const RETIRED_IDS = new Set(['seedance_2_0_mini', ...AIVID_MODELS.map(model => model.id)]);
function isRetiredModel(model) {
  const names=typeof model==='string'?[model]:[
    model?.id,model?.publicModelId,model?.providerModelId,model?.label,model?.name,
  ];
  return names.some(v=>typeof v==='string' &&
    (RETIRED_IDS.has(v.toLowerCase()) || CMM_MINI.test(v)));
}
module.exports={isRetiredModel};
