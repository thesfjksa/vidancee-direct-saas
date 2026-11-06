'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {runtime}=require('../src/aivid_runtime.js');
const {validateManifest,install}=require('../scripts/aivid-rdp/worker.cjs');
test('managed releases authenticate integrity, stage complete files and refuse corrupt updates',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'aivid-managed-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const release=runtime();validateManifest(release.manifest);
 let corrupt=true;
 const transport={request:async route=>{
  if(route==='/runtime')return release.manifest;
  const u=new URL('https://cmmtools.test'+route),name=u.searchParams.get('path');
  assert.equal(u.searchParams.get('version'),release.manifest.version);
  return corrupt?Buffer.from('corrupt'):release.files.get(name);
 }};
 await assert.rejects(install(root,transport),/integrity/);assert.deepEqual(await fs.readdir(path.join(root,'.aivid-runtime')),[]);
 corrupt=false;const first=await install(root,transport);assert.equal(first.version,release.manifest.version);
 transport.request=async route=>{assert.equal(route,'/runtime');return release.manifest};
 assert.equal((await install(root,transport)).target,first.target,'a fully verified immutable release is reused');
 transport.request=async()=>{throw Object.assign(new Error('unauthorized'),{statusCode:401})};
 await assert.rejects(install(root,transport),{statusCode:401});
});
test('worker manifests reject traversal, duplicate names, oversized files and changed identity',()=>{
 const m=runtime().manifest;
 for(const mutate of [x=>x.files[0].path='../secret',x=>x.files[1].path=x.files[0].path,x=>x.files[0].bytes=9999999,x=>x.version='a'.repeat(64)]){
  const copy=JSON.parse(JSON.stringify(m));mutate(copy);assert.throws(()=>validateManifest(copy));
 }
});
