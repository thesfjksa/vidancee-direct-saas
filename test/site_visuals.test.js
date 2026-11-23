'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {once}=require('node:events');

const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');
const pages=['landing.html','pricing.html','compare.html','index.html','developers.html','developer-docs.html','admin.html'];
const artNames=['video','image','cartoon','voice','upscale','video-tools','library','developer','credits'];
const sprite=read('public/assets/site-art/glyphs.svg');

test('site-wide pictorial system uses small local SVG illustrations and accessible glyphs',()=>{
 for(const name of artNames){
  const file='public/assets/site-art/'+name+'.svg';
  const svg=read(file);
  assert.match(svg,/<svg\b[^>]*viewBox="0 0 256 224"/,'missing SVG viewport: '+name);
  assert.match(svg,/<linearGradient/,'illustration lacks a custom layered design: '+name);
  assert.match(svg,/<g filter="url\(#shadow\)"/,'illustration lacks depth: '+name);
  assert.doesNotMatch(svg,/<script|<foreignObject|xlink:href|https?:\/\//i,'unsafe external SVG content: '+name);
  assert.ok(fs.statSync(path.join(root,file)).size<8000,'oversized icon '+name);
 }
 assert.match(sprite,/<symbol id="speech"/);
 for(const name of ['overview','users','generations','plans','credits','storage','provider','activity','history','video','image','library','security','refresh','cloning']){
  assert.ok(sprite.includes('<symbol id="'+name+'"'),'missing glyph '+name);
 }
 assert.doesNotMatch(sprite,/<script|<foreignObject|https?:\/\//i);
 assert.ok(fs.statSync(path.join(root,'public/assets/site-art/glyphs.svg')).size<14000);
});

test('all primary pages load the same responsive pictorial design and reference existing assets',()=>{
 const css=read('public/site-visuals.css');
 assert.match(css,/@media\(max-width:680px\)/);
 assert.match(css,/@media\(max-width:740px\)/);
 assert.match(css,/prefers-reduced-motion:reduce/);
 for(const filename of pages){
  const html=read('public/'+filename);
  assert.ok(html.includes('/site-visuals.css?v=20261123-visuals1'),'missing stylesheet from '+filename);
  const assetRefs=[...html.matchAll(/\/assets\/site-art\/([\w-]+)\.svg/g)];
  assert.ok(assetRefs.length>0,'no illustrations or custom icons in '+filename);
  for(const [,name] of assetRefs){
   assert.ok(name==='glyphs'||artNames.includes(name),'missing art '+name+' in '+filename);
   assert.ok(fs.existsSync(path.join(root,'public/assets/site-art',name+'.svg')));
  }
  const glyphRefs=[...html.matchAll(/\/assets\/site-art\/glyphs\.svg#([\w-]+)/g)];
  for(const [,name] of glyphRefs)assert.ok(sprite.includes('<symbol id="'+name+'"'),'undefined glyph '+name+' in '+filename);
 }
});

test('creative studios, marketing cards, developer pages, and admin navigation retain their actions',()=>{
 const app=read('public/index.html');
 for(const title of ['Create video','Create image','Create cartoon','Upscale video'])assert.match(app,new RegExp('<strong>'+title+'</strong>[\\s\\S]{0,250}cmm-creator-art'));
 for(const name of ['speech','dialogue','voice-changer','dubbing','cloning']){
  assert.ok(app.includes('data-voice-tool="'+name+'"'));
  assert.ok(app.includes("setVoiceTool('"+name+"')"));
 }
 assert.match(app,/id="voicePickerDialog"/);
 assert.match(app,/id="videoToolForm"/);
 for(const id of ['voices','library','plans','credits','claude','account'])assert.ok(app.includes('id="'+id+'"'));
 const landing=read('public/landing.html');
 for(const cls of ['t-video','t-image','t-cartoon','t-voice','t-upscale','t-enhance','t-claude']){
  const start=landing.indexOf('<article class="tile '+cls);
  assert.ok(start>=0,'missing tile '+cls);
  assert.ok(landing.slice(start,start+470).includes('cmm-tile-art'),'missing pictorial tile '+cls);
 }
 for(const file of ['pricing.html','compare.html'])assert.match(read('public/'+file),/class="cmm-marketing-hero cmm-visual"/);
 assert.match(read('public/developers.html'),/class="cmm-dev-art cmm-visual"/);
 assert.match(read('public/developer-docs.html'),/class="cmm-doc-art cmm-visual"/);
 const admin=read('public/admin.html');
 for(const name of ['overview','users','generations','plans','credits','storage','provider','activity','aividHistory','longAiVideoTests']){
  const re=new RegExp('data-tab="'+name+'"[^>]*>[\\s\\S]{0,150}glyphs\\.svg#');
  assert.match(admin,re,'admin menu missing icon: '+name);
 }
});

test('HTTP routes serve site SVGs and CSS with their correct MIME types',async t=>{
 process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.WORKER_ENABLED='false';delete process.env.CANONICAL_URL;
 const db=require('../src/db.js');db.dbConfigured=()=>false;
 const server=require('../server.js');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 if(!server.listening)await once(server,'listening');
 const get=uri=>new Promise((resolve,reject)=>{
  http.get({host:'127.0.0.1',port:server.address().port,path:uri,headers:{host:'cmmtools.site'}},res=>{
   const body=[];res.on('data',c=>body.push(c));res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],body:Buffer.concat(body)}));
  }).on('error',reject);
 });
 for(const name of [...artNames,'glyphs']){
  const r=await get('/assets/site-art/'+name+'.svg');
  assert.equal(r.status,200,'asset missing: '+name);
  assert.match(r.type,/image\/svg\+xml/,'wrong mime for '+name);
  assert.ok(r.body.toString('utf8').startsWith('<svg'),'not an SVG '+name);
 }
 const css=await get('/site-visuals.css?v=20261123-visuals1');
 assert.equal(css.status,200);assert.match(css.type,/text\/css/);
 assert.match(css.body.toString(),/cmm-marketing-hero/);
});