'use strict';

const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getSettingValue, setSettingValue } = require('./settings.js');
const { getAividSettings, saveAividSettings, publicConfig, SESSION_KEY } = require('./aivid_settings.js');
const { withAividLock } = require('./aivid_queue.js');
const { createSession, connectSession, browserlessUrl } = require('./provider/browserless.js');
const { waitForSession } = require('./provider/aivid.js');
const LOGIN_KEY = 'aivid_browserless_login';
const ACTION_KEY = 'aivid_browserless_login_action';
const ACTIVE = new Set(['opening', 'waiting', 'verify_requested', 'verifying']);
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, aividSafe: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function publicLogin(value, { includeLink = false, now = Date.now() } = {}) {
  if (!value) return { state: 'idle' };
  const expired = ACTIVE.has(value.state) && Date.parse(value.expiresAt) <= now;
  const state = expired ? 'expired' : value.state;
  return { id: value.id, state, expiresAt: value.expiresAt, verifiedAt: value.verifiedAt || null,
    message: expired ? 'The login window expired. Connect again to reopen the saved session.' : value.message || '',
    ...(includeLink && state === 'waiting' && value.liveURL ? { liveURL: value.liveURL } : {}) };
}

class AividAdminService {
  constructor({ db = getPool, read = getSettingValue, write = setSettingValue, getConfig = getAividSettings,
    saveConfig = saveAividSettings, create = createSession, connect = connectSession, verify = waitForSession,
    now = Date.now, pause = delay, loginMs = 110000 } = {}) {
    Object.assign(this, { db, read, write, getConfig, saveConfig, create, connect, verify, now, pause, loginMs });
    this.tasks = new Set(); this.remotes = new Set(); this.stopping = false;
  }
  async readLogin() {
    const raw = await this.read(LOGIN_KEY, '');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { throw problem('The saved login status is invalid. Reconnect from Admin.'); }
  }
  async writeLogin(value) { await this.write(LOGIN_KEY, JSON.stringify(value), { secret: true }); }
  async status() {
    const [config, login] = await Promise.all([this.getConfig(), this.readLogin()]);
    return { ...publicConfig(config), login: publicLogin(login, { now: this.now() }) };
  }
  async save(input) {
    const result = await withAividLock(this.db(), () => this.saveConfig(input));
    if (!result) throw problem('The browser is busy. Finish or cancel sign-in before saving settings.', 409);
    return result;
  }
  async assertReplaceable() {
    const [[row]] = await this.db().execute("SELECT COUNT(*) AS total FROM generations WHERE provider='aivid' AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL");
    if (Number(row?.total || 0)) throw problem('AIVID has outstanding generations. Reuse its saved session until those jobs are resolved.', 409);
  }
  async startLogin({ replaceSession = false } = {}) {
    if (this.stopping) throw problem('The server is restarting. Try again shortly.', 503);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const task = (async () => {
      const result = await withAividLock(this.db(), async () => {
        const config = await this.getConfig();
        const sessionExpired = config.expiresAt && Date.parse(config.expiresAt) <= this.now();
        if (replaceSession || !config.connectUrl || sessionExpired) {
          if (!config.apiKey) throw problem('Save your Browserless API key first.');
          await this.assertReplaceable();
          const session = await this.create({ token: config.apiKey, endpoint: config.endpoint, ttl: config.ttlDays * 86400000 });
          // Store the session BEFORE opening sign-in. It is ready for the worker
          // without installing a file or exposing the connect URL to the UI.
          if (config.session?.connect) await this.write('aivid_browserless_previous_session', JSON.stringify(config.session), { secret: true });
          await this.write(SESSION_KEY, JSON.stringify(session), { secret: true });
          config.connectUrl = session.connect;
        }
        const id = crypto.randomUUID();
        let state = { id, state: 'opening', expiresAt: new Date(this.now() + this.loginMs).toISOString(), message: 'Opening the AIVID login window.' };
        let remote, linkId;
        const save = async patch => { state = { ...state, ...patch }; await this.writeLogin(state); };
        await save({});
        try {
          remote = await this.connect(config.connectUrl, { timeoutMs: 120000 });
          this.remotes.add(remote);
          await remote.page.goto('https://aivid.dev/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          const cdp = await remote.context.newCDPSession(remote.page);
          const remaining = Math.max(1000, Date.parse(state.expiresAt) - this.now());
          const live = await cdp.send('Browserless.liveURL', { interactable: true, timeout: remaining,
            showBrowserInterface: true });
          if (live.error || !live.liveURL) throw new Error('Live login unavailable');
          const liveUrl = browserlessUrl(live.liveURL, 'https:');
          if (liveUrl.hostname !== new URL(config.connectUrl).hostname) throw new Error('Unexpected login host');
          linkId = live.liveURLId;
          const linkMs = Math.min(Number(live.timeout) || remaining, remaining);
          await save({ state: 'waiting', liveURL: liveUrl.href, expiresAt: new Date(this.now() + linkMs).toISOString(),
            message: 'Open the login window, sign in to AIVID with Google, then click Verify sign-in here.' });
          resolveReady(publicLogin(state, { includeLink: true, now: this.now() }));
          while (!this.stopping && this.now() < Date.parse(state.expiresAt)) {
            let action = {};
            try { action = JSON.parse(await this.read(ACTION_KEY, '{}')); } catch {}
            if (action.id === id && action.action === 'cancel') {
              await save({ state: 'cancelled', liveURL: null, message: 'Sign-in closed. The saved session was kept.' });
              return true;
            }
            if (action.id === id && action.action === 'finish' && action.nonce !== state.lastAction) {
              await save({ state: 'verifying', lastAction: action.nonce, message: 'Verifying the saved AIVID login.' });
              try {
                // The user may have opened Google in a popup. Return the
                // persistent context to AIVID and verify actual page state.
                await remote.page.goto('https://aivid.dev/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                await this.verify(remote.page, { timeoutMs: 5000 });
              } catch {
                await save({ state: 'waiting', message: 'Sign-in is not complete. Finish in the login window, then verify again.' });
                await this.pause(500); continue;
              }
              // Close and reconnect to prove that authentication survived the
              // browser connection. The worker will reuse this same profile.
              if (linkId) await cdp.send('Browserless.closeLiveURL', { liveURLId: linkId }).catch(() => {});
              await remote.close(); this.remotes.delete(remote);
              remote = await this.connect(config.connectUrl);
              this.remotes.add(remote);
              await remote.page.goto('https://aivid.dev/', { waitUntil: 'domcontentloaded', timeout: 15000 });
              await this.verify(remote.page, { timeoutMs: 10000 });
              await remote.close(); this.remotes.delete(remote); remote = null;
              await save({ state: 'connected', liveURL: null, verifiedAt: new Date(this.now()).toISOString(),
                message: 'AIVID sign-in verified and saved for the worker.' });
              return true;
            }
            await this.pause(750);
          }
          await save({ state: this.stopping ? 'cancelled' : 'expired', liveURL: null,
            message: this.stopping ? 'Server restarted. Reopen the saved session to continue sign-in.' : 'The login window expired. Connect again to reopen the saved session.' });
          return true;
        } catch {
          await save({ state: 'failed', liveURL: null, message: 'Could not open or verify the cloud browser. Check your Browserless key, plan, session and Google sign-in.' });
          rejectReady(problem(state.message, 502));
          return true;
        } finally {
          if (remote) { await remote.close().catch(() => {}); this.remotes.delete(remote); }
        }
      });
      if (!result) rejectReady(problem('The AIVID browser is busy. Finish its current operation before connecting.', 409));
    })().catch(error => {
      // All uncontrolled infrastructure errors are scrubbed before the HTTP
      // response or activity logger can receive a credential-bearing URL.
      rejectReady(error.aividSafe ? error : problem('Browserless setup failed. Check the saved key, plan and server connection.', 502));
    });
    this.tasks.add(task); task.finally(() => this.tasks.delete(task));
    return ready;
  }
  async loginStatus(id) {
    const state = await this.readLogin();
    if (!state || state.id !== id) throw problem('Login attempt not found. Refresh status and reconnect.', 404);
    return publicLogin(state, { includeLink: true, now: this.now() });
  }
  async requestAction(id, action) {
    const state = await this.loginStatus(id);
    if (!ACTIVE.has(state.state)) throw problem('This login window is no longer active. Reconnect to continue.', 409);
    if (!['finish', 'cancel'].includes(action)) throw problem('Invalid login action.');
    await this.write(ACTION_KEY, JSON.stringify({ id, action, nonce: crypto.randomUUID() }));
    return { requested: true };
  }
  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.remotes].map(remote => remote.close()));
  }
}

let singleton;
function getAividAdminService() { return singleton ||= new AividAdminService(); }
async function stopAividAdmin() { if (singleton) await singleton.stop(); }

module.exports = { AividAdminService, getAividAdminService, stopAividAdmin, publicLogin, LOGIN_KEY, ACTION_KEY };
