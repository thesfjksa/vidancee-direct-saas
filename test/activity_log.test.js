const test = require('node:test');
const assert = require('node:assert/strict');
const log = require('../src/activity_log.js');

test('activity entries mask secrets, signed links and media data', () => {
  const rows = [];
  log.setActivitySink(row => rows.push(row));
  log.logActivity({ level: 'error', category: 'provider', event: 'argolink.status', userId: '7', generationId: 'g1', provider: 'argolink',
    message: 'failed https://cmmtools.site/provider-outputs/g1?sig=abcdef0123',
    details: { argoLinkApiKey: 'argo-secret', authorization: 'Bearer x', nested: { password: 'p', ok: 1 },
      image: 'data:image/png;base64,' + 'A'.repeat(500), body: { start_image: { url: 'https://cmmtools.site/provider-assets/g1/0?sig=deadbeef' } }, error: { code: 'generation_failed', retryable: true } } });
  log.setActivitySink(null);
  const [row] = rows;
  assert.deepEqual([row.level, row.category, row.event, row.userId, row.generationId, row.provider], ['error', 'provider', 'argolink.status', 7, 'g1', 'argolink']);
  assert.match(row.message, /sig=\*\*\*$/);
  const details = JSON.parse(row.details);
  assert.equal(details.argoLinkApiKey, '***');
  assert.equal(details.authorization, '***');
  assert.deepEqual(details.nested, { password: '***', ok: 1 });
  assert.match(details.image, /^\[\d+ bytes of data\]$/);
  assert.equal(details.body.start_image.url, 'https://cmmtools.site/provider-assets/g1/0?sig=***');
  assert.deepEqual(details.error, { code: 'generation_failed', retryable: true });
  assert.equal(JSON.stringify(rows).includes('argo-secret'), false);
});

test('logging is off in tests unless a sink is set, and never throws', () => {
  assert.equal(process.env.ACTIVITY_LOG, 'off');
  assert.doesNotThrow(() => log.logActivity({ event: 'x', details: { self: (() => { const o = {}; o.o = o; return o; })() } }));
});

test('the support key is stored only as a hash and compared safely', () => {
  const key = log.newSupportKey();
  assert.match(key, /^cmm_support_[A-Za-z0-9_-]{32}$/);
  const hash = log.hashSupportKey(key);
  assert.notEqual(hash, key);
  assert.equal(log.supportKeyMatches(key, hash), true);
  assert.equal(log.supportKeyMatches(key + 'x', hash), false);
  assert.equal(log.supportKeyMatches('', hash), false);
  assert.equal(log.supportKeyMatches(key, ''), false);
  assert.equal(log.maskEmail('tonya@example.com'), 'to***@example.com');
});
