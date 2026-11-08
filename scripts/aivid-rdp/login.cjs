'use strict';
const path = require('node:path');
const { startBrowser } = require('./native.cjs');
const { Transport, loadConfig } = require('./agent.cjs');
async function main() {
  if (process.platform !== 'win32') throw new Error('Use this launcher on your Windows RDP.');
  const config = await loadConfig(__dirname);
  const selected = await new Transport(config.origin, config.token).request('/browser', { method: 'GET' });
  const browser = selected.browser === 'edge' ? 'edge' : 'chrome';
  const name = browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  await startBrowser(path.join(__dirname, browser === 'edge' ? '.aivid-rdp-edge-profile' : '.aivid-rdp-profile'), { browser });
  console.log('Ordinary ' + name + ' opened for manual AIVID / Google sign-in. No automation or debugging is active.');
  console.log('Finish signing in to aivid.dev. Then close this AIVID ' + name + ' window once and start AIVID-Agent.exe.');
  console.log('The agent will keep ' + name + ' running afterwards. Your normal browser profile is not copied.');
}
if (require.main === module) main().catch(() => { console.error('Could not open the selected login browser. Check that the agent is paired, the CMMTools connection works, the selected browser is installed and this folder is writable.'); process.exitCode = 1; });
module.exports = { main };
