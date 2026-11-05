'use strict';

// API keys are submitted once in the authenticated POST body. Neither keys
// nor Live URLs are stored in browser storage, query strings or UI logs.
(() => {
  const el = id => document.getElementById(id);
  let loginId = null, timer = null, countdownTimer = null, active = false, configured = false, busy = false, savedMode = 'browserless';
  const states = new Set(['opening', 'waiting', 'verify_requested', 'verifying']);
  function message(text, error = false) {
    el('aividAdminMessage').textContent = text;
    el('aividAdminMessage').className = error ? 'err' : 'muted';
  }
  function buttons() {
    const mode = el('aividTransport').value;
    el('aividSaveButton').disabled = busy || active;
    el('aividConnectButton').disabled = busy || active || !configured || mode !== savedMode;
    el('aividReplaceButton').disabled = busy || active || !configured;
    el('aividCheckButton').disabled = busy || active || !configured;
    el('aividPairButton').disabled = busy || active || mode !== 'rdp' || savedMode !== 'rdp';
  }
  window.updateAividTransport = () => {
    const rdp = el('aividTransport').value === 'rdp';
    el('aividBrowserlessFields').hidden = rdp; el('aividRdpFields').hidden = !rdp;
    el('aividSaveButton').textContent = rdp ? 'Save RDP connection' : 'Save Browserless key';
    el('aividConnectButton').textContent = rdp ? 'Check RDP connection' : 'Connect aivid';
    el('aividCheckButton').hidden = rdp;
    el('aividReplaceButton').closest('details').hidden = rdp;
    buttons();
  };
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
    clearInterval(countdownTimer);
    let countdown = el('aividLoginCountdown');
    if (!countdown) {
      countdown = document.createElement('p'); countdown.id = 'aividLoginCountdown';
      countdown.className = 'muted'; countdown.setAttribute('role', 'timer');
      el('aividLoginLink').insertAdjacentElement('afterend', countdown);
    }
    countdown.hidden = !active;
    const expires = Date.parse(login.expiresAt);
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
      countdown.textContent = seconds
        ? 'Login window: ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + ' remaining. The saved profile lasts longer than this window.'
        : 'Login window expired. Connect again to reopen the saved profile.';
      if (!seconds) {
        link.classList.add('hide'); link.removeAttribute('href');
        el('aividVerifyButton').disabled = true; clearInterval(countdownTimer);
      }
    };
    if (active && Number.isFinite(expires)) { updateCountdown(); countdownTimer = setInterval(updateCountdown, 1000); }
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
      savedMode = data.mode || 'browserless'; el('aividTransport').value = savedMode;
      el('aividRdpCeiling').value = String(data.maxSourceCredits || 0);
      el('aividRdpEnabled').checked = data.enabled === true;
      configured = savedMode === 'rdp' ? data.rdp?.paired === true : data.apiKeyConfigured || data.configured;
      window.updateAividTransport();
      el('aividKeyStatus').textContent = data.apiKeyConfigured ? 'Saved key: configured (encrypted)' : 'No Browserless key saved yet.';
      el('aividBrowserlessKey').placeholder = data.apiKeyConfigured ? 'Leave blank to keep the saved key' : 'Enter your Browserless API key';
      el('aividBrowserlessRegion').value = data.endpoint;
      el('aividSessionDays').value = String(data.ttlDays || 1);
      el('aividSessionStatus').textContent = data.expiresAt
        ? (data.sessionExpired ? 'Saved session expired ' : 'Session saved until ') + new Date(data.expiresAt).toLocaleString()
        : 'No browser session saved yet.';
      el('aividConnectionBadge').textContent = data.sessionExpired ? 'Session expired' : data.configured ? 'Session saved' : 'Not connected';
      paintLogin(data.login || { state: 'idle' });
      if (savedMode === 'rdp') {
        const rdp = data.rdp || {};
        el('aividRdpStatus').textContent = !rdp.paired ? 'No RDP agent paired yet.' :
          (rdp.online ? 'Agent online: ' + rdp.status.replaceAll('_', ' ') : 'Agent offline. Start AIVID-Agent.exe on your RDP.') +
          (rdp.seenAt ? ' Last seen ' + new Date(rdp.seenAt).toLocaleString() + '.' : '');
        el('aividConnectionBadge').textContent = rdp.online ? 'RDP online' : rdp.paired ? 'RDP offline' : 'Pair RDP agent';
        el('aividSessionStatus').textContent = 'Sign-in stays in Chrome on your RDP. Browserless is not used in RDP mode.';
      }
      if (savedMode !== 'rdp' && data.sessionExpired && !active) el('aividConnectionBadge').textContent = 'Session expired';
      if (active) await pollLogin();
    } catch (error) { message(error.message, true); }
    finally { buttons(); }
  };
  window.saveAividAdmin = async () => {
    busy = true; buttons(); message('Saving Browserless settings…');
    try {
      await api('/admin/aivid/settings', { method: 'POST', body: JSON.stringify({
        mode: el('aividTransport').value,
        enabled: el('aividRdpEnabled').checked, maxSourceCredits: Number(el('aividRdpCeiling').value),
        apiKey: el('aividBrowserlessKey').value.trim(), endpoint: el('aividBrowserlessRegion').value,
        ttlDays: Number(el('aividSessionDays').value),
      }) });
      el('aividBrowserlessKey').value = '';
      await window.loadAividAdmin(); message(savedMode === 'rdp' ? 'RDP mode saved. Generate a pairing code and enter it in AIVID-Agent.exe.' : 'Browserless settings saved. Click Connect aivid to sign in.');
    } catch (error) { message(error.message, true); }
    finally { busy = false; buttons(); }
  };
  window.connectAividAdmin = async replaceSession => {
    if (savedMode === 'rdp') return window.checkAividAdmin();
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
  window.pairAividRdp = async () => {
    busy = true; buttons();
    try {
      const data = await api('/admin/aivid/rdp/pairing', { method: 'POST', body: '{}' });
      el('aividPairCode').textContent = 'Pairing code: ' + data.code + ' · expires ' + new Date(data.expiresAt).toLocaleTimeString() + '. Enter it in AIVID-Agent.exe, then Refresh status.';
      message('The one-time code pairs this RDP with CMMTools. It is not your Google password.');
    } catch (error) { message(error.message, true); }
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
