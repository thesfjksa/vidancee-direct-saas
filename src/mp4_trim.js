'use strict';
// Lossless MP4/MOV trimming: keeps the first `seconds` of every track by
// rewriting the sample tables and copying the kept samples, with no
// re-encoding. Cutting in decode order keeps every kept frame decodable.
// Fragmented MP4 (moof) and compact sample sizes (stz2) are not supported.

const CONTAINERS=new Set(['moov','trak','mdia','minf','stbl','edts','dinf']);

function readBoxes(buf,start=0,end=buf.length){
  const boxes=[];
  for(let at=start;at+8<=end;){
    let size=buf.readUInt32BE(at),header=8;
    const type=buf.toString('latin1',at+4,at+8);
    if(size===1){size=Number(buf.readBigUInt64BE(at+8));header=16;}
    else if(size===0)size=end-at;
    if(size<header||at+size>end)throw new Error('Invalid MP4 box '+type+'.');
    const box={type,start:at,size,header,data:buf.subarray(at+header,at+size)};
    if(CONTAINERS.has(type))box.children=readBoxes(buf,at+header,at+size);
    boxes.push(box);
    at+=size;
  }
  return boxes;
}
const find=(boxes,type)=>boxes&&boxes.find(b=>b.type===type);
const path=(box,...types)=>types.reduce((b,t)=>b&&find(b.children,t),box);

function box(type,payload){
  const head=Buffer.alloc(8);head.writeUInt32BE(8+payload.length);head.write(type,4,'latin1');
  return Buffer.concat([head,payload]);
}
function serialize(node){
  if(node.raw)return node.raw;
  if(node.children)return box(node.type,Buffer.concat(node.children.map(serialize)));
  return box(node.type,node.data);
}
// Mutable copy of the box tree (leaves keep their bytes until replaced).
function clone(b){return b.children?{type:b.type,children:b.children.map(clone)}:{type:b.type,data:Buffer.from(b.data)};}
const fullHeader=data=>data.subarray(0,4);

function sampleTables(stbl){
  const get=t=>{const b=find(stbl.children,t);return b&&b.data;};
  if(get('stz2'))throw new Error('Compact sample sizes are not supported.');
  const stts=get('stts'),stsz=get('stsz'),stsc=get('stsc'),stco=get('stco'),co64=get('co64');
  if(!stts||!stsz||!stsc||!(stco||co64))throw new Error('MP4 track is missing sample tables.');
  const durations=[];
  for(let i=0,n=stts.readUInt32BE(4);i<n;i++){
    const count=stts.readUInt32BE(8+i*8),delta=stts.readUInt32BE(12+i*8);
    for(let k=0;k<count;k++)durations.push(delta);
  }
  const fixed=stsz.readUInt32BE(4),count=stsz.readUInt32BE(8);
  const sizes=Array.from({length:count},(_,i)=>fixed||stsz.readUInt32BE(12+i*4));
  const chunkOffsets=[];
  if(co64)for(let i=0,n=co64.readUInt32BE(4);i<n;i++)chunkOffsets.push(Number(co64.readBigUInt64BE(8+i*8)));
  else for(let i=0,n=stco.readUInt32BE(4);i<n;i++)chunkOffsets.push(stco.readUInt32BE(8+i*4));
  const runs=[];
  for(let i=0,n=stsc.readUInt32BE(4);i<n;i++)
    runs.push({first:stsc.readUInt32BE(8+i*12),per:stsc.readUInt32BE(12+i*12),desc:stsc.readUInt32BE(16+i*12)});
  const offsets=[],descs=[];
  let sample=0;
  for(let c=0;c<chunkOffsets.length&&sample<count;c++){
    let run=runs[0];
    for(const r of runs)if(r.first<=c+1)run=r;
    let at=chunkOffsets[c];
    for(let k=0;k<run.per&&sample<count;k++,sample++){offsets.push(at);descs.push(run.desc);at+=sizes[sample];}
  }
  if(offsets.length!==count||durations.length<count)throw new Error('MP4 sample tables are inconsistent.');
  return {durations:durations.slice(0,count),sizes,offsets,descs};
}

function u32(n){const b=Buffer.alloc(4);b.writeUInt32BE(n>>>0);return b;}
function rewriteDuration(data,version,offset32,offset64,value){
  if(version===1)data.writeBigUInt64BE(BigInt(Math.round(value)),offset64);
  else data.writeUInt32BE(Math.min(0xffffffff,Math.round(value)),offset32);
}

