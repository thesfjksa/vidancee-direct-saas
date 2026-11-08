'use strict';
const path = require('node:path');
const { startChrome, browserProfile } = require('./native.cjs');
const { Transport, loadConfig } = require('./agent.cjs');
async function main() {
  if (process.platform !== 'win32') throw new Error('Use this launcher on your Windows RDP.');
  const config = await loadConfig(__dirname);
  const { browser } = await new Transport(config.origin, config.token).request('/browser', { method: 'GET' });
  if (!['chrome', 'edge'].includes(browser)) throw new Error('Admin browser selection was not available.');
  await startChrome(browserProfile(__dirname, browser), { browser });
  const label = browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  console.log('Ordinary ' + label + ' opened for manual AIVID / Google sign-in. No automation or debugging is active.');
  console.log('Finish signing in to aivid.dev. Then close this AIVID ' + label + ' window once and start AIVID-Agent.exe.');
  console.log('The agent will keep ' + label + ' running afterwards. Your normal browser profile is not copied.');
}
if (require.main === module) main().catch(() => { console.error('Could not open the selected login browser. Check Admin selection, RDP pairing and browser installation.'); process.exitCode = 1; });
module.exports = { main };
