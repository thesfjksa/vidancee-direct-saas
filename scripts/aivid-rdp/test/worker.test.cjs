'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {supervise}=require('../worker.cjs');
function fixture(codes){
 const launched=[],waits=[];let installs=0;
 return {launched,waits,get installs(){return installs;},options:{root:__dirname,transport:{},
  installRelease:async()=>({target:__dirname,version:'release-'+(++installs)}),
  pause:async ms=>waits.push(ms),
  start:(exe,args,options)=>{assert.ok(codes.length,'unexpected restart');launched.push(options.env.AIVID_RUNTIME_VERSION);assert.equal(options.shell,false);assert.equal(options.env.AIVID_PAIRING_STDIN,undefined);const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',codes.shift()));return child;}
 }};
}
test('runtime update exits reload the verified release without terminating the launcher',async()=>{
 const f=fixture([42,42,0]);assert.equal(await supervise(f.options),0);
 assert.deepEqual(f.launched,['release-1','release-2','release-3']);assert.deepEqual(f.waits,[]);
});
test('unexpected exits retry with a bounded counter and a successful update resets it',async()=>{
 for(const codes of [[1,1,1,1],[1,1,42,1,1,1,1],[null,0]]){
  const expected=codes.length,last=codes.at(-1),f=fixture([...codes]);
  assert.equal(await supervise(f.options),last);assert.equal(f.launched.length,expected);
  assert.ok(f.waits.every(ms=>ms===5000));
 }
});
test('rejected credentials and clean shutdowns do not restart',async()=>{
 for(const code of [23,0]){const f=fixture([code]);assert.equal(await supervise(f.options),code);assert.equal(f.installs,1);assert.deepEqual(f.waits,[]);}
});
test('release connection failures wait without starting unverified code; rejection stops',async()=>{
 const f=fixture([0]),install=f.options.installRelease;let calls=0;
 f.options.installRelease=async()=>{if(++calls===1)throw Object.assign(Error('offline'),{network:true});return install();};
 assert.equal(await supervise(f.options),0);assert.equal(f.launched.length,1);assert.deepEqual(f.waits,[30000]);
 f.options.installRelease=async()=>{throw Object.assign(Error('rejected'),{statusCode:401});};
 await assert.rejects(supervise(f.options),{statusCode:401});assert.equal(f.launched.length,1);
});