// Returns {data,seconds,trimmed}. `data` is unchanged when it already fits.
function trimMp4(input,seconds){
  if(!Buffer.isBuffer(input)||!(seconds>0))throw new Error('Nothing to trim.');
  const top=readBoxes(input);
  if(top.some(b=>b.type==='moof'))throw new Error('Fragmented MP4 cannot be trimmed.');
  const moovBox=find(top,'moov');
  if(!moovBox)throw new Error('The video has no MP4 header.');
  const moov=clone(moovBox);
  const mvhd=find(moov.children,'mvhd'),movieScale=mvhd.data[0]===1?mvhd.data.readUInt32BE(20):mvhd.data.readUInt32BE(12);
  const movieDuration=mvhd.data[0]===1?Number(mvhd.data.readBigUInt64BE(24)):mvhd.data.readUInt32BE(16);
  if(movieDuration/movieScale<=seconds+0.01)return {data:input,seconds:movieDuration/movieScale,trimmed:false};

  const tracks=[];
  for(const trak of moov.children.filter(c=>c.type==='trak')){
    const mdhd=path(trak,'mdia','mdhd'),stbl=path(trak,'mdia','minf','stbl');
    const scale=mdhd.data[0]===1?mdhd.data.readUInt32BE(20):mdhd.data.readUInt32BE(12);
    const t=sampleTables(stbl),limit=seconds*scale;
    let keep=0;
    // Keep samples that end within the limit, so no track runs past it.
    for(let end=t.durations[0]||0;keep<t.durations.length&&end<=limit+1;keep++,end+=t.durations[keep]||0);
    tracks.push({trak,mdhd,stbl,scale,keep,...t,mediaDuration:t.durations.slice(0,keep).reduce((a,b)=>a+b,0)});
  }

  // Kept samples in their original file order, so A/V interleaving survives.
  const all=[];
  tracks.forEach((t,ti)=>{for(let i=0;i<t.keep;i++)all.push({ti,i,offset:t.offsets[i],size:t.sizes[i]});});
  all.sort((a,b)=>a.offset-b.offset||a.ti-b.ti);
  const position=new Map();
  let mdatLength=0;
  for(const s of all){position.set(s.ti+':'+s.i,mdatLength);mdatLength+=s.size;}

  let newMovieDuration=0;
  for(const [ti,t] of tracks.entries()){
    const set=(type,data)=>{const b=find(t.stbl.children,type);if(b)b.data=data;};
    const n=t.keep;
    // stts
    const runs=[];
    for(let i=0;i<n;i++){const d=t.durations[i];if(runs.length&&runs[runs.length-1][1]===d)runs[runs.length-1][0]++;else runs.push([1,d]);}
    set('stts',Buffer.concat([fullHeader(find(t.stbl.children,'stts').data),u32(runs.length),...runs.flatMap(([c,d])=>[u32(c),u32(d)])]));
    // ctts: keep entries covering the first n samples
    const ctts=find(t.stbl.children,'ctts');
    if(ctts){
      const out=[];let left=n;
      for(let i=0,m=ctts.data.readUInt32BE(4);i<m&&left>0;i++){
        const c=Math.min(left,ctts.data.readUInt32BE(8+i*8));out.push(u32(c),ctts.data.subarray(12+i*8,16+i*8));left-=c;
      }
      ctts.data=Buffer.concat([fullHeader(ctts.data),u32(out.length/2),...out]);
    }
    const stss=find(t.stbl.children,'stss');
    if(stss){
      const keepSync=[];
      for(let i=0,m=stss.data.readUInt32BE(4);i<m;i++){const s=stss.data.readUInt32BE(8+i*4);if(s<=n)keepSync.push(u32(s));}
      stss.data=Buffer.concat([fullHeader(stss.data),u32(keepSync.length),...keepSync]);
    }
    const sdtp=find(t.stbl.children,'sdtp');
    if(sdtp)sdtp.data=Buffer.concat([fullHeader(sdtp.data),sdtp.data.subarray(4,4+n)]);
    const sbgp=find(t.stbl.children,'sbgp');
    if(sbgp){
      const v=sbgp.data[0],base=v===1?16:12,out=[];let left=n;
      for(let i=0,m=sbgp.data.readUInt32BE(base-4);i<m&&left>0;i++){
        const c=Math.min(left,sbgp.data.readUInt32BE(base+i*8));out.push(u32(c),sbgp.data.subarray(base+4+i*8,base+8+i*8));left-=c;
      }
      sbgp.data=Buffer.concat([sbgp.data.subarray(0,base-4),u32(out.length/2),...out]);
    }
    set('stsz',Buffer.concat([fullHeader(find(t.stbl.children,'stsz').data),u32(0),u32(n),...t.sizes.slice(0,n).map(u32)]));
    // One sample per chunk; stsc runs follow the sample description index.
    const stscRuns=[];
    for(let i=0;i<n;i++)if(!stscRuns.length||stscRuns[stscRuns.length-1].desc!==t.descs[i])stscRuns.push({first:i+1,desc:t.descs[i]});
    set('stsc',Buffer.concat([fullHeader(find(t.stbl.children,'stsc').data),u32(stscRuns.length),...stscRuns.flatMap(r=>[u32(r.first),u32(1),u32(r.desc)])]));
    t.positions=Array.from({length:n},(_,i)=>position.get(ti+':'+i));
    t.stbl.children=t.stbl.children.filter(c=>c.type!=='co64');
    if(!find(t.stbl.children,'stco'))t.stbl.children.push({type:'stco',data:Buffer.alloc(8)});
    find(t.stbl.children,'stco').data=Buffer.concat([Buffer.alloc(4),u32(n),...t.positions.map(()=>u32(0))]);
    // Durations
    const v=t.mdhd.data[0];
    rewriteDuration(t.mdhd.data,v,16,24,t.mediaDuration);
    const movieUnits=t.mediaDuration/t.scale*movieScale;
    newMovieDuration=Math.max(newMovieDuration,movieUnits);
    const tkhd=find(t.trak.children,'tkhd');
    rewriteDuration(tkhd.data,tkhd.data[0],20,28,movieUnits);
    const elst=path(t.trak,'edts','elst');
    if(elst){
      const ev=elst.data[0],entry=ev===1?20:12;let left=movieUnits;
      for(let i=0,m=elst.data.readUInt32BE(4);i<m;i++){
        const at=8+i*entry,mediaTime=ev===1?Number(elst.data.readBigInt64BE(at+8)):elst.data.readInt32BE(at+4);
        if(mediaTime<0)continue; // empty edit (start delay)
        const dur=ev===1?Number(elst.data.readBigUInt64BE(at)):elst.data.readUInt32BE(at);
        const next=Math.max(0,Math.min(dur,left));left-=next;
        if(ev===1)elst.data.writeBigUInt64BE(BigInt(Math.round(next)),at);else elst.data.writeUInt32BE(Math.round(next),at);
      }
    }
  }
  rewriteDuration(mvhd.data,mvhd.data[0],16,24,newMovieDuration);

  const ftyp=find(top,'ftyp');
  const ftypBytes=ftyp?input.subarray(ftyp.start,ftyp.start+ftyp.size):Buffer.alloc(0);
  const moovSize=serialize(moov).length,mdatStart=ftypBytes.length+moovSize+8;
  if(mdatStart+mdatLength>0xffffffff)throw new Error('Video is too large to trim.');
  for(const t of tracks){
    const stco=find(t.stbl.children,'stco').data;
    t.positions.forEach((p,i)=>stco.writeUInt32BE(mdatStart+p,8+i*4));
  }
  const mdat=Buffer.alloc(8+mdatLength);
  mdat.writeUInt32BE(8+mdatLength);mdat.write('mdat',4,'latin1');
  let at=8;
  for(const s of all){input.copy(mdat,at,s.offset,s.offset+s.size);at+=s.size;}
  return {data:Buffer.concat([ftypBytes,serialize(moov),mdat]),seconds:newMovieDuration/movieScale,trimmed:true};
}

// True when the buffer is a whole MP4: top-level boxes exactly fill it and
// both the media data and the moov index are present.
function isCompleteMp4(buf){
  if(!Buffer.isBuffer(buf)||buf.length<16||buf.toString('latin1',4,8)!=='ftyp')return false;
  let boxes;
  try{boxes=readBoxes(buf);}catch{return false;}
  const end=boxes.length?boxes[boxes.length-1].start+boxes[boxes.length-1].size:0;
  const has=t=>boxes.some(b=>b.type===t);
  return end===buf.length&&has('moov')&&(has('mdat')||has('moof'));
}

module.exports={trimMp4,readBoxes,isCompleteMp4};
