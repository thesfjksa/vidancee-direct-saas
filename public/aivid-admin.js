'use strict';

// API keys are submitted once in the authenticated POST body. Neither keys
// nor Live URLs are stored in browser storage, query strings or UI logs.
(() => {
  const el = id => document.getElementById(id);
  let loginId = null, timer = null, active = false, configured = false, busy = false;
  const states = new Set(['opening', 'waiting', 'verify_requested', 'verifying']);
  function message(text, error = false) {
    el('aividAdminMessage').textContent = text;
    el('aividAdminMessage').className = error ? 'err' : 'muted';
  }
  function buttons() {
    el('aividSaveButton').disabled = busy || active;
    el('aividConnectButton').disabled = busy || active || !configured;
    el('aividReplaceButton').disabled = busy || active || !configured;
    el('aividCheckButton').disabled = busy || active || !configured;
  }
  function paintLogin(login) {
    active = states.has(login.state);
    loginId = login.id || null;
    el('aividLoginBox').classList.toggle('hide', !active);
    el('aividLoginMessage').textContent = login.message || '';
    el('aividVerifyButton').disabled = login.state !== 'waiting';
    el('aividCancelButton').disabled = !active;
    const link = el('aividLoginLink');
    link.classList.add('hide'); link.removeAttribute('href');
    if (login.liveURL) {
      const url = new URL(login.liveURL);
      if (url.protocol === 'https:' && url.hostname.endsWith('.browserless.io') && !url.username && !url.password) {
        link.href = url.href; link.classList.remove('hide');
      }
    }
    if (login.state === 'connected') {
      el('aividConnectionBadge').textContent = 'Sign-in verified';
      message(login.message + (login.verifiedAt ? ' Verified ' + new Date(login.verifiedAt).toLocaleString() + '.' : ''));
    } else if (active) el('aividConnectionBadge').textContent = login.state === 'verifying' ? 'Verifying…' : 'Sign-in in progress';
    else if (['expired', 'failed', 'cancelled'].includes(login.state)) {
      el('aividConnectionBadge').textContent = 'Reconnect to continue'; message(login.message, login.state === 'failed');
    }
    buttons();
  }
  function schedulePoll() {
    clearTimeout(timer);
    if (active && loginId) timer = setTimeout(pollLogin, 1200);
  }
  async function pollLogin() {
    const id = loginId;
    if (!id || !active) return;
    try {
      const data = await api('/admin/aivid/login/' + encodeURIComponent(id));
      if (loginId !== id) return;
      paintLogin(data.login); schedulePoll();
    } catch (error) {
      message(error.message, true);
      // Keep a visible retry path after a request failure; opening a second
      // paid browser session is never an automatic recovery action.
      el('aividLoginMessage').textContent = 'Status could not be refreshed. Use Refresh status to reconnect to this attempt.';
    }
  }
  window.loadAividAdmin = async () => {
    clearTimeout(timer);
    try {
      const data = await api('/admin/aivid/status');
      configured = data.apiKeyConfigured || data.configured;
      el('aividKeyStatus').textContent = data.apiKeyConfigured ? 'Saved key: configured (encrypted)' : 'No Browserless key saved yet.';
      el('aividBrowserlessKey').placeholder = data.apiKeyConfigured ? 'Leave blank to keep the saved key' : 'Enter your Browserless API key';
      el('aividBrowserlessRegion').value = data.endpoint;
      el('aividSessionDays').value = String(data.ttlDays || 1);
      el('aividSessionStatus').textContent = data.expiresAt
        ? (data.sessionExpired ? 'Saved session expired ' : 'Session saved until ') + new Date(data.expiresAt).toLocaleString()
        : 'No browser session saved yet.';
      el('aividConnectionBadge').textContent = data.sessionExpired ? 'Session expired' : data.configured ? 'Session saved' : 'Not connected';
      paintLogin(data.login || { state: 'idle' });
      if (data.sessionExpired && !active) el('aividConnectionBadge').textContent = 'Session expired';
      if (active) await pollLogin();
    } catch (error) { message(error.message, true); }
    finally { buttons(); }
  };
  window.saveAividAdmin = async () => {
    busy = true; buttons(); message('Saving Browserless settings…');
    try {
      await api('/admin/aivid/settings', { method: 'POST', body: JSON.stringify({
        apiKey: el('aividBrowserlessKey').value.trim(), endpoint: el('aividBrowserlessRegion').value,
        ttlDays: Number(el('aividSessionDays').value),
      }) });
      el('aividBrowserlessKey').value = '';
      await window.loadAividAdmin(); message('Browserless settings saved. Click Connect aivid to sign in.');
    } catch (error) { message(error.message, true); }
    finally { busy = false; buttons(); }
  };
  window.connectAividAdmin = async replaceSession => {
    busy = true; buttons(); message('Opening your private AIVID login session…');
    try {
      const data = await api('/admin/aivid/login', { method: 'POST', body: JSON.stringify({ replaceSession }) });
      paintLogin(data.login); schedulePoll();
      message('Click Open aivid login window below. Finish Google sign-in, then click Verify sign-in.');
    } catch (error) {
      // A creation failure also has a saved diagnostic status. Refresh the
      // badge without replacing the precise response with a generic message.
      await window.loadAividAdmin(); message(error.message, true);
    }
    finally { busy = false; buttons(); }
  };
  window.finishAividAdmin = async action => {
    if (!loginId) return;
    el('aividVerifyButton').disabled = true;
    try {
      await api('/admin/aivid/login/' + encodeURIComponent(loginId) + '/' + action, { method: 'POST', body: '{}' });
      message(action === 'finish' ? 'Verifying your saved sign-in…' : 'Closing the login window…');
      await pollLogin();
    } catch (error) { message(error.message, true); el('aividVerifyButton').disabled = false; }
  };
  window.checkAividAdmin = async () => {
    busy = true; buttons(); message('Checking the saved AIVID session…');
    try {
      const data = await api('/admin/aivid/check', { method: 'POST', body: '{}' });
      el('aividConnectionBadge').textContent = 'Connected';
      message('Connected to AIVID. Balance: ' + data.balance + ' credits. Mini test price: ' + data.price + ' credits. No video was generated.');
    } catch (error) { message(error.message, true); }
    finally { busy = false; buttons(); }
  };
})();
