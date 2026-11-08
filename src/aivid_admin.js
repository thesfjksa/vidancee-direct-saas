'use strict';

const crypto = require('node:crypto');
const { getPool } = require('./db.js');
const { getSettingValue, setSettingValue } = require('./settings.js');
const { getAividSettings, saveAividSettings, publicConfig, SESSION_KEY } = require('./aivid_settings.js');
const { withAividLock } = require('./aivid_queue.js');
const { createSession, connectSession, createLoginView, browserlessUrl } = require('./provider/browserless.js');
const { waitForSession, openLoginPage } = require('./provider/aivid.js');
const LOGIN_KEY = 'aivid_browserless_login';
const ACTION_KEY = 'aivid_browserless_login_action';
const ACTIVE = new Set(['opening', 'waiting', 'verify_requested', 'verifying']);
const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, aividSafe: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function setupFailure(error, stage) {
  if (error.aividSafe) return error;
  const message = {
    settings: 'CMMTools could not read the encrypted Browserless settings. Check database access and the server encryption configuration.',
    database: 'CMMTools could not save or lock the Browserless session in the database. Check server database access, then retry.',
    create: 'Browserless could not create the persistent session. Check the account session limits and retry with a 1-day lifetime.',
    connect: 'Could not connect to the saved Browserless session. Check active sessions in Browserless or use Session recovery.',
    navigation: 'The cloud browser opened, but could not load AIVID. Reconnect or try another Browserless region.',
    live: 'Browserless could not provide an interactive login window. Check whether Live URLs are available for your account, then reconnect.',
    verify: 'AIVID sign-in could not be confirmed after reconnecting to the saved session. Reopen the login window and sign in again.',
  }[stage];
  return problem(message || 'The Browserless setup could not complete. Refresh status and reconnect.', 502);
}

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
    saveConfig = saveAividSettings, create = createSession, connect = connectSession, verify = waitForSession, openLogin = openLoginPage,
    now = Date.now, pause = delay, loginMs = 110000 } = {}) {
    Object.assign(this, { db, read, write, getConfig, saveConfig, create, connect, verify, openLogin, now, pause, loginMs });
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
    return { ...publicConfig(config), login: config.mode === 'rdp' ? { state: 'idle' } : publicLogin(login, { now: this.now() }) };
  }
  async save(input) {
    const result = await withAividLock(this.db(), async () => {
      const current = await this.getConfig();
      if (input?.mode && input.mode !== (current.mode || 'browserless')) await this.assertReplaceable();
      return this.saveConfig(input);
    });
    if (!result) throw problem('The browser is busy. Finish or cancel sign-in before saving settings.', 409);
    return result;
  }
  async assertReplaceable() {
    const [[row]] = await this.db().execute("SELECT COUNT(*) AS total FROM generations WHERE provider='aivid' AND status IN ('submitting','submitted','processing') AND refunded_at IS NULL AND (provider_operation IS NULL OR provider_operation NOT LIKE '{\"stage\":\"manual_%')");
    if (Number(row?.total || 0)) throw problem('AIVID has outstanding generations. Reuse its saved session until those jobs are resolved.', 409);
  }
  async startLogin({ replaceSession = false } = {}) {
    if (this.stopping) throw problem('The server is restarting. Try again shortly.', 503);
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const task = (async () => {
      const result = await withAividLock(this.db(), async () => {
        let stage = 'settings';
        try {
          const config = await this.getConfig();
          if (config.mode === 'rdp') throw problem('Sign in with AIVID-Login.exe on your RDP, start AIVID-Agent.exe, then use Check RDP connection.', 409);
          const sessionExpired = config.expiresAt && Date.parse(config.expiresAt) <= this.now();
          if (replaceSession || !config.connectUrl || sessionExpired) {
            if (!config.apiKey) throw problem('Save your Browserless API key first.');
            stage = 'database';
            await this.assertReplaceable();
            stage = 'create';
            const session = await this.create({ token: config.apiKey, endpoint: config.endpoint, ttl: config.ttlDays * 86400000 });
            // Store the session BEFORE opening sign-in. It is ready for the worker
            // without installing a file or exposing the connect URL to the UI.
            stage = 'database';
            if (config.session?.connect) await this.write('aivid_browserless_previous_session', JSON.stringify(config.session), { secret: true });
            await this.write(SESSION_KEY, JSON.stringify(session), { secret: true });
            config.connectUrl = session.connect;
          }
          const id = crypto.randomUUID();
          let state = { id, state: 'opening', expiresAt: new Date(this.now() + this.loginMs).toISOString(), message: 'Opening the AIVID login window.' };
          let remote, linkId, liveCdp, liveComplete;
          let completion = null;
          const save = async patch => {
            state = { ...state, ...patch };
            try { await this.writeLogin(state); } catch (error) { throw setupFailure(error, 'database'); }
          };
          stage = 'database';
          await save({});
          try {
            stage = 'connect';
            remote = await this.connect(config.connectUrl, { timeoutMs: 120000 });
            this.remotes.add(remote);
            stage = 'navigation';
            const signInOpened = await this.openLogin(remote.page);
            stage = 'live';
            const remaining = Math.max(1000, Date.parse(state.expiresAt) - this.now());
            const live = await createLoginView(remote, { timeoutMs: remaining });
            const cdp = live.cdp;
            const liveUrl = browserlessUrl(live.liveURL, 'https:');
            if (liveUrl.hostname !== new URL(config.connectUrl).hostname) throw new Error('Unexpected login host');
            linkId = live.liveURLId;
            // Listen after minting: replacement can complete an older link.
            // Completion is not proof of sign-in, and feedback is never saved.
            liveCdp = cdp;
            liveComplete = event => { if (event.liveURLId === linkId) completion = event.reason; };
            cdp.on('Browserless.liveComplete', liveComplete);
            const linkMs = Math.min(Number(live.timeout) || remaining, remaining);
            await save({ state: 'waiting', liveURL: liveUrl.href, expiresAt: new Date(this.now() + linkMs).toISOString(),
              message: signInOpened
                ? 'Open the login window and choose Continue with Google. After signing in, return here and click Verify sign-in.'
                : 'Open the saved login window. If you are already signed in, click Verify sign-in here.' });
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
                stage = 'connect';
                remote = await this.connect(config.connectUrl);
                this.remotes.add(remote);
                stage = 'verify';
                await remote.page.goto('https://aivid.dev/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                await this.verify(remote.page, { timeoutMs: 10000 });
                await remote.close(); this.remotes.delete(remote); remote = null;
                await save({ state: 'connected', liveURL: null, verifiedAt: new Date(this.now()).toISOString(),
                  message: 'AIVID sign-in verified and saved for the worker.' });
                return true;
              }
              if (completion) {
                await save({ state: completion === 'timeout' ? 'expired' : 'cancelled', liveURL: null,
                  message: completion === 'timeout'
                    ? 'The live login window reached its time limit. Connect again to reopen the saved profile.'
                    : 'The live login window disconnected or closed. Connect again to reopen the saved profile.' });
                return true;
              }
              await this.pause(750);
            }
            await save({ state: this.stopping ? 'cancelled' : 'expired', liveURL: null,
              message: this.stopping ? 'Server restarted. Reopen the saved session to continue sign-in.' : 'The login window expired. Connect again to reopen the saved session.' });
            return true;
          } catch (error) {
            const failure = setupFailure(error, stage);
            await save({ state: 'failed', liveURL: null, message: failure.message });
            rejectReady(failure);
            return true;
          } finally {
            if (liveCdp && liveComplete) liveCdp.off('Browserless.liveComplete', liveComplete);
            if (remote) { await remote.close().catch(() => {}); this.remotes.delete(remote); }
          }
        } catch (error) {
          const failure = setupFailure(error, stage);
          if (failure.statusCode >= 500) {
            // Keep creation failures visible after a refresh, while still
            // holding the lock so another attempt cannot be overwritten.
            await this.writeLogin({ id: crypto.randomUUID(), state: 'failed',
              expiresAt: new Date(this.now()).toISOString(), liveURL: null, message: failure.message }).catch(() => {});
          }
          rejectReady(failure);
          return true;
        }
      });
      if (!result) rejectReady(problem('The AIVID browser is busy. Finish its current operation before connecting.', 409));
    })().catch(error => {
      // All uncontrolled infrastructure errors are scrubbed before the HTTP
      // response or activity logger can receive a credential-bearing URL.
      rejectReady(setupFailure(error, 'database'));
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
