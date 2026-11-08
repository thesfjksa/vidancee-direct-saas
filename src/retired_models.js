'use strict';

// Retire CMM-Mini from every customer-facing model selection without deleting
// historical generations or altering other models' permissions/prices.
const CMM_MINI = /(?:^|[^a-z0-9])cmm[\s_.-]*mini(?=$|[^a-z0-9])/i;
function isRetiredModel(model) {
  const names=typeof model==='string'?[model]:[
    model?.id,model?.publicModelId,model?.providerModelId,model?.label,model?.name,
  ];
  return names.some(v=>typeof v==='string' && CMM_MINI.test(v));
}
module.exports={isRetiredModel};
