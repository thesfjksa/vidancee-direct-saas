'use strict';
// Authenticated, immutable-per-process worker release. No account data enters it.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FILES={'agent.cjs':'scripts/aivid-rdp/agent.cjs','native.cjs':'scripts/aivid-rdp/native.cjs','provider/aivid.js':'src/provider/aivid.js','provider/aivid_uploads.js':'src/provider/aivid_uploads.js','provider/browserless.js':'src/provider/browserless.js','aivid_models.js':'src/aivid_models.js'};
let release;
function runtime(){
 if(release)return release;
 const files=Object.entries(FILES).map(([name,file])=>{const data=fs.readFileSync(path.join(__dirname,'..',file));return {path:name,data,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}});
 const manifest={protocol:1,files:files.map(({data,...entry})=>entry)};
 manifest.version=crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 return release={manifest,files:new Map(files.map(f=>[f.path,f.data]))};
}
module.exports={runtime};
