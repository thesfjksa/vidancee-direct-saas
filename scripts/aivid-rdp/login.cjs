'use strict';
const { startEdge, browserProfile } = require('./native.cjs');
async function main() {
  if (process.platform !== 'win32') throw new Error('Use this launcher on your Windows RDP.');
  await startEdge(browserProfile(__dirname));
  const label = 'Microsoft Edge';
  console.log('Ordinary ' + label + ' opened for manual AIVID / Google sign-in. No automation or debugging is active.');
  console.log('Finish signing in to aivid.dev. Then close this AIVID ' + label + ' window once and start AIVID-Agent.exe.');
  console.log('The agent will keep ' + label + ' running afterwards. Your normal browser profile is not copied.');
}
if (require.main === module) main().catch(() => { console.error('Could not open Microsoft Edge. Check that Edge is installed and this folder is writable.'); process.exitCode = 1; });
module.exports = { main };
