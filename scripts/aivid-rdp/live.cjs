'use strict';
// Restricted interactive Edge *page surface* (not the Windows desktop).
// Uses a NEW per-customer Edge user-data directory, never the paid-job
// .aivid-rdp-edge-profile or saved agent credentials.
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright-core');
const {findBrowser}=require('./native.cjs');
const MAX_FRAME=450000;
const MAX_VIDEO=100*1024*1024;
const TTL=15*60*1000;

function allowedUrl(value,navigation=false){
  let url;try{url=new URL(value);}catch{return false;}
  if(url.protocol!=='https:'||url.username||url.password)return false;
  const host=url.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.localhost')||host==='metadata.google.internal'||host.endsWith('.internal')||
     /^(?:127|0|10|192\.168)\./.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)||host==='169.254.169.254')
    return false;
  if(!navigation)return true;
  return host==='aivid.dev'||host.endsWith('.aivid.dev')||
    host==='google.com'||host.endsWith('.google.com')||
    host==='googleusercontent.com'||host.endsWith('.googleusercontent.com');
}
function id(value){if(!/^[1-9]\d{0,14}$/.test(String(value||'')))throw new Error('Invalid customer identity.');return String(value);}
const safeName=value=>String(value||'').replaceAll('\\','/').split('/').pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'_').slice(0,120)||'reference';
class WindowsLive {
  constructor({root,launch,now=Date.now}={}){
    this.root=root||process.env.AIVID_AGENT_ROOT||__dirname;
    this.launch=launch||((dir)=>chromium.launchPersistentContext(dir,{
      executablePath:findBrowser('edge'),headless:false,acceptDownloads:true,
      viewport:{width:1280,height:760},
      args:['--no-first-run','--no-default-browser-check']}));
    this.now=now;this.state=null;
  }
  async shutdown(){
    const old=this.state;this.state=null;
    if(old?.context)await old.context.close().catch(()=>{});
  }
  async open(owner){
    const target=id(owner);
    if(this.state&&this.state.owner!==target&&this.state.expires>this.now())
      throw new Error('Another isolated Premium browser session is active on this Windows agent.');
    if(this.state?.owner===target&&this.state.expires>this.now())return this.state;
    await this.shutdown();
    const dir=path.join(this.root,'.aivid-live-profile-u'+target);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const context=await this.launch(dir);
    const state={owner:target,context,page:null,expires:this.now()+TTL,
      chooser:null,download:null,notice:'Dedicated Edge profile. Provider sign-in is separate from the AIVID job agent.'};
    this.state=state;
    await context.route('**/*',async route=>{
      const request=route.request();
      let nav=false;
      try{nav=request.isNavigationRequest()&&request.frame()===request.frame().page().mainFrame();}catch{}
      if(!allowedUrl(request.url(),nav))return route.abort().catch(()=>{});
      return route.continue().catch(()=>{});
    });
    const attach=page=>{
      page.on('filechooser',chooser=>{state.chooser=chooser;state.notice='Choose a reference file from CMMTools Upload.';});
      page.on('download',download=>{state.download=download;state.notice='Video download detected. Use Save video in CMMTools.';});
      page.on('close',()=>{if(state.page===page)state.page=context.pages().find(p=>!p.isClosed())||null;});
      // Google OAuth can open a new Edge tab/window within this isolated context.
      page.on('popup',popup=>{state.page=popup;});
    };
    context.on('page',page=>{
      attach(page);
      if(state.page)state.page=page;
    });
    const page=context.pages().find(p=>!p.isClosed())||await context.newPage();
    state.page=page;attach(page);
    try{await page.goto('https://aivid.dev/',{waitUntil:'domcontentloaded',timeout:35000});}
    catch{state.notice='AIVID may need attention. Check the Windows Edge browser.';}
    return state;
  }
  async run(payload,file=null){
    const owner=id(payload.owner),action=String(payload.action);
    if(action==='open')await this.open(owner);
    if(action==='close'){
      if(this.state&&this.state.owner!==owner&&this.state.expires>this.now())throw new Error('Browser belongs to another customer.');
      await this.shutdown();
      return {state:'frame',jpeg:'',url:'',notice:'Closed your private browser session.',fileName:'',uploadPending:false,downloadReady:false};
    }
    const s=this.state;
    if(!s||s.owner!==owner||s.expires<=this.now()){
      if(s&&s.expires<=this.now())await this.shutdown();
      throw new Error('Private browser session not open or expired.');
    }
    let page=s.page;
    if(!page||page.isClosed()){page=s.context.pages().find(p=>!p.isClosed());s.page=page||null;}
    if(!page)throw new Error('The Edge browser was closed.');
    if(action==='click')await page.mouse.click(payload.x,payload.y);
    else if(action==='scroll')await page.mouse.wheel(0,payload.delta);
    else if(action==='type')await page.keyboard.insertText(payload.text);
    else if(action==='key')await page.keyboard.press(payload.key==='Space'?'Space':payload.key);
    else if(action==='upload'){
      if(!s.chooser||!file)throw new Error('Click an AIVID reference upload field first.');
      if(file.length>30*1024*1024||file.length<1)throw new Error('Reference size is outside the limit.');
      const chooser=s.chooser;s.chooser=null;
      await chooser.setInputFiles({name:safeName(payload.name),mimeType:payload.mime,data:file});
      s.notice='Reference supplied to AIVID. Confirm the file appears in its editor.';
    }
    else if(action==='download'){
      if(!s.download)throw new Error('Click AIVID Download first, then click Save video in CMMTools.');
      const filePath=await s.download.path();
      if(!filePath)throw new Error('AIVID download has not finished yet.');
      const stat=await fs.stat(filePath);
      if(stat.size<12||stat.size>MAX_VIDEO)throw new Error('Only finished MP4 video files up to 100 MiB are supported.');
      const data=await fs.readFile(filePath);
      if(data.toString('ascii',4,8)!=='ftyp')throw new Error('Provider download is not a valid MP4 file.');
      s.download=null;
      return {state:'download',data};
    }else if(!['open','frame'].includes(action))throw new Error('Unsupported browser operation.');
    let jpeg=await page.screenshot({type:'jpeg',quality:48,timeout:15000});
    if(jpeg.length>MAX_FRAME)jpeg=await page.screenshot({type:'jpeg',quality:24,timeout:15000});
    if(jpeg.length>MAX_FRAME)throw new Error('The browser preview is too large.');
    return {state:'frame',jpeg:jpeg.toString('base64'),url:allowedUrl(page.url(),true)?page.url().slice(0,290):'',
      notice:s.notice.slice(0,290),fileName:s.download?safeName(s.download.suggestedFilename()):'',
      uploadPending:Boolean(s.chooser),downloadReady:Boolean(s.download)};
  }
}
module.exports={WindowsLive,allowedUrl,safeName,TTL,MAX_FRAME};
