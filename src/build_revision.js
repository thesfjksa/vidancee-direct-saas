'use strict';

// Resolve the exact checked-out commit once at process start. The working tree
// can be a normal clone, a Git worktree, or an export without .git metadata.
// Never present a release number (such as worker health revision 6) as a SHA.
const fs = require('node:fs');
const path = require('node:path');

const fullSha = value => {
  const sha = String(value || '').trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
};

function gitDirectory(root) {
  const marker = path.join(root, '.git');
  try {
    if (fs.statSync(marker).isDirectory()) return marker;
    // Git worktrees store a text .git pointer rather than a directory.
    const match = /^gitdir:\s*(.+)$/i.exec(fs.readFileSync(marker, 'utf8').trim());
    return match ? path.resolve(root, match[1]) : null;
  } catch { return null; }
}

function readGitHead(root) {
  const dir = gitDirectory(root);
  if (!dir) return null;
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const detached = fullSha(head);
    if (detached) return detached;
    const match = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/.exec(head);
    if (!match || match[1].split('/').some(part => part === '..' || part === '.')) return null;
    const ref = match[1];
    try { return fullSha(fs.readFileSync(path.join(dir, ...ref.split('/')), 'utf8')); }
    catch {
      // Some deployments/checkouts put branch refs in packed-refs.
      const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
      for (const line of packed.split(/\r?\n/)) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref) return fullSha(sha);
      }
      return null;
    }
  } catch { return null; }
}

function detectRevision({ root = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const checkout = readGitHead(root);
  if (checkout) return { commit: checkout, source: 'git' };
  // Hosting platforms differ. SOURCE_REVISION may be set explicitly when an
  // artifact contains no .git metadata, but an env claim is not Git proof.
  for (const key of ['SOURCE_REVISION', 'GIT_COMMIT_SHA', 'GITHUB_SHA', 'RENDER_GIT_COMMIT', 'VERCEL_GIT_COMMIT_SHA']) {
    const commit = fullSha(env[key]);
    if (commit) return { commit, source: 'environment' };
  }
  return { commit: null, source: 'unavailable' };
}

module.exports = { detectRevision };
