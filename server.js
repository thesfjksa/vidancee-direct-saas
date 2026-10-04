const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { VidanceeClient } = require('./src/provider/vidancee.js');

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
const providerBaseUrl = String(process.env.VIDANCEE_BASE_URL || 'https://vidancee.com').replace(/\/$/, '');
const allowProviderCharges = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PROVIDER_CHARGES || 'no'));

if (!adminToken) {
  console.warn('ADMIN_TOKEN is not configured. The server will still start, but /admin/* endpoints will be unavailable.');
}

function providerConfig() {
  const email = String(process.env.VIDANCEE_EMAIL || '').trim();
  const password = String(process.env.VIDANCEE_PASSWORD || '');
  if (!email || !password) throw new Error('VIDANCEE_EMAIL and VIDANCEE_PASSWORD must be configured in hPanel.');
  return { baseUrl: providerBaseUrl, email, password };
}

function client() {
  return new VidanceeClient(providerConfig());
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
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

function authorized(req) {
  const supplied = String(req.headers['x-admin-token'] || '');
  return supplied.length > 0 && supplied === adminToken;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeError(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    name: error && error.name ? error.name : 'Error',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendHtml(res, 200, page);
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      app: 'vidancee-direct-saas',
      milestone: 1,
      node: process.version,
      providerChargesEnabled: allowProviderCharges,
      config: {
        adminTokenConfigured: Boolean(adminToken),
        providerEmailConfigured: Boolean(String(process.env.VIDANCEE_EMAIL || '').trim()),
        providerPasswordConfigured: Boolean(String(process.env.VIDANCEE_PASSWORD || '')),
        providerBaseUrl,
      },
    });
  }

  if (!url.pathname.startsWith('/admin/')) {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  if (!adminToken) {
    return sendJson(res, 503, { ok: false, error: 'ADMIN_TOKEN is not configured in hPanel.' });
  }

  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }

  try {
    if (req.method === 'POST' && url.pathname === '/admin/provider/check') {
      const provider = client();
      await provider.login();
      const snapshot = await provider.getJobs(12);

      return sendJson(res, 200, {
        ok: true,
        login: 'OK',
        provider: {
          credits: snapshot.credits,
          reserved: snapshot.reserved,
          concurrency: snapshot.concurrency,
          processing: snapshot.processing,
          activeCount: Array.isArray(snapshot.active) ? snapshot.active.length : 0,
          returnedHistoryCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : 0,
          hasMore: snapshot.has_more,
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/admin/provider/jobs') {
      const provider = client();
      return sendJson(res, 200, await provider.getJobs(12));
    }

    if (req.method === 'GET' && url.pathname === '/admin/provider/job') {
      const jobId = Number(url.searchParams.get('id'));
      if (!Number.isFinite(jobId) || jobId <= 0) {
        return sendJson(res, 400, { ok: false, error: 'Valid job id is required.' });
      }

      const provider = client();
      const snapshot = await provider.getJobs(12);
      const all = [...(snapshot.active || []), ...(snapshot.jobs || [])];
      const job = all.find((item) => Number(item.id) === jobId) || null;

      return sendJson(res, 200, {
        ok: true,
        found: Boolean(job),
        job: job ? provider.normalizeJob(job) : null,
      });
    }

    if (req.method === 'POST' && url.pathname === '/admin/provider/generate') {
      if (!allowProviderCharges) {
        return sendJson(res, 403, {
          ok: false,
          error: 'Provider charges are disabled. Set ALLOW_PROVIDER_CHARGES=yes in hPanel only after the provider check succeeds.',
        });
      }

      const body = await readJson(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt is required' });

      const provider = client();
      const result = await provider.generateText({
        prompt,
        model: String(body.model || 'seedance_2.5'),
        duration: Number(body.duration || 10),
        aspectRatio: String(body.aspectRatio || '9:16'),
        quantity: Number(body.quantity || 1),
      });

      return sendJson(res, 200, {
        ok: true,
        submitted: true,
        provider: 'vidancee',
        job_id: result.job_id,
        job_ids: result.job_ids,
        quantity: result.quantity,
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, safeError(error));
  }
});

server.on('error', (error) => {
  console.error('HTTP server failed:', error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`vidancee-direct-saas listening on ${host}:${port}`);
});

module.exports = server;
