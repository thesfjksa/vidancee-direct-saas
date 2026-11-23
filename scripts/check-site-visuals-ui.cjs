'use strict';
const assert=require('node:assert/strict');
const {existsSync,readFileSync,mkdirSync}=require('node:fs');
const {join,extname}=require('node:path');
const {chromium}=require('playwright-core');

const origin='https://cmmtools.test';
const pages=[
 ['landing','/','landing.html'],
 ['pricing','/pricing','pricing.html'],
 ['compare','/compare','compare.html'],
 ['developers','/developers','developers.html'],
 ['api-docs','/developers/docs','developer-docs.html'],
 ['admin','/admin-console','admin.html']
];
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8',
 '.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2'};
const root=join(process.cwd(),'public');
const out=join(process.cwd(),'artifacts','site-visuals');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  mkdirSync(out,{recursive:true});
  const tab=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const broken=[];
  await tab.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin)return route.abort();
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{ok:true,items:[],plans:[],generations:[],user:null,stats:{},pricing:[]}});
   const mapping=pages.find(([,uri])=>uri===url.pathname);
   const file=mapping?join(root,mapping[2]):join(root,url.pathname.replace(/^\//,''));
   if(!existsSync(file))return route.fulfill({status:404,body:'Not found'});
   return route.fulfill({status:200,contentType:mime[extname(file)]||'application/octet-stream',body:readFileSync(file)});
  });
  tab.on('response',response=>{if(response.url().includes('/assets/site-art/')&&response.status()!==200)broken.push(response.url()+' '+response.status())});
  for(const [name,uri] of pages){
   for(const [mode,width,height] of [['desktop',1440,900],['mobile',390,844]]){
    await tab.setViewportSize({width,height});
    await tab.goto(origin+uri,{waitUntil:'domcontentloaded'});
    await tab.evaluate(()=>document.fonts.ready);
    const visuals=await tab.locator('img[src^="/assets/site-art/"]').evaluateAll(async imgs=>{
     for(const img of imgs){
      img.loading='eager';
      try{await img.decode()}catch{}
     }
     return imgs.map(img=>({src:img.getAttribute('src'),ok:img.complete&&img.naturalWidth>0}));
    });
    assert(visuals.length>0,name+' has no pictorial illustrations');
    assert(visuals.every(img=>img.ok),name+' has a broken visual: '+JSON.stringify(visuals.filter(img=>!img.ok)));
    const doc=await tab.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:window.innerWidth}));
    assert(doc.scroll<=doc.width+3,name+' '+mode+' horizontal overflow '+JSON.stringify(doc));
    await tab.screenshot({path:join(out,name+'-'+mode+'.png'),fullPage:false,animations:'disabled'});
   }
  }
  assert.deepEqual(broken,[]);
  console.log('Site-wide CMMTools illustrations: six pages × desktop/mobile rendered with no broken images or horizontal overflow.');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
