'use strict';

// Pure, read-only comparison of an account-scoped upstream GET /v1/models
// response to the imported rows. Never reveals the provider API key, never
// guesses price/transport for unknown models and never modifies MySQL.
const {api888MediaModels}=require('./api888_models.js');

// Exact model IDs, not fuzzy “Seedance” matches: the 888API account-scoped
// /v1/models response decides which are currently available to this key.
// Do not manufacture access by enabling IDs absent from that response.
const MULTIMODAL_SEEDANCE_IDS=[
  'ss-2.5-720p-v1',
  's2-2.5-720p-v3',
  's2-2.5-720p-v4',
  'dola-seedance-2.5-301010',
  'seedance2.5-vip-30-10-10',
  'seedance-2.5-G2-V',
  'seedance-2.5-g5-v2',
];


function auditApi888Import(live,stored=[]){
  const entries=api888MediaModels(live);
  const upstream=new Map();
  for(const entry of entries){
    const id=entry.providerModelId;
    if(!upstream.has(id))upstream.set(id,entry);
  }
  const dbRows=Array.isArray(stored)?stored:[];
  const byId=new Map(dbRows.map(row=>[String(row.providerModelId||''),row]));
  const missing=[],stale=[],misclassified=[],notMarkedAvailable=[],details=[];
  let liveAdapterSupported=0,livePriced=0,liveReady=0,liveVisible=0,videoReady=0,imageReady=0;
  for(const [id,entry] of upstream){
    const row=byId.get(id);
    if(!row)missing.push(id);
    if(row&&row.available!==true)notMarkedAvailable.push(id);
    if(row&&row.mediaType!==entry.mediaType)
      misclassified.push({id,storedAs:row.mediaType,upstreamClassifiedAs:entry.mediaType});
    if(entry.options.adapterSupported)liveAdapterSupported++;
    if(Number(entry.options.api888?.sourceCny)>0)livePriced++;
    const supported=Boolean(row?.adapterSupported&&row?.ready&&row?.mediaType===entry.mediaType);
    const active=supported&&row?.enabled===true&&row?.available===true;
    if(supported)liveReady++;
    if(active){liveVisible++;if(entry.mediaType==='video')videoReady++;else imageReady++;}
    const reason=!row?'Missing from MySQL import':
      row.mediaType!==entry.mediaType?'Media type mismatch':
      row.available!==true?'Not marked available after sync':
      row.enabled!==true?'Disabled in Admin':
      row.adapterSupported!==true?'No verified CMM Tools adapter':
      !row.ready?(row.setupReason||'Missing valid source pricing or request contract'):
      'Ready to offer if provider and customer access are enabled';
    details.push({id,mediaType:entry.mediaType,inDatabase:Boolean(row),
      available:row?.available===true,enabled:row?.enabled===true,
      adapterSupported:row?.adapterSupported===true,
      ready:active,reason});
  }
  for(const row of dbRows){
    const id=String(row.providerModelId||'');
    if(!upstream.has(id))stale.push(id);
  }
  const multimodalSeedance=MULTIMODAL_SEEDANCE_IDS.map(id=>{
    const entry=upstream.get(id)||null;
    const row=byId.get(id)||null;
    const state=!entry?'not_returned_by_888api':
      !row?'not_imported_into_cmmtools':
      row.available!==true?'stale_available_flag':
      row.mediaType!=='video'?'incorrect_media_type':
      row.enabled!==true?'disabled_in_admin':
      entry.options.adapterSupported!==true?'adapter_not_implemented':
      row.adapterSupported!==true?'saved_adapter_metadata_outdated':
      row.ready!==true?'unready_pricing_or_contract':
      'ready_for_enabled_customer';
    const nextAction={
      not_returned_by_888api:'The saved API key did not return this model. Confirm model entitlement or ask 888API; do not force-add it.',
      not_imported_into_cmmtools:'The API key returned this model, but the model is absent from MySQL. Re-import after database writes work.',
      stale_available_flag:'The API key returned this model, but its saved availability is stale. Re-import after database writes work.',
      incorrect_media_type:'The saved model is misclassified. Correct the import mapping before enabling paid generation.',
      disabled_in_admin:'Enable this specific model in Admin only after verifying its capability and pricing.',
      adapter_not_implemented:'The provider lists this model but CMM Tools has no verified request adapter. Keep Admin-only pending implementation.',
      saved_adapter_metadata_outdated:'The provider lists a supported model, but the saved adapter flag is stale. Re-import only after database writes work.',
      unready_pricing_or_contract:'Inspect saved price and contract; do not force a paid generation.',
      ready_for_enabled_customer:'Available in CMM Tools when the 888API source and this customer account are enabled.',
    }[state];
    return {id,upstreamReturned:Boolean(entry),saved:Boolean(row),
      enabled:row?.enabled===true,available:row?.available===true,
      adapterSupported:entry?.options.adapterSupported===true,
      state,nextAction};
  });
  const summary={
    upstreamReturned:upstream.size,
    storedTotal:dbRows.length,
    storedMarkedAvailable:dbRows.filter(r=>r.available===true).length,
    previouslyImportedNotInLive:stale.length,
    missingFromImport:missing.length,
    notMarkedAvailable:notMarkedAvailable.length,
    mediaTypeMismatches:misclassified.length,
    upstreamKnownAdapterCount:liveAdapterSupported,
    upstreamWithLocalCnyPrice:livePriced,
    supportedReadyIncludingDisabled:liveReady,
    enabledReadyForCustomerCatalog:liveVisible,
    enabledReadyVideo:videoReady,
    enabledReadyImage:imageReady,
    adapterSupportedIncludingHistorical:dbRows.filter(r=>r.adapterSupported).length,
  };
  return {ok:missing.length===0&&notMarkedAvailable.length===0&&misclassified.length===0,
    summary,missing,notMarkedAvailable,mediaTypeMismatches:misclassified,stale,details,multimodalSeedance};
}
module.exports={auditApi888Import,MULTIMODAL_SEEDANCE_IDS};
