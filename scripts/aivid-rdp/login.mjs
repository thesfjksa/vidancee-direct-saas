import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findChrome(env = process.env, exists = existsSync) {
  const candidates = [
    env.AIVID_CHROME_PATH,
    ...[env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean).map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ].filter(Boolean);
  const chrome = candidates.find(path => exists(path));
  if (!chrome) throw new Error('Google Chrome was not found. Install Chrome, then run AIVID-Login.exe again.');
  return chrome;
}

export function loginArguments(profile) {
  return ['--user-data-dir=' + resolve(profile), '--new-window', 'https://aivid.dev/'];
}

export async function openManualLogin({ env = process.env, platform = process.platform,
  exists = existsSync, start = spawn, ensureDirectory = mkdir } = {}) {
  if (platform !== 'win32') throw new Error('AIVID-Login.exe is intended for Windows.');
  const chrome = findChrome(env, exists);
  const profile = resolve(env.AIVID_RDP_PROFILE || './.aivid-rdp-profile');
  await ensureDirectory(profile, { recursive: true });
  const child = start(chrome, loginArguments(profile), { detached: true, stdio: 'ignore', shell: false });
  await new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('Chrome could not be started. Close other AIVID runner windows and try again.')));
    child.once('spawn', accept);
  });
  child.unref();
  return { opened: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  openManualLogin().then(() => {
    console.log('Normal Chrome opened for manual AIVID sign-in. No automation connection is active.');
    console.log('Sign in to AIVID using Google in that window. The runner never asks for your Google password.');
    console.log('After AIVID shows you are signed in, CLOSE ALL windows of this AIVID Chrome profile.');
    console.log('Then open AIVID-Preflight.exe. Your saved AIVID session will be reused.');
    console.log('If Google still refuses sign-in, stop and share the error wording without credentials.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
