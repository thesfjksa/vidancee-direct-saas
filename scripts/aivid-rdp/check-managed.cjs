'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),{execFile}=require('node:child_process');
(async()=>{
 const root=process.env.AIVID_PACKAGE_ROOT,{runtime}=require('../../src/aivid_runtime.js'),release=runtime();
 const {install}=require(path.join(root,'worker.cjs'));
 const transport={request:async route=>route==='/runtime'?release.manifest:release.files.get(new URL('https://fixture.invalid'+route).searchParams.get('path'))};
 const staged=await install(root,transport);
 const script="const a=require(process.argv[1]);const p=require(process.argv[2]);(async()=>{const value='managed-test-secret';const enc=await a.protect('protect',value);if(enc===value||await a.protect('unprotect',enc)!==value)throw Error('DPAPI');p.validateJob({prompt:'Test',duration:5,resolution:'480p'});require('playwright-core');console.log('Managed release module/dependency/DPAPI checks passed')})().catch(()=>process.exit(1))";
 await new Promise((resolve,reject)=>execFile(path.join(root,'node.exe'),['-e',script,path.join(staged.target,'agent.cjs'),path.join(staged.target,'provider/aivid.js')],{cwd:root,env:{...process.env,AIVID_AGENT_ROOT:root}},(error,stdout)=>{if(error)reject(error);else{process.stdout.write(stdout);resolve();}}));
 await fs.rm(path.join(root,'.aivid-runtime'),{recursive:true,force:true});
})().catch(()=>{console.error('Managed release runtime check failed.');process.exitCode=1});
