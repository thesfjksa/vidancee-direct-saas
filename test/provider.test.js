import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLoginCsrf, extractStudioCsrf, VidanceeClient } from '../src/provider/vidancee.js';

test('extractLoginCsrf reads hidden csrf_token', () => {
  const html = '<form><input type="hidden" name="csrf_token" value="abc123"></form>';
  assert.equal(extractLoginCsrf(html), 'abc123');
});

test('extractStudioCsrf reads meta csrf-token', () => {
  const html = '<head><meta name="csrf-token" content="studio-token"></head>';
  assert.equal(extractStudioCsrf(html), 'studio-token');
});

test('resolveProviderPath converts relative render paths', () => {
  const client = new VidanceeClient({
    baseUrl: 'https://vidancee.com',
    email: 'x@example.com',
    password: 'secret',
    fetchImpl: async () => { throw new Error('not used'); },
  });
  assert.equal(
    client.resolveProviderPath('renders/v1393_demo.mp4'),
    'https://vidancee.com/renders/v1393_demo.mp4',
  );
  assert.equal(
    client.resolveProviderPath('https://cdn.example/video.mp4'),
    'https://cdn.example/video.mp4',
  );
});
