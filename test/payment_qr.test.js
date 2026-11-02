const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('both plan-specific Easypaisa assets are present and distinct', () => {
  const creator = read('public/assets/payments/easypaisa-5000.svg');
  const studio = read('public/assets/payments/easypaisa-10000.svg');
  for (const [content, amount] of [[creator, 5000], [studio, 10000]]) {
    assert.match(content, /viewBox="0 0 41 41"/);
    assert.match(content, /<rect width="41" height="41" fill="#fff"\/>/);
    assert.match(content, /<path fill="#000" d="M/);
    assert.ok(content.includes('Easypaisa PKR ' + amount + ' payment QR'));
  }
  assert.notEqual(creator, studio);
});

test('the QR payment UI enforces fixed plan amounts, expiry, and pending review', () => {
  const checkout = read('public/payment-qr.js');
  assert.match(checkout, /creator: Object\.freeze\(\{ amount: 5000, image: '\/assets\/payments\/easypaisa-5000\.svg' \}\)/);
  assert.match(checkout, /studio: Object\.freeze\(\{ amount: 10000, image: '\/assets\/payments\/easypaisa-10000\.svg' \}\)/);
  assert.match(checkout, /2026-11-27T23:59:59\+05:00/);
  assert.match(checkout, /Date\.now\(\) > EXPIRES_AT/);
  assert.match(checkout, /No credits are granted until an admin/);
  assert.match(checkout, /planStatus\?\.pendingRequest/);
  assert.match(checkout, /api\('\/api\/plan-requests'/);
  assert.match(checkout, /Send receipt \/ transaction ID on WhatsApp/);
  assert.doesNotMatch(checkout, /admin\/plan-requests/);
});

test('both public and signed-in pricing routes open the correct manual checkout', () => {
  const pricing = read('public/pricing.html');
  const app = read('public/index.html');
  assert.match(pricing, /\/app\?signup=1&amp;plan=creator/);
  assert.match(pricing, /\/app\?signup=1&amp;plan=studio/);
  assert.match(pricing, /encodeURIComponent\(p\.code\)/);
  assert.match(app, /<script src="\/payment-qr\.js\?v=1"><\/script>/);
  assert.match(app, /loadAll\(\)\.then\(\(\)=>window\.openCheckoutFromUrl\?\.\(\)\)/);
  assert.match(app, /function requestPlan\(planCode\)\{window\.openPlanPayment\(planCode\);\}/);
  assert.match(app, /const disabled=pending&&!isPending\?' disabled':'';/);
});

test('QR checkout and all inline pricing / app scripts parse as JavaScript', () => {
  new vm.Script(read('public/payment-qr.js'), { filename: 'payment-qr.js' });
  for (const file of ['public/index.html', 'public/pricing.html']) {
    const scripts = [...read(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const match of scripts) new vm.Script(match[1], { filename: file });
  }
});
