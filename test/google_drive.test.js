'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {GoogleDriveStore,driveIdFromMarker,CHUNK}=require('../src/google_drive.js');
const {migrateOneVideo,readStoredRange}=require('../src/google_drive_migration.js');

const ID='c2ebddd1-ab9b-4d25-805e-3f8d2c9c9627';
const FOLDER='folder_GOOGLE_DRIVE_1234',FILE='video_GOOGLE_DRIVE_1234';
function fakeGoogle(){
  const data=Buffer.concat([Buffer.alloc(CHUNK,42),Buffer.from('Last chunk')]);
  const checksum=crypto.createHash('md5').update(data).digest('hex');
  const calls=[];
  const f=async (url,opts={})=>{
    calls.push({url,method:opts.method||'GET',headers:opts.headers,body:opts.body});
    if(url==='https://oauth2.googleapis.com/token')
      return new Response(JSON.stringify({access_token:'google_mock_token',expires_in:3600}),{status:200});
    if(url.startsWith('https://www.googleapis.com/drive/v3/files?')){
      assert.match(url,/pageSize=100/);
      return new Response(JSON.stringify({files:[]}),{status:200});
    }
    if(url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')){
      assert.equal(opts.method,'POST');
      const info=JSON.parse(opts.body);
      assert.equal(info.name,'cmm-video-'+ID+'.mp4');
      assert.deepEqual(info.parents,[FOLDER]);
      return new Response(null,{status:200,
        headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=TEST'}});
    }
    if(url==='https://www.googleapis.com/upload/drive/v3/files?upload_id=TEST'){
      const h=opts.headers;
      if(h['content-range']==='bytes 0-'+(CHUNK-1)+'/'+data.length)
        return new Response(null,{status:308,headers:{range:'bytes=0-'+(CHUNK-1)}});
      assert.equal(h['content-range'],'bytes '+CHUNK+'-'+(data.length-1)+'/'+data.length);
      assert.equal(opts.body.toString(),data.subarray(CHUNK).toString());
      return new Response(JSON.stringify({id:FILE,size:String(data.length)}),{status:200});
    }
    if(url==='https://www.googleapis.com/drive/v3/files/'+FILE+'?fields=id,size,md5Checksum,mimeType,parents,trashed,appProperties')
      return new Response(JSON.stringify({id:FILE,size:String(data.length),mimeType:'video/mp4',
        md5Checksum:checksum,parents:[FOLDER]}),{status:200});
    throw Error('Unexpected Google API URL '+url);
  };
  return {f,data,checksum,calls};
}
test('Google Drive saves video in private folder with resumable 4 MiB chunks and confirms MD5',async()=>{
 const fake=fakeGoogle();
 const drive=new GoogleDriveStore({clientId:'client_test_1',clientSecret:'secret',refreshToken:'refresh_unique_1',
   folderId:FOLDER,fetchImpl:fake.f});
 const fileId=await drive.uploadBuffer(ID,fake.data);
 assert.equal(fileId,FILE);
 assert.equal(fake.calls.filter(c=>c.method==='POST'&&c.url.includes('/upload/drive/')).length,1);
 assert.equal(fake.calls.filter(c=>c.method==='PUT').length,2);
});
test('Google Drive video markers accept only valid provider file IDs',()=>{
 assert.equal(driveIdFromMarker('gdrive:'+FILE),FILE);
 assert.equal(driveIdFromMarker('db:video'),null);
 assert.equal(driveIdFromMarker('gdrive:http://local/'),null);
});

function migrationDB(blob){
 const calls=[],id=ID,byteLength=blob.length;
 let marker='db:video';
 const conns=[];
 const db={
  query:async(sql)=>{
   calls.push(sql);
   if(sql.includes('JOIN generation_video_outputs'))return [[{id,byte_length:byteLength}]];
   throw Error('Unexpected pool query '+sql);
  },
  execute:async(sql,args)=>{
   calls.push(sql);
   if(sql.startsWith('SELECT chunk_index,video_data')){
     const first=args[1],last=args[2];
     const rows=[];
     for(let i=first;i<=last;i++){
       const chunk=blob.subarray(i*1024*1024,(i+1)*1024*1024);
       if(chunk.length)rows.push({chunk_index:i,video_data:chunk});
     }
     return [rows];
   }
   throw Error('Unexpected pool execute '+sql);
  },
  getConnection:async()=>{
   const index=conns.length;conns.push(index);
   if(index===0)return {query:async(sql)=>sql.includes('GET_LOCK')?[[{acquired:1}]]:[[{released:1}]],release:()=>{}};
   return {beginTransaction:async()=>{},execute:async(sql,args)=>{
       calls.push(sql);
       if(sql.includes('FOR UPDATE'))return [[{output_url:marker}]];
       if(sql.startsWith('UPDATE generations')){marker=args[0];return [{affectedRows:1}]}
       if(sql.startsWith('DELETE'))return [{affectedRows:1}];
       throw Error('Unexpected transaction query '+sql);
     },commit:async()=>calls.push('COMMIT'),rollback:async()=>calls.push('ROLLBACK'),release:()=>{}};
  },
 };
 return {db,calls,getMarker:()=>marker};
}
test('migration verifies Google file before transactional MySQL chunk deletion',async()=>{
 const blob=Buffer.concat([Buffer.alloc(1024*1024,77),Buffer.from('tail')]);
 const md5=crypto.createHash('md5').update(blob).digest('hex');
 const fixture=migrationDB(blob);
 const events=[];
 const drive={
   uploadVideo:async({generationId,size,md5Checksum,readChunk})=>{
     assert.equal(generationId,ID);assert.equal(size,blob.length);
     assert.equal(md5Checksum,md5);
     assert.deepEqual(await readChunk(0,blob.length),blob);
     return FILE;
   },
   metadata:async()=>({id:FILE,size:String(blob.length),md5Checksum:md5,mimeType:'video/mp4'})
 };
 const result=await migrateOneVideo({db:fixture.db,drive,log:e=>events.push(e)});
 assert.equal(result.migrated,true);
 assert.equal(fixture.getMarker(),'gdrive:'+FILE);
 const update=fixture.calls.findIndex(x=>x.startsWith('UPDATE generations'));
 const deletion=fixture.calls.findIndex(x=>x.startsWith('DELETE FROM generation_video_chunks'));
 assert.ok(update>=0&&deletion>update);
 assert.ok(fixture.calls.includes('COMMIT'));
 assert.equal(events[0].event,'gdrive.video_migrated');
});
test('Google checksum mismatch leaves all MySQL video chunks intact',async()=>{
 const blob=Buffer.alloc(1024*1024,19),fixture=migrationDB(blob);
 const drive={uploadVideo:async()=>FILE,metadata:async()=>({size:String(blob.length),
   md5Checksum:'wrong',mimeType:'video/mp4'})};
 await assert.rejects(migrateOneVideo({db:fixture.db,drive,log:()=>{}}),/integrity check failed/i);
 assert.equal(fixture.getMarker(),'db:video');
 assert.ok(!fixture.calls.some(sql=>sql.startsWith('DELETE')));
});
test('bad or missing MySQL chunks abort migration before any Drive upload',async()=>{
 let called=false;
 const db={execute:async()=>[[]]};
 await assert.rejects(readStoredRange(db,ID,1024*1024,0,1024*1024),/missing data chunks/i);
 assert.equal(called,false);
});
