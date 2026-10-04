const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
const { GenerationWorker } = require('./src/worker.js');

const customerPage = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const adminPage = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const providerBaseUrl = String(process.env.VIDANCEE_BASE_URL || 'https://vidancee.com').replace(/\/$/, '');
const allowProviderCharges = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PROVIDER_CHARGES || 'no'));
const allowSignups = !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_SIGNUPS || 'yes'));
const startingCredits = Math.max(0, Number(process.env.STARTING_CREDITS || 0));

if (!adminToken) console.warn('ADMIN_TOKEN is not configured. Admin routes will be unavailable.');

function providerConfig() {
  const email = String(process.env.VIDANCEE_EMAIL || '').trim();
  const password = String(process.env.VIDANCEE_PASSWORD || '');
  if (!email || !password) throw new Error('VIDANCEE_EMAIL and VIDANCEE_PASSWORD must be configured in hPanel.');
  return { baseUrl: providerBaseUrl, email, password };
}
function providerClient() { return new VidanceeClient(providerConfig()); }

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
function adminAuthorized(req) {
  const supplied=String(req.headers['x-admin-token']||'');
  if (!supplied || !adminToken || supplied.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken));
}
function userPayload(user) {
  return {
    id:Number(user.id), email:user.email, credits:Number(user.credits),
    role:user.role, status:user.status, created_at:user.created_at,
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

    if (req.method==='GET' && routePath==='/health') {
      const database=await dbHealth();
      return sendJson(res,200,{
        ok:true, app:'vidancee-direct-saas', milestone:2, node:process.version,
        providerChargesEnabled:allowProviderCharges,
        database,
        config:{
          adminTokenConfigured:Boolean(adminToken),
          providerEmailConfigured:Boolean(String(process.env.VIDANCEE_EMAIL||'').trim()),
          providerPasswordConfigured:Boolean(String(process.env.VIDANCEE_PASSWORD||'')),
          providerBaseUrl,
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

    if (req.method==='GET' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      return sendJson(res,200,{ok:true,generations:await listUserGenerations(user.id,50)});
    }

    if (req.method==='POST' && routePath==='/api/generations') {
      requireDatabase();
      const user=await requireUser(req);
      const body=await readJson(req);
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
        const provider=providerClient();
        await provider.login();
        const snapshot=await provider.getJobs(12);
        return sendJson(res,200,{ok:true,login:'OK',provider:{
          credits:snapshot.credits,reserved:snapshot.reserved,concurrency:snapshot.concurrency,
          processing:snapshot.processing,activeCount:Array.isArray(snapshot.active)?snapshot.active.length:0,
          returnedHistoryCount:Array.isArray(snapshot.jobs)?snapshot.jobs.length:0,hasMore:snapshot.has_more,
        }});
      }

      if (req.method==='GET' && routePath==='/admin/provider/jobs') {
        return sendJson(res,200,await providerClient().getJobs(12));
      }

      if (req.method==='GET' && routePath==='/admin/provider/job') {
        const jobId=Number(url.searchParams.get('id'));
        if (!Number.isFinite(jobId)||jobId<=0) return sendJson(res,400,{ok:false,error:'Valid job id is required.'});
        const provider=providerClient();
        const snapshot=await provider.getJobs(12);
        const all=[...(snapshot.active||[]),...(snapshot.jobs||[])];
        const job=all.find(item=>Number(item.id)===jobId)||null;
        return sendJson(res,200,{ok:true,found:Boolean(job),job:job?provider.normalizeJob(job):null});
      }

      if (req.method==='POST' && routePath==='/admin/provider/generate') {
        if (!allowProviderCharges) return sendJson(res,403,{ok:false,error:'Provider charges are disabled.'});
        const body=await readJson(req);
        const prompt=String(body.prompt||'').trim();
        if (!prompt) return sendJson(res,400,{ok:false,error:'prompt is required'});
        const result=await providerClient().generateText({
          prompt, model:String(body.model||'seedance_2.5'), duration:Number(body.duration||10),
          aspectRatio:String(body.aspectRatio||'9:16'), quantity:Number(body.quantity||1),
        });
        return sendJson(res,200,{ok:true,submitted:true,provider:'vidancee',job_id:result.job_id,job_ids:result.job_ids,quantity:result.quantity});
      }

      if (req.method==='GET' && routePath==='/admin/users') {
        requireDatabase();
        const db=getPool();
        const [rows]=await db.query('SELECT id,email,credits,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 100');
        return sendJson(res,200,{ok:true,users:rows.map(userPayload)});
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

      if (req.method==='GET' && routePath==='/admin/generations') {
        requireDatabase();
        const db=getPool();
        const [rows]=await db.query(
          `SELECT g.*,u.email FROM generations g JOIN users u ON u.id=g.user_id
           ORDER BY g.created_at DESC LIMIT 100`
        );
        return sendJson(res,200,{ok:true,generations:rows.map(row=>({...serializeGeneration(row),user_email:row.email,provider_job_id:row.provider_job_id}))});
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
  server.listen(port,host,()=>console.log('vidancee-direct-saas milestone 2 listening on '+host+':'+port));

  if (!dbConfigured()) {
    console.warn('MySQL not configured yet. Public UI will load, but account/generation APIs are unavailable.');
    return;
  }

  initDb()
    .then(() => {
      console.log('MySQL schema ready.');
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
