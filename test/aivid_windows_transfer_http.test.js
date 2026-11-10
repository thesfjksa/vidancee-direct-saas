'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{handle}=require('../src/aivid_rdp_http.js');
const UUID='12345678-1234-4234-9234-123456789012';
function response(){return{status:null,headers:{},body:null,writeHead(code,h){this.status=code;this.headers=h;},end(data){this.body=data;}};}
const url=(action,index)=>'/api/aivid-rdp/commands/'+UUID+'/'+action+'/'+index;
function service(command,storage={}){
 return {authorize:async h=>{if(h!=='Bearer paired-agent')throw Object.assign(new Error('unauthorized'),{aividSafe:true,statusCode:401});return {deviceId:'device'};},
 command:async()=>command,store:storage};
}
async function invoke(req,api){const res=response();await handle(req,res,req.url,{requireDatabase:()=>{},readJson:async()=>({}),instance:api});return res;}
test('only paired Windows agent reads claimed upload reference chunks',async()=>{
 const data=Buffer.from('image'),command={kind:'live',state:'running',payload:{action:'upload',file:{size:data.length}}};
 const api=service(command,{input:async(_id,index)=>{assert.equal(index,0);return data;}});
 const make=h=>({method:'GET',url:url('input',0),headers:{authorization:h}});
 let r=await invoke(make('Bearer paired-agent'),api);assert.equal(r.status,200);assert.deepEqual(r.body,data);
 r=await invoke(make('Bearer invalid'),api);assert.equal(r.status,401);
 command.state='staging';r=await invoke(make('Bearer paired-agent'),api);assert.equal(r.status,403);
 command.state='running';command.payload.action='frame';r=await invoke(make('Bearer paired-agent'),api);assert.equal(r.status,403);
});
test('live MP4 output chunks are accepted only for download, existing collect still works',async()=>{
 const command={kind:'live',state:'running',payload:{action:'download'}},saved=[];
 const api=service(command,{chunk:async(_id,index,data)=>saved.push({index,data})});
 const req=()=>Object.assign((async function*(){yield Buffer.from('chunk');})(),{method:'POST',url:url('chunks',0),headers:{authorization:'Bearer paired-agent'}});
 let r=await invoke(req(),api);assert.equal(r.status,200);assert.equal(saved.length,1);
 command.payload.action='click';r=await invoke(req(),api);assert.equal(r.status,409);assert.equal(saved.length,1);
 command.kind='collect';r=await invoke(req(),api);assert.equal(r.status,200);assert.equal(saved.length,2);
});
