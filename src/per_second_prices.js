// What a video model costs per second at each resolution, for the Pricing
// page. Quoted at the shortest and longest clip with the studio's own pricing
// (quote is quoteModelForUser). A fixed-price model costs the same for any
// length, so its per-second price falls as the clip gets longer.
async function perSecondPrices(m,quote){
  const rows=[];
  for(const r of (m.resolutions?.length?m.resolutions:[{id:m.defaultResolution||null,durations:m.durations}])){
    const lengths=(r.durations||m.durations||[]).map(d=>Number(d.seconds)).filter(n=>n>0);
    if(!lengths.length)continue;
    const credits=async seconds=>{
      if(!m.dynamicCost)return Number((r.durations||[]).find(d=>Number(d.seconds)===seconds)?.cost)||null;
      try{return (await quote({model:m.id,mediaType:'video',duration:seconds,resolution:r.id,aspectRatio:m.defaultAspectRatio,generateAudio:m.supportsAudio===true})).cost;}catch{return null;}
    };
    const minSeconds=Math.min(...lengths),maxSeconds=Math.max(...lengths);
    const [minCredits,maxCredits]=await Promise.all([credits(minSeconds),credits(maxSeconds)]);
    if(!(minCredits>0&&maxCredits>0))continue;
    rows.push({name:m.label,resolution:r.id,minSeconds,maxSeconds,minCredits,maxCredits,
      fixedPrice:minCredits===maxCredits&&minSeconds!==maxSeconds,
      perSecondFrom:Math.round(maxCredits/maxSeconds*10)/10,perSecondTo:Math.round(minCredits/minSeconds*10)/10});
  }
  return rows;
}

module.exports={perSecondPrices};
