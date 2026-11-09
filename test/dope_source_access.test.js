'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {customerProviderAccess}=require('../src/dope_brand.js');

const server=fs.readFileSync(require.resolve('../server.js'),'utf8');
function excerpt(first,last){
  const start=server.indexOf(first),end=server.indexOf(last,start);
  assert.ok(start>=0&&end>start,first+' must exist before '+last);
  return server.slice(start,end);
}
const defaults=excerpt('const CUSTOMER_PROVIDER_KEYS=', '// Voice Studio used');
const migration=excerpt("// Owner request (9 Nov 2026): Dope models", 'async function getUserProviderAccess(');
const getter=excerpt('async function getUserProviderAccess(', 'async function setUserProviderAccess(');
const setter=excerpt('async function setUserProviderAccess(', '// Video, image and upscaler models a customer can use');

test('Dope appears enabled in Sources for new and existing users without an old override',async()=>{
  const ctx=vm.createContext({dbConfigured:()=>true,
    getPool:()=>({execute:async()=>[[]]})});
  vm.runInContext(defaults+getter,ctx);
  const access=await ctx.getUserProviderAccess(42);
  assert.equal(access.wxksai,true);
  assert.equal(customerProviderAccess(access).dope,true);
  assert.equal(access.api888,true);
  assert.equal(access.higgsfield,true);
  assert.equal(ctx.defaultCustomerProviderAccess().wxksai,true);
});

test('Dope old off rows are reset once; future Admin opt-outs still work',async()=>{
  const rows=new Map([
    ['42:wxksai',false],['43:wxksai',false],
    ['42:longai',false],['43:api888',false]
  ]);
  let marker='',writes=0;
  const db={execute:async(sql,params=[])=>{
    if(sql.startsWith('DELETE FROM user_provider_access')){
      assert.match(sql,/provider='wxksai' AND enabled=0/);
      let removed=0;
      for(const [key,enabled] of [...rows]){
        if(key.endsWith(':wxksai')&&enabled===false){rows.delete(key);removed++;}
      }
      return [{affectedRows:removed}];
    }
    if(sql.startsWith('SELECT provider,enabled')){
      const id=Number(params[0]);
      return [[...rows].filter(([key])=>key.startsWith(id+':')).map(([key,enabled])=>({
        provider:key.split(':')[1],enabled:enabled?1:0
      }))];
    }
    if(sql.startsWith('SELECT id FROM users'))return [[{id:params[0]}]];
    if(sql.startsWith('INSERT INTO user_provider_access')){
      rows.set(String(params[0])+':'+params[1],Boolean(params[2]));
      return [{affectedRows:1}];
    }
    throw Error('Unexpected SQL: '+sql);
  }};
  const logged=[];
  const ctx=vm.createContext({dbConfigured:()=>true,getPool:()=>db,
    getSettingValue:async()=>marker,
    setSettingValue:async(_key,value)=>{writes++;marker=value;},
    logActivity:event=>logged.push(event)});
  vm.runInContext(defaults+migration+getter+setter,ctx);
  assert.equal((await ctx.getUserProviderAccess(42)).wxksai,false);
  assert.equal(await ctx.enableDopeForCustomersOnce(),2);
  assert.equal((await ctx.getUserProviderAccess(42)).wxksai,true);
  assert.equal((await ctx.getUserProviderAccess(43)).wxksai,true);
  assert.equal((await ctx.getUserProviderAccess(42)).longai,false);
  assert.equal((await ctx.getUserProviderAccess(43)).api888,false);
  assert.equal(writes,1);
  assert.equal(logged[0].event,'dope_access.all_on');
  const result=await ctx.setUserProviderAccess(42,{wxksai:false});
  assert.equal(result.wxksai,false,'Admin can switch Dope off after one-time reset');
  assert.equal(await ctx.enableDopeForCustomersOnce(),0);
  assert.equal((await ctx.getUserProviderAccess(42)).wxksai,false);
  assert.equal((await ctx.getUserProviderAccess(43)).wxksai,true);
  assert.equal(writes,1);
});

test('Dope all-users grant runs during boot, while global and model gates remain',()=>{
  assert.match(server,/await enableDopeForCustomersOnce\(\)\.catch\(/);
  assert.match(server,/if\(access\.wxksai && providerSettings\.wxksai\.active\)/);
  assert.match(server,/video\.push\(\.\.\.catalog\.video\.filter\(model=>isWxksaiModel\(model\.id\)\)\)/);
  const models=fs.readFileSync(require.resolve('../src/provider_models.js'),'utf8');
  assert.match(models,/listProviderModels\(provider, \{ enabledOnly: true, availableOnly: true \}\)/);
  assert.match(models,/\.filter\(model=>!isPricedSource\(provider\)\|\|model\.ready\)/);
});
