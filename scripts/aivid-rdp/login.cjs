'use strict';
const path = require('node:path');
const { startChrome } = require('./native.cjs');
async function main() {
  if (process.platform !== 'win32') throw new Error('Use this launcher on your Windows RDP.');
  await startChrome(path.join(__dirname, '.aivid-rdp-profile'));
  console.log('Ordinary Chrome opened for manual AIVID / Google sign-in. No automation or debugging is active.');
  console.log('Finish signing in to aivid.dev. Then close this AIVID Chrome window once and start AIVID-Agent.exe.');
  console.log('The agent will keep Chrome running afterwards. Your normal Chrome profile is not copied.');
}
if (require.main === module) main().catch(() => { console.error('Could not open the login browser. Check that Chrome exists and this folder is writable.'); process.exitCode = 1; });
module.exports = { main };
