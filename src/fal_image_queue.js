'use strict';
// Image jobs on fal.ai models ('falimg'): the shared priced-image queue, with
// fal's queue API behind generateImage. Uses the saved fal.ai key and switch.
const {VercelQueue}=require('./vercel_queue.js');
const {FalImageClient,PROVIDER}=require('./fal_images.js');
class FalImageQueue extends VercelQueue{
  constructor(options={}){super({...options,provider:PROVIDER,clientFactory:options.clientFactory||(o=>new FalImageClient(o))});}
  apiKey(s){return s.falApiKey||'';}
  sourceEnabled(s){return Boolean(s.falEnabled);}
  maxInflight(s){return s.falMaxInflight||3;}
  schedule(delay=this.sourceReady?2000:5000){super.schedule(delay);}
}

module.exports={FalImageQueue};
