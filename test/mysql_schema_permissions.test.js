'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {ensureSettingsTable}=require('../src/settings.js');
const {ensureSchemaTable}=require('../src/db.js');

const missing=()=>Object.assign(new Error("Table 'app_settings' doesn't exist"),{code:'ER_NO_SUCH_TABLE'});
const createDenied=()=>Object.assign(new Error('CREATE command denied to user'),{code:'ER_TABLEACCESS_DENIED_ERROR'});
const selectDenied=()=>Object.assign(new Error('SELECT command denied to user'),{code:'ER_TABLEACCESS_DENIED_ERROR'});
const statement='CREATE TABLE IF NOT EXISTS users (id BIGINT PRIMARY KEY)';

test('existing settings table works without CREATE privilege and is probed only once',async()=>{
  const statements=[];
  const db={query:async sql=>{
    statements.push(sql);
    if(sql.startsWith('CREATE'))throw createDenied();
    return [[{setting_key:'api888_api_key',setting_value:'encrypted-placeholder',is_secret:1}]];
  }};
  await ensureSettingsTable(db);
  await ensureSettingsTable(db);
  assert.deepEqual(statements,[
    'SELECT setting_key, setting_value, is_secret FROM app_settings LIMIT 0'
  ]);
});

test('a genuinely missing settings table is created and verified if privileges allow',async()=>{
  const statements=[];
  let exists=false;
  const db={query:async sql=>{
    statements.push(sql);
    if(sql.startsWith('SELECT')&&!exists)throw missing();
    if(sql.startsWith('CREATE')){exists=true;return [{warningStatus:0}]}
    return [[]];
  }};
  await ensureSettingsTable(db);
  assert.equal(statements.filter(sql=>sql.startsWith('CREATE')).length,1);
  assert.equal(statements.filter(sql=>sql.startsWith('SELECT')).length,2);
  await ensureSettingsTable(db);
  assert.equal(statements.length,3);
});

test('a missing settings table with denied CREATE gives actionable error and allows a later retry',async()=>{
  let allowCreate=false,exists=false,creations=0;
  const db={query:async sql=>{
    if(sql.startsWith('SELECT')&&!exists)throw missing();
    if(sql.startsWith('CREATE')){creations++;if(!allowCreate)throw createDenied();exists=true;}
    return [[]];
  }};
  await assert.rejects(ensureSettingsTable(db),err=>{
    assert.equal(err.code,'APP_SETTINGS_CREATE_PERMISSION_REQUIRED');
    assert.match(err.message,/app_settings is missing/);
    assert.match(err.message,/Hostinger/);
    return true;
  });
  allowCreate=true;
  await ensureSettingsTable(db);
  assert.equal(creations,2);
});

test('settings SELECT permission denial is not hidden or replaced by a CREATE attempt',async()=>{
  let creates=0;
  const db={query:async sql=>{
    if(sql.startsWith('CREATE'))creates++;
    throw selectDenied();
  }};
  await assert.rejects(ensureSettingsTable(db),{code:'ER_TABLEACCESS_DENIED_ERROR'});
  assert.equal(creates,0);
});

test('existing core schema tables are probed without trying CREATE',async()=>{
  const statements=[];
  const db={query:async sql=>{
    statements.push(sql);
    if(sql.startsWith('CREATE'))throw createDenied();
    return [[]];
  }};
  assert.equal(await ensureSchemaTable(db,statement),false);
  assert.deepEqual(statements,['SELECT 1 FROM users LIMIT 0']);
});

test('missing core schema tables still attempt CREATE and verify',async()=>{
  let exists=false,statements=[];
  const db={query:async sql=>{
    statements.push(sql);
    if(sql.startsWith('SELECT')&&!exists)throw missing();
    if(sql.startsWith('CREATE'))exists=true;
    return [[]];
  }};
  assert.equal(await ensureSchemaTable(db,statement),true);
  assert.equal(statements.length,3);
  assert.equal(statements[1],statement);
});

test('missing core table reports required CREATE privileges clearly',async()=>{
  const db={query:async sql=>{
    if(sql.startsWith('CREATE'))throw createDenied();
    throw missing();
  }};
  await assert.rejects(ensureSchemaTable(db,statement),err=>{
    assert.equal(err.code,'SCHEMA_CREATE_PERMISSION_REQUIRED');
    assert.match(err.message,/Required MySQL table users does not exist/);
    return true;
  });
});

test('unsafe arbitrary SQL is not accepted by core schema setup',async()=>{
  let queries=0;
  const db={query:async()=>{queries++}};
  await assert.rejects(ensureSchemaTable(db,'DROP TABLE users'),/Unexpected database schema statement/);
  assert.equal(queries,0);
});
