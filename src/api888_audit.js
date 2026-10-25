'use strict';

// Pure, read-only comparison of an account-scoped upstream GET /v1/models
// response to the imported rows. Never reveals the provider API key, never
// guesses price/transport for unknown models and never modifies MySQL.
const {api888MediaModels}=require('./api888_models.js');

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
    summary,missing,notMarkedAvailable,mediaTypeMismatches:misclassified,stale,details};
}
module.exports={auditApi888Import};
