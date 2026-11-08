'use strict';

const { browserName, browserProfile, debuggerEndpoint, startBrowser } = require('./native.cjs');
const { loadConfig, Transport } = require('./agent.cjs');

async function selectedBrowser(root) {
  let config;
  try { config = await loadConfig(root); }
  catch (error) {
    // Preserve the Chrome login used before pairing a new installation.
    if (error.code === 'ENOENT') return 'chrome';
    throw new Error('Could not read the saved pairing. Start AIVID-Agent.exe to check pairing before signing in.');
  }
  try {
    const result = await new Transport(config.origin, config.token).request('/browser', { method: 'GET' });
    if (!['chrome', 'edge'].includes(result.browser)) throw new Error('Admin returned an invalid AIVID browser.');
    return result.browser;
  } catch (error) {
    if (error.statusCode === 404) return 'chrome'; // Server predates browser selection.
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Run AIVID-Login.exe on your Windows RDP.');
  const browser = await selectedBrowser(__dirname);
  const profile = browserProfile(__dirname, browser);
  if (await debuggerEndpoint(profile)) throw new Error('Close the AIVID window in ' + browserName(browser) + ' before opening the login launcher.');
  await startBrowser(profile, { browser });
  console.log(browserName(browser) + ' opened for manual AIVID / Google sign-in. Use the same AIVID account as before.');
  console.log('Finish signing in, close this AIVID browser window, then start AIVID-Agent.exe.');
}
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
