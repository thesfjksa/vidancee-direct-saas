const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const { VidanceeClient } = require('./src/provider/vidancee.js');
const { dbConfigured, getPool, initDb, dbHealth } = require('./src/db.js');
const {
  normalizeEmail, validateEmail, hashPassword, verifyPassword,
  createSession, destroySession, userFromRequest, requireUser,
} = require('./src/auth.js');
const { publicPricing, ASPECT_RATIOS } = require('./src/pricing.js');
const {
  createGenerationForUser, listUserGenerations, getUserGeneration, serializeGeneration,
} = require('./src/generations.js');
const { GenerationWorker } = require('./src/worker_admin_settings.js');
const {
  getProviderSettings,
  getAdminProviderSettings,
  updateProviderSettings,
  migrateLegacyProviderEnvSettings,
} = require('./src/settings.js');
const { verifyAssetSignature } = require('./src/provider/assets.js');

const customerPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const allowSignups = !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_SIGNUPS || 'yes'));
const startingCredits = Math.max(0, Number(process.env.STARTING_CREDITS || 0));

if (!adminToken) console.warn('ADMIN_TOKEN is not configured. Admin routes will be unavailable.');

async function providerClient() {
  const settings = await getProviderSettings();
  if (!settings.vidanceeEmail || !settings.vidanceePassword) {
    const error = new Error('Primary provider credentials are not configured in the Admin dashboard.');
    error.statusCode = 503;
    throw error;
  }
  return new VidanceeClient({
    baseUrl: settings.vidanceeBaseUrl,
    email: settings.vidanceeEmail,
    password: settings.vidanceePassword,
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'",
  });
  res.end(body);
}
function safeError(error) {
  return { ok:false, error:error instanceof Error ? error.message : String(error) };
}
async function readJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256*1024) {
      const error=new Error('Request body too large.'); error.statusCode=413; throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error=new Error('Invalid JSON body.'); error.statusCode=400; throw error; }
}

