'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectRevision } = require('../src/build_revision.js');
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('reads detached Git HEAD without needing git executable', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), shaA + '\n');
  assert.deepEqual(detectRevision({ root, env: { SOURCE_REVISION: shaB } }), { commit: shaA, source: 'git' });
});

test('reads a loose branch ref', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), shaA + '\n');
  assert.deepEqual(detectRevision({ root, env: {} }), { commit: shaA, source: 'git' });
});

test('reads a packed branch ref', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(root, '.git', 'packed-refs'), '# pack-refs with: peeled fully-peeled\n' + shaB + ' refs/heads/main\n');
  assert.deepEqual(detectRevision({ root, env: {} }), { commit: shaB, source: 'git' });
});

test('reads a linked gitdir in a worktree', t => {
  const root = tempRoot(t);
  const gitDir = path.join(root, 'metadata');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: metadata\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), shaB);
  assert.deepEqual(detectRevision({ root, env: {} }), { commit: shaB, source: 'git' });
});

test('falls back to a validated host-provided commit, or reports unavailable', t => {
  const root = tempRoot(t);
  assert.deepEqual(detectRevision({ root, env: { SOURCE_REVISION: shaB.toUpperCase() } }), { commit: shaB, source: 'environment' });
  assert.deepEqual(detectRevision({ root, env: { SOURCE_REVISION: 'main', GITHUB_SHA: shaA } }), { commit: shaA, source: 'environment' });
  assert.deepEqual(detectRevision({ root, env: { SOURCE_REVISION: '12345', GITHUB_SHA: 'not a sha' } }), { commit: null, source: 'unavailable' });
});

test('ignores unsafe or malformed branch paths', t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/../../secret\n');
  assert.deepEqual(detectRevision({ root, env: {} }), { commit: null, source: 'unavailable' });
});
