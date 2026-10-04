const DEFAULT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; VidanceeDirectSaaS/0.1)',
  accept: '*/*',
};

class VidanceeError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'VidanceeError';
    this.details = details;
  }
}

class VidanceeAuthError extends VidanceeError {
  constructor(message, details = null) {
    super(message, details);
    this.name = 'VidanceeAuthError';
  }
}

class VidanceeProtocolError extends VidanceeError {
  constructor(message, details = null) {
    super(message, details);
    this.name = 'VidanceeProtocolError';
  }
}

function extractLoginCsrf(html) {
  const patterns = [
    /<input[^>]*name=["']csrf_token["'][^>]*value=["']([^"']+)["'][^>]*>/i,
    /<input[^>]*value=["']([^"']+)["'][^>]*name=["']csrf_token["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function extractStudioCsrf(html) {
  const patterns = [
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["'][^>]*>/i,
  ];
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(headers) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookie(headers.get('set-cookie'));

    for (const raw of values) {
      if (!raw) continue;
      const first = raw.split(';', 1)[0];
      const index = first.indexOf('=');
      if (index <= 0) continue;
      const name = first.slice(0, index).trim();
      const value = first.slice(index + 1).trim();
      if (!name) continue;
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  has(name) {
    return this.cookies.has(name);
  }

  clear() {
    this.cookies.clear();
  }
}

function splitSetCookie(header) {
  if (!header) return [];
  const parts = [];
  let start = 0;
  let inExpires = false;

  for (let i = 0; i < header.length; i += 1) {
    const rest = header.slice(i).toLowerCase();
    if (rest.startsWith('expires=')) inExpires = true;
    if (inExpires && header[i] === ';') inExpires = false;

    if (!inExpires && header[i] === ',') {
      const next = header.slice(i + 1);
      if (/^\s*[^=;,\s]+\s*=/.test(next)) {
        parts.push(header.slice(start, i).trim());
        start = i + 1;
      }
    }
  }

  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

async function jsonBody(response, endpoint) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new VidanceeProtocolError(`${endpoint} returned non-JSON content.`, {
      status: response.status,
      preview: text.slice(0, 500),
    });
  }
}

class VidanceeClient {
  constructor({ baseUrl = 'https://vidancee.com', email, password, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') {
      throw new VidanceeProtocolError('Global fetch is unavailable. Use Node.js 18+.');
    }
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.cookies = new CookieJar();
    this.authenticated = false;
    this.studioCsrf = '';
  }

  async request(path, init = {}) {
    const headers = new Headers(DEFAULT_HEADERS);
    for (const [name, value] of Object.entries(init.headers || {})) {
      if (value !== undefined && value !== null) headers.set(name, String(value));
    }

    const cookie = this.cookies.header();
    if (cookie) headers.set('cookie', cookie);

    const response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
      ...init,
      headers,
    });

    this.cookies.absorb(response.headers);
    return response;
  }

  async login() {
    if (!this.email || !this.password) {
      throw new VidanceeAuthError('Vidancee email/password are not configured.');
    }

    this.cookies.clear();
    this.authenticated = false;
    this.studioCsrf = '';

    const loginPage = await this.request('/login.php', {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    if (loginPage.status !== 200) {
      throw new VidanceeProtocolError(`GET /login.php returned HTTP ${loginPage.status}.`);
    }

    const loginHtml = await loginPage.text();
    const csrf = extractLoginCsrf(loginHtml);
    if (!csrf) {
      throw new VidanceeProtocolError('Could not extract login csrf_token from /login.php.');
    }

    const form = new URLSearchParams();
    form.set('email', this.email);
    form.set('password', this.password);
    form.set('csrf_token', csrf);

    const loginResponse = await this.request('/login.php', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/login.php`,
        accept: 'text/html,application/xhtml+xml',
      },
      body: form.toString(),
    });

    const location = loginResponse.headers.get('location') || '';
    const redirectedToStudio = [301, 302, 303, 307, 308].includes(loginResponse.status)
      && location.includes('studio.php');

    if (!redirectedToStudio) {
      throw new VidanceeAuthError('Vidancee login did not redirect to /studio.php.', {
        status: loginResponse.status,
        location,
      });
    }

    if (!this.cookies.has('PHPSESSID')) {
      throw new VidanceeAuthError('Vidancee login succeeded but PHPSESSID was not captured.');
    }

    this.authenticated = true;
    await this.refreshStudioCsrf();
    return true;
  }

  async refreshStudioCsrf() {
    const response = await this.request('/studio.php', {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location') || '';
      if (location.includes('login.php')) {
        throw new VidanceeAuthError('Vidancee session redirected back to login.');
      }
    }

    if (response.status !== 200) {
      throw new VidanceeProtocolError(`GET /studio.php returned HTTP ${response.status}.`);
    }

    const html = await response.text();
    const token = extractStudioCsrf(html);
    if (!token) {
      throw new VidanceeProtocolError('Could not find meta[name="csrf-token"] on /studio.php.');
    }

    this.studioCsrf = token;
    return token;
  }

  async withAuth(operation) {
    if (!this.authenticated) await this.login();

    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof VidanceeAuthError)) throw error;
      await this.login();
      return operation();
    }
  }

  async getJobs(limit = 12) {
    return this.withAuth(async () => {
      const path = `/api/jobs.php?limit=${encodeURIComponent(limit)}&status=finished&with_active=1`;
      const response = await this.request(path, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: `${this.baseUrl}/studio.php`,
        },
      });

      if (response.status === 401 || response.status === 403) {
        throw new VidanceeAuthError(`jobs.php returned HTTP ${response.status}.`);
      }

      const data = await jsonBody(response, '/api/jobs.php');
      if (response.status !== 200 || data?.ok !== true) {
        throw new VidanceeProtocolError('Vidancee jobs request failed.', {
          status: response.status,
          data,
        });
      }
      return data;
    });
  }

  async generateText({
    prompt,
    model = 'seedance_2.5',
    duration = 10,
    aspectRatio = '9:16',
    quantity = 1,
  }) {
    return this.withAuth(async () => {
      if (!this.studioCsrf) await this.refreshStudioCsrf();

      const form = new FormData();
      form.append('mode', 'text-to-video');
      form.append('model', model);
      form.append('duration', String(duration));
      form.append('aspect_ratio', aspectRatio);
      form.append('prompt', prompt);
      form.append('quantity', String(quantity));

      const response = await this.request('/api/generate.php', {
        method: 'POST',
        headers: {
          'X-CSRF-Token': this.studioCsrf,
          origin: this.baseUrl,
          referer: `${this.baseUrl}/studio.php`,
          accept: 'application/json, text/plain, */*',
        },
        body: form,
      });

      if (response.status === 401 || response.status === 403) {
        throw new VidanceeAuthError(`generate.php returned HTTP ${response.status}.`);
      }

      const data = await jsonBody(response, '/api/generate.php');
      if (response.status !== 200 || data?.ok !== true) {
        throw new VidanceeProtocolError('Vidancee generation request was rejected.', {
          status: response.status,
          data,
        });
      }

      const ids = Array.isArray(data.job_ids)
        ? data.job_ids
        : data.job_id
          ? [data.job_id]
          : [];

      if (!ids.length) {
        throw new VidanceeProtocolError('Generation succeeded but no job ID was returned.', data);
      }

      return data;
    });
  }

  normalizeJob(job) {
    return {
      ...job,
      output_absolute_url: this.resolveProviderPath(job?.output_url),
      poster_absolute_url: this.resolveProviderPath(job?.poster),
    };
  }

  resolveProviderPath(value) {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    return new URL(String(value).replace(/^\//, ''), `${this.baseUrl}/`).toString();
  }
}

module.exports = {
  VidanceeError,
  VidanceeAuthError,
  VidanceeProtocolError,
  extractLoginCsrf,
  extractStudioCsrf,
  VidanceeClient,
};