function readGenerationRequest(req) {
  const contentType=String(req.headers['content-type']||'');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return readJson(req);

  return new Promise((resolve,reject)=>{
    const fields={};
    const images=[];
    let totalBytes=0;
    let settled=false;

    function fail(message,statusCode=400){
      if(settled)return;
      settled=true;
      const error=new Error(message); error.statusCode=statusCode; reject(error);
    }

    let bb;
    try {
      bb=Busboy({
        headers:req.headers,
        limits:{files:6,fileSize:10*1024*1024,fields:20,parts:30},
      });
    } catch(error) {
      error.statusCode=400; return reject(error);
    }

    bb.on('field',(name,value)=>{fields[name]=value;});
    bb.on('file',(name,file,info)=>{
      if(name!=='images' && name!=='images[]'){ file.resume(); return; }
      const mimeType=String(info.mimeType||'').toLowerCase();
      if(!['image/jpeg','image/png','image/webp'].includes(mimeType)){
        file.resume(); return fail('Images must be JPEG, PNG, or WebP.');
      }
      const chunks=[]; let bytes=0;
      file.on('data',(chunk)=>{
        bytes+=chunk.length; totalBytes+=chunk.length;
        if(totalBytes>30*1024*1024) fail('Combined image upload is too large.',413);
        if(!settled) chunks.push(chunk);
      });
      file.on('limit',()=>fail('Each image must be 10 MB or smaller.',413));
      file.on('end',()=>{
        if(!settled && bytes>0){
          images.push({
            filename:String(info.filename||'reference-image').slice(0,255),
            mimeType,
            data:Buffer.concat(chunks),
          });
        }
      });
    });
    bb.on('filesLimit',()=>fail('A maximum of 6 images is allowed.'));
    bb.on('error',(error)=>{if(!settled){settled=true;reject(error);}});
    bb.on('close',()=>{
      if(settled)return;
      settled=true;
      fields.images=images;
      resolve(fields);
    });
    req.pipe(bb);
  });
}
function adminAuthorized(req) {
  const supplied=String(req.headers['x-admin-token']||'');
  if (!supplied || !adminToken || supplied.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken));
}
function userPayload(user) {
  return {
    id:Number(user.id), email:user.email, credits:Number(user.credits),
    role:user.role, status:user.status, created_at:user.created_at,
    updated_at:user.updated_at || null,
  };
}
function requireDatabase() {
  if (!dbConfigured()) {
    const error=new Error('MySQL is not configured yet.'); error.statusCode=503; throw error;
  }
}
async function proxyMedia(req,res,row,type) {
  const target = type === 'poster' ? row.poster_url : row.output_url;
  if (!target) return sendJson(res,404,{ok:false,error:'Media not available.'});

  const headers={};
  if (req.headers.range) headers.range=req.headers.range;
  const upstream=await fetch(target,{headers,redirect:'follow'});
  if (!upstream.ok && upstream.status !== 206) {
    return sendJson(res,502,{ok:false,error:'Provider media fetch failed.'});
  }

  const pass=['content-type','content-length','content-range','accept-ranges','etag','last-modified'];
  for (const name of pass) {
    const value=upstream.headers.get(name);
    if (value) res.setHeader(name,value);
  }
  res.setHeader('cache-control','private, max-age=3600');
  res.statusCode=upstream.status;
  if (!upstream.body) return res.end();
  const { Readable } = require('node:stream');
  Readable.fromWeb(upstream.body).pipe(res);
}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url||'/', 'http://' + (req.headers.host||'localhost'));
  const routePath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  try {
    if (req.method==='GET' && routePath==='/') return sendHtml(res,200,customerPage);
    if (req.method==='GET' && routePath==='/admin-console') return sendHtml(res,200,adminPage);

    const providerAssetMatch=routePath.match(/^\/provider-assets\/([0-9a-f-]{36})\/(\d+)$/i);
    if (req.method==='GET' && providerAssetMatch) {
      requireDatabase();
      const generationId=providerAssetMatch[1];
      const position=Number(providerAssetMatch[2]);
      const signature=String(url.searchParams.get('sig')||'');
      if (!verifyAssetSignature(generationId,position,signature)) {
        return sendJson(res,403,{ok:false,error:'Invalid provider asset signature.'});
      }
      const db=getPool();
      const [rows]=await db.execute(
        'SELECT filename,mime_type,image_data FROM generation_images WHERE generation_id=? AND position_index=? LIMIT 1',
        [generationId,position]
      );
      const image=rows[0];
      if (!image) return sendJson(res,404,{ok:false,error:'Provider asset not found.'});
      res.statusCode=200;
      res.setHeader('content-type',image.mime_type);
      res.setHeader('content-length',image.image_data.length);
      res.setHeader('cache-control','private, max-age=300');
      res.setHeader('x-content-type-options','nosniff');
      return res.end(image.image_data);
    }

    if (req.method==='GET' && routePath==='/health') {
      const database=await dbHealth();
      let generationBackendReady=false;
      let generationEnabled=false;
      if (database.connected) {
        const providerSettings=await getAdminProviderSettings();
        generationBackendReady=Boolean(providerSettings.vidancee.configured || providerSettings.createpulse.configured);
        generationEnabled=Boolean(providerSettings.allowProviderCharges);
      }
      return sendJson(res,200,{
        ok:true,
        app:'mehroz-ai',
        milestone:4,
        node:process.version,
        database,
        services:{
          generationBackendReady,
          workerEnabled:/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED||'true')),
          generationEnabled,
        },
        config:{
          adminTokenConfigured:Boolean(adminToken),
          signupsEnabled:allowSignups,
        }
      });
    }

    if (req.method==='GET' && routePath==='/api/config') {
      return sendJson(res,200,{
        ok:true, signupsEnabled:allowSignups, pricing:publicPricing(), aspectRatios:ASPECT_RATIOS,
      });
    }

    if (req.method==='POST' && routePath==='/api/auth/register') {
      requireDatabase();
      if (!allowSignups) return sendJson(res,403,{ok:false,error:'Signups are disabled.'});
      const body=await readJson(req);
      const email=normalizeEmail(body.email);
      if (!validateEmail(email)) return sendJson(res,400,{ok:false,error:'Enter a valid email address.'});
      const passwordHash=await hashPassword(body.password);
      const db=getPool();
      try {
        const [result]=await db.execute(
          'INSERT INTO users (email,password_hash,credits) VALUES (?,?,?)',
          [email,passwordHash,startingCredits],
        );
        await createSession(res,result.insertId);
        const [rows]=await db.execute('SELECT * FROM users WHERE id=?',[result.insertId]);
        return sendJson(res,201,{ok:true,user:userPayload(rows[0])});
      } catch(error) {
        if (error && error.code==='ER_DUP_ENTRY') return sendJson(res,409,{ok:false,error:'An account with this email already exists.'});
        throw error;
      }
    }

    if (req.method==='POST' && routePath==='/api/auth/login') {
      requireDatabase();
      const body=await readJson(req);
      const email=normalizeEmail(body.email);
      const db=getPool();
      const [rows]=await db.execute('SELECT * FROM users WHERE email=? LIMIT 1',[email]);
      const user=rows[0];
      if (!user || user.status!=='active' || !(await verifyPassword(body.password,user.password_hash))) {
        return sendJson(res,401,{ok:false,error:'Invalid email or password.'});
      }
      await createSession(res,user.id);
      return sendJson(res,200,{ok:true,user:userPayload(user)});
    }

    if (req.method==='POST' && routePath==='/api/auth/logout') {
      requireDatabase();
      await destroySession(req,res);
      return sendJson(res,200,{ok:true});
    }

    if (req.method==='GET' && routePath==='/api/me') {
      requireDatabase();
      const user=await userFromRequest(req);
      if (!user) return sendJson(res,401,{ok:false,error:'Not signed in.'});
      return sendJson(res,200,{ok:true,user:userPayload(user)});
    }

    if (req.method==='GET' && routePath==='/api/dashboard') {
      requireDatabase();
      const user=await requireUser(req);
      const db=getPool();
      const [statusRows]=await db.execute(
        `SELECT status, COUNT(*) AS total FROM generations WHERE user_id=? GROUP BY status`,
        [user.id],
      );
      const generationCounts={};
      for (const row of statusRows) generationCounts[row.status]=Number(row.total);
      const [creditRows]=await db.execute(
        `SELECT id, generation_id, amount, type, note, created_at
         FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 8`,
        [user.id],
      );
      return sendJson(res,200,{
        ok:true,
        user:userPayload(user),
        stats:{
          total:Object.values(generationCounts).reduce((sum,value)=>sum+Number(value||0),0),
          completed:Number(generationCounts.completed||0),
          active:Number(generationCounts.queued||0)+Number(generationCounts.submitting||0)+Number(generationCounts.submitted||0)+Number(generationCounts.processing||0),
          failed:Number(generationCounts.failed||0)+Number(generationCounts.submit_error||0),
        },
        recentCredits:creditRows,
      });
    }

    if (req.method==='GET' && routePath==='/api/credits') {
      requireDatabase();
      const user=await requireUser(req);
      const db=getPool();
      const [rows]=await db.execute(
        `SELECT id, generation_id, amount, type, note, created_at
         FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100`,
        [user.id],
      );
      return sendJson(res,200,{ok:true,credits:Number(user.credits),transactions:rows});
    }

    if (req.method==='POST' && routePath==='/api/account/password') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readJson(req);
      const current=String(body.currentPassword||'');
      const next=String(body.newPassword||'');
      if (next.length<8) return sendJson(res,400,{ok:false,error:'New password must be at least 8 characters.'});
      const db=getPool();
      const [rows]=await db.execute('SELECT password_hash FROM users WHERE id=? LIMIT 1',[user.id]);
      if (!rows[0] || !(await verifyPassword(current,rows[0].password_hash))) {
        return sendJson(res,401,{ok:false,error:'Current password is incorrect.'});
      }
      const nextHash=await hashPassword(next);
      await db.execute('UPDATE users SET password_hash=?, updated_at=UTC_TIMESTAMP() WHERE id=?',[nextHash,user.id]);
      await db.execute('DELETE FROM sessions WHERE user_id=?',[user.id]);
      await createSession(res,user.id);
      return sendJson(res,200,{ok:true});
    }

    if (req.method==='GET' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,generations:await listUserGenerations(user.id,50)});
    }

    if (req.method==='POST' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readGenerationRequest(req);
      const generation=await createGenerationForUser(user.id,body);
      const db=getPool();
      const [users]=await db.execute('SELECT * FROM users WHERE id=?',[user.id]);
      return sendJson(res,201,{ok:true,generation,user:userPayload(users[0])});
    }

    const genMatch=routePath.match(/^\/api\/generations\/([0-9a-f-]{36})$/i);
    if (req.method==='GET' && genMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserGeneration(user.id,genMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Generation not found.'});
      return sendJson(res,200,{ok:true,generation:serializeGeneration(row)});
    }

    const mediaMatch=routePath.match(/^\/api\/generations\/([0-9a-f-]{36})\/media$/i);
    if (req.method==='GET' && mediaMatch) {
      requireDatabase();
      const user=await requireUser(req);
      const row=await getUserGeneration(user.id,mediaMatch[1]);
      if (!row) return sendJson(res,404,{ok:false,error:'Generation not found.'});
      const type=url.searchParams.get('type')==='poster'?'poster':'video';
      return proxyMedia(req,res,row,type);
    }

    if (routePath.startsWith('/admin/')) {
      if (!adminToken) return sendJson(res,503,{ok:false,error:'ADMIN_TOKEN is not configured in hPanel.'});
      if (!adminAuthorized(req)) return sendJson(res,401,{ok:false,error:'Unauthorized'});

      if (req.method==='POST' && routePath==='/admin/provider/check') {
        const provider=await providerClient();
        await provider.login();
        const snapshot=await provider.getJobs(12);
        return sendJson(res,200,{ok:true,login:'OK',provider:{
          credits:snapshot.credits,reserved:snapshot.reserved,concurrency:snapshot.concurrency,
          processing:snapshot.processing,activeCount:Array.isArray(snapshot.active)?snapshot.active.length:0,
          returnedHistoryCount:Array.isArray(snapshot.jobs)?snapshot.jobs.length:0,hasMore:snapshot.has_more,
        }});
      }

      if (req.method==='GET' && routePath==='/admin/provider/jobs') {
        const provider=await providerClient();
        return sendJson(res,200,await provider.getJobs(12));
      }

      if (req.method==='GET' && routePath==='/admin/provider/job') {
        const jobId=Number(url.searchParams.get('id'));
        if (!Number.isFinite(jobId)||jobId<=0) return sendJson(res,400,{ok:false,error:'Valid job id is required.'});
        const provider=await providerClient();
        const snapshot=await provider.getJobs(12);
        const all=[...(snapshot.active||[]),...(snapshot.jobs||[])];
        const job=all.find(item=>Number(item.id)===jobId)||null;
        return sendJson(res,200,{ok:true,found:Boolean(job),job:job?provider.normalizeJob(job):null});
      }

      if (req.method==='POST' && routePath==='/admin/provider/generate') {
        const settings=await getProviderSettings();
        if (!settings.allowProviderCharges) return sendJson(res,403,{ok:false,error:'Generation submissions are disabled.'});
        const body=await readJson(req);
        const prompt=String(body.prompt||'').trim();
        if (!prompt) return sendJson(res,400,{ok:false,error:'prompt is required'});
        const provider=await providerClient();
        const result=await provider.generateText({
          prompt, model:String(body.model||'seedance_2.5'), duration:Number(body.duration||10),
          aspectRatio:String(body.aspectRatio||'9:16'), quantity:Number(body.quantity||1),
        });
        return sendJson(res,200,{ok:true,submitted:true,job_id:result.job_id,job_ids:result.job_ids,quantity:result.quantity});
      }

      if (req.method==='GET' && routePath==='/admin/provider-settings') {
        requireDatabase();
        return sendJson(res,200,{ok:true,settings:await getAdminProviderSettings()});
      }

      if (req.method==='PUT' && routePath==='/admin/provider-settings') {
        requireDatabase();
        const body=await readJson(req);
        const settings=await updateProviderSettings(body);
        return sendJson(res,200,{ok:true,settings});
      }

      if (req.method==='GET' && routePath==='/admin/stats') {
        requireDatabase();
        const db=getPool();
        const [[userStats]] = await db.query(
          `SELECT COUNT(*) AS users,
                  COALESCE(SUM(credits),0) AS user_credits,
                  SUM(status='active') AS active_users
           FROM users`
        );
        const [[genStats]] = await db.query(
          `SELECT COUNT(*) AS generations,
                  SUM(status='completed') AS completed,
                  SUM(status IN ('queued','submitting','submitted','processing')) AS active,
                  SUM(status IN ('failed','submit_error')) AS failed,
                  COALESCE(SUM(credits_cost),0) AS credits_charged
           FROM generations`
        );
        return sendJson(res,200,{ok:true,stats:{
          users:Number(userStats.users||0),
          activeUsers:Number(userStats.active_users||0),
          userCredits:Number(userStats.user_credits||0),
          generations:Number(genStats.generations||0),
          completed:Number(genStats.completed||0),
          active:Number(genStats.active||0),
          failed:Number(genStats.failed||0),
          creditsCharged:Number(genStats.credits_charged||0),
        }});
      }

      if (req.method==='GET' && routePath==='/admin/config') {
        const providerSettings=await getAdminProviderSettings();
        return sendJson(res,200,{ok:true,
          pricing:publicPricing(),
          aspectRatios:ASPECT_RATIOS,
          signupsEnabled:allowSignups,
          workerEnabled:/^(1|true|yes|on)$/i.test(String(process.env.WORKER_ENABLED||'true')),
          providers:{
            vidancee:providerSettings.vidancee.configured,
            createpulse:providerSettings.createpulse.configured,
          },
          routing:providerSettings.routing,
          createPulseMaxInflight:providerSettings.createpulse.maxInflight,
          generationEnabled:providerSettings.allowProviderCharges,
        });
      }

      if (req.method==='GET' && routePath==='/admin/users') {
        requireDatabase();
        const db=getPool();
        const q=String(url.searchParams.get('q')||'').trim();
        const status=String(url.searchParams.get('status')||'').trim();
        const clauses=[]; const params=[];
        if (q) {
          clauses.push('(email LIKE ? OR CAST(id AS CHAR)=?)');
          params.push('%'+q+'%',q);
        }
        if (status==='active'||status==='disabled') { clauses.push('status=?'); params.push(status); }
        const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
        const [rows]=await db.query(
          'SELECT id,email,credits,role,status,created_at,updated_at FROM users'+where+' ORDER BY created_at DESC LIMIT 200',
          params,
        );
        return sendJson(res,200,{ok:true,users:rows.map(userPayload)});
      }

      const userPatchMatch=routePath.match(/^\/admin\/users\/(\d+)$/);
      if (req.method==='PATCH' && userPatchMatch) {
        requireDatabase();
        const body=await readJson(req);
        const db=getPool();
        const userId=Number(userPatchMatch[1]);
        const [rows]=await db.execute('SELECT * FROM users WHERE id=? LIMIT 1',[userId]);
        if (!rows[0]) return sendJson(res,404,{ok:false,error:'User not found.'});

        const updates=[]; const params=[];
        if (body.status!==undefined) {
          if (!['active','disabled'].includes(String(body.status))) return sendJson(res,400,{ok:false,error:'Invalid user status.'});
          updates.push('status=?'); params.push(String(body.status));
        }
        if (body.role!==undefined) {
          if (!['user','admin'].includes(String(body.role))) return sendJson(res,400,{ok:false,error:'Invalid user role.'});
          updates.push('role=?'); params.push(String(body.role));
        }
        if (!updates.length) return sendJson(res,400,{ok:false,error:'No user fields supplied.'});
        params.push(userId);
        await db.execute('UPDATE users SET '+updates.join(', ')+', updated_at=UTC_TIMESTAMP() WHERE id=?',params);
        const [updated]=await db.execute('SELECT id,email,credits,role,status,created_at,updated_at FROM users WHERE id=?',[userId]);
        return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
      }

      if (req.method==='POST' && routePath==='/admin/users/credits') {
        requireDatabase();
        const body=await readJson(req);
        const identifier=String(body.identifier||'').trim();
        const amount=Number(body.amount);
        if (!identifier) return sendJson(res,400,{ok:false,error:'User ID or email is required.'});
        if (!Number.isInteger(amount)||amount===0) return sendJson(res,400,{ok:false,error:'amount must be a non-zero integer'});

        const db=getPool(); const conn=await db.getConnection();
        try {
          await conn.beginTransaction();
          const isId=/^\d+$/.test(identifier);
          const [users]=isId
            ? await conn.execute('SELECT * FROM users WHERE id=? FOR UPDATE',[Number(identifier)])
            : await conn.execute('SELECT * FROM users WHERE email=? FOR UPDATE',[normalizeEmail(identifier)]);
          const user=users[0];
          if (!user) { await conn.rollback(); return sendJson(res,404,{ok:false,error:'User not found.'}); }
          if (Number(user.credits)+amount<0) { await conn.rollback(); return sendJson(res,400,{ok:false,error:'Credit adjustment would make balance negative.'}); }
          await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,user.id]);
          await conn.execute(
            "INSERT INTO credit_transactions (user_id,amount,type,note) VALUES (?,?,'admin_adjustment',?)",
            [user.id,amount,String(body.note||'Admin credit adjustment').slice(0,255)],
          );
          await conn.commit();
          const [updated]=await db.execute('SELECT id,email,credits,role,status,created_at FROM users WHERE id=?',[user.id]);
          return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
        } catch(error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
      }

      const creditMatch=routePath.match(/^\/admin\/users\/(\d+)\/credits$/);
      if (req.method==='POST' && creditMatch) {
        requireDatabase();
        const body=await readJson(req);
        const amount=Number(body.amount);
        if (!Number.isInteger(amount)||amount===0) return sendJson(res,400,{ok:false,error:'amount must be a non-zero integer'});
        const db=getPool(); const conn=await db.getConnection();
        try {
          await conn.beginTransaction();
          const [users]=await conn.execute('SELECT * FROM users WHERE id=? FOR UPDATE',[Number(creditMatch[1])]);
          const user=users[0];
          if (!user) { await conn.rollback(); return sendJson(res,404,{ok:false,error:'User not found.'}); }
          if (Number(user.credits)+amount<0) { await conn.rollback(); return sendJson(res,400,{ok:false,error:'Credit adjustment would make balance negative.'}); }
          await conn.execute('UPDATE users SET credits=credits+? WHERE id=?',[amount,user.id]);
          await conn.execute(
            "INSERT INTO credit_transactions (user_id,amount,type,note) VALUES (?,?,'admin_adjustment',?)",
            [user.id,amount,String(body.note||'Admin credit adjustment').slice(0,255)],
          );
          await conn.commit();
          const [updated]=await db.execute('SELECT id,email,credits,role,status,created_at FROM users WHERE id=?',[user.id]);
          return sendJson(res,200,{ok:true,user:userPayload(updated[0])});
        } catch(error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
      }

      if (req.method==='GET' && routePath==='/admin/credits') {
        requireDatabase();
        const db=getPool();
        const userId=Number(url.searchParams.get('user_id')||0);
        const params=[]; let where='';
        if (userId>0) { where=' WHERE c.user_id=?'; params.push(userId); }
        const [rows]=await db.query(
          `SELECT c.id,c.user_id,u.email,c.generation_id,c.amount,c.type,c.note,c.created_at
           FROM credit_transactions c JOIN users u ON u.id=c.user_id`+where+`
           ORDER BY c.created_at DESC LIMIT 200`,
          params,
        );
        return sendJson(res,200,{ok:true,transactions:rows});
      }

      if (req.method==='GET' && routePath==='/admin/generations') {
        requireDatabase();
        const db=getPool();
        const status=String(url.searchParams.get('status')||'').trim();
        const q=String(url.searchParams.get('q')||'').trim();
        const clauses=[]; const params=[];
        if (status) { clauses.push('g.status=?'); params.push(status); }
        if (q) { clauses.push('(u.email LIKE ? OR g.id=? OR CAST(g.provider_job_id AS CHAR)=?)'); params.push('%'+q+'%',q,q); }
        const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
        const [rows]=await db.query(
          `SELECT g.*,u.email FROM generations g JOIN users u ON u.id=g.user_id`+where+`
           ORDER BY g.created_at DESC LIMIT 200`,
          params,
        );
        return sendJson(res,200,{ok:true,generations:rows.map(row=>({...serializeGeneration(row),user_email:row.email,provider:row.provider,provider_job_id:row.provider_job_id}))});
      }

      return sendJson(res,404,{ok:false,error:'Admin route not found.'});
    }

    return sendJson(res,404,{ok:false,error:'Not found'});
  } catch(error) {
    console.error(error);
    return sendJson(res,error.statusCode||500,safeError(error));
  }
});

server.on('error',(error)=>{console.error('HTTP server failed:',error);process.exitCode=1;});

function bootstrap() {
  // Start HTTP immediately so Hostinger can route traffic even if MySQL is
  // temporarily unavailable or misconfigured.
  server.listen(port,host,()=>console.log('mehroz-ai milestone 4 listening on '+host+':'+port));

  if (!dbConfigured()) {
    console.warn('MySQL not configured yet. Public UI will load, but account/generation APIs are unavailable.');
    return;
  }

  initDb()
    .then(async () => {
      console.log('MySQL schema ready.');
      const migrated=await migrateLegacyProviderEnvSettings();
      if (migrated) console.log('Legacy provider settings migrated into Admin-managed storage.');
      const worker=new GenerationWorker();
      worker.start();
    })
    .catch((error) => {
      console.error('MySQL initialization failed:',error);
      console.error('Web server remains online; inspect /health for database diagnostics.');
    });
}

bootstrap();
module.exports=server;
