'use strict';

// API keys are submitted once in the authenticated POST body. Neither keys
// nor Live URLs are stored in browser storage, query strings or UI logs.
(() => {
  const el = id => document.getElementById(id);
  let loginId = null, timer = null, countdownTimer = null, active = false, configured = false, busy = false, savedMode = 'browserless';
  let pairingExpiresAt = 0;
  // A checked browser checkbox is NOT evidence of an enabled persisted source.
  const savedState = () => el('aividSavedSettingsState');
  function paintSavedState(data) {
    const enabled=data.enabled===true,ceiling=Number(data.maxSourceCredits||0);
    const agent=data.mode==='rdp'?Boolean(data.rdp?.online&&data.rdp?.status==='ready'&&data.rdp?.browser==='edge'):Boolean(data.configured&&!data.sessionExpired);
    const ready=enabled&&ceiling>0&&agent;
    savedState().textContent='Saved in Admin: '+(enabled?'Enabled':'Disabled')+
      ' · Maximum '+ceiling+' AIVID credits/video · Agent '+(agent?'ready':'not ready')+
      (ready?' · Premium submissions ready':' · Premium submissions paused')+
      (data.manualHandoff?' · Admin submits new requests by hand':'');
    savedState().className=ready?'ok': 'muted';
  }
  window.markAividSettingsDirty=()=>{
    savedState().textContent='Unsaved changes — click Save RDP connection to apply these settings.';
    savedState().className='muted';
  };
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
    el('aividCheckModelsButton').disabled = busy || active || !configured;
    el('aividCheckReferencesButton').disabled = busy || active || !configured;
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
  // This is deliberately independent of queued AIVID generation controls.
  let windowsStudioSaving=false;
  const windowsList=value=>String(value||'').split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean);
  window.markWindowsStudioDirty=()=>{
    const state=el('aividWindowsStudioState');
    state.textContent='Unsaved Windows Studio changes — click Save Windows Studio settings.';
    state.className='muted';
  };
  window.loadWindowsStudioAdmin=async ({strict=false}={})=>{
    const status=el('aividWindowsStudioState'),badge=el('aividWindowsStudioBadge');
    try{
      const data=await api('/admin/aivid/windows-studio');
      const c=data.settings;
      el('aividWindowsStudioEnabled').checked=c.enabled===true;
      el('aividWindowsStudioEmails').value=(c.allowedEmails||[]).join(', ');
      el('aividWindowsStudioIds').value=(c.allowedIds||[]).join(', ');
      el('aividWindowsStudioBillingAck').checked=c.directBillingAcknowledged===true;
      const accounts=(c.allowedIds||[]).length+(c.allowedEmails||[]).length;
      badge.textContent=c.enabled?'Enabled · '+accounts+' approved':'Disabled';
      status.className=c.enabled?'ok':'muted';
      status.textContent='Saved in Admin: '+(c.enabled?'Enabled':'Disabled')+' · '+accounts+
        ' trusted account'+(accounts===1?'':'s')+' · Direct AIVID billing '+
        (c.directBillingAcknowledged?'acknowledged':'not acknowledged')+'. No Hostinger environment variables needed.';
      return c;
    }catch(error){
      status.textContent='Unable to read Windows Studio settings: '+error.message;
      status.className='err';badge.textContent='Check settings';
      if(strict)throw error;
      return null;
    }
  };
  window.saveWindowsStudioAdmin=async()=>{
    if(windowsStudioSaving)return;
    const status=el('aividWindowsStudioState'),button=el('aividWindowsStudioSave');
    const form={
      enabled:el('aividWindowsStudioEnabled').checked,
      allowedEmails:windowsList(el('aividWindowsStudioEmails').value),
      allowedIds:windowsList(el('aividWindowsStudioIds').value),
      directBillingAcknowledged:el('aividWindowsStudioBillingAck').checked
    };
    if(form.enabled&&(!form.directBillingAcknowledged||!form.allowedEmails.length&&!form.allowedIds.length)){
      status.textContent='Approve a trusted CMMTools account and acknowledge direct AIVID billing.';
      status.className='err';return;
    }
    if(form.enabled&&!confirm('Enable the private Windows Edge browser for approved users?\n\nGenerate clicks charge the AIVID provider account DIRECTLY, not the CMMTools wallet.'))return;
    windowsStudioSaving=true;button.disabled=true;
    status.className='muted';status.textContent='Saving Windows Studio settings in the CMMTools database…';
    try{
      const saved=await api('/admin/aivid/windows-studio',{method:'POST',body:JSON.stringify(form)});
      const verified=await window.loadWindowsStudioAdmin({strict:true});
      if(JSON.stringify(saved.settings)!==JSON.stringify(verified))throw Error('Saved state could not be verified. Refresh Admin.');
      status.className='ok';status.textContent='Saved and verified: Windows Premium Studio '+(verified.enabled?'ON':'OFF')+
        ' · '+(verified.allowedIds.length+verified.allowedEmails.length)+' trusted account(s).';
    }catch(error){status.className='err';status.textContent=error.message;}
    finally{windowsStudioSaving=false;button.disabled=false;}
  };
  window.loadAividAdmin = async ({strict=false}={}) => {
    clearTimeout(timer);
    try {
      const data = await api('/admin/aivid/status');
      savedMode = data.mode || 'browserless'; el('aividTransport').value = savedMode;
      el('aividRdpCeiling').value = String(data.maxSourceCredits || 0);
      el('aividCustomerRate').value = String(data.customerCreditsPerSourceCredit);
      el('aividRdpEnabled').checked = data.enabled === true;
      el('aividManualHandoff').checked = data.manualHandoff === true;
      paintSavedState(data);
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
      await window.loadWindowsStudioAdmin();
      if (savedMode === 'rdp') {
        const rdp = data.rdp || {};
        const browserName = 'Microsoft Edge';
        const switching = rdp.online && rdp.browser !== 'edge';
        el('aividRdpStatus').textContent = !rdp.paired ? 'No RDP agent paired yet.' :
          (rdp.online ? (rdp.status==='needs_verification'
            ? 'AIVID verification required. Close the idle Agent, finish verification in AIVID-Login.exe on your RDP, close its ' + browserName + ' window, then restart the Agent.'
            : switching ? 'Agent switching to ' + browserName + '. Keep the updated agent running.' : 'Agent online (' + browserName + '): ' + rdp.status.replaceAll('_', ' ')) : 'Agent offline. Start AIVID-Agent.exe on your RDP.') +
          (rdp.seenAt ? ' Last seen ' + new Date(rdp.seenAt).toLocaleString() + '.' : '');
        el('aividConnectionBadge').textContent = rdp.online ? 'RDP online' : rdp.paired ? 'RDP offline' : 'Pair RDP agent';
        el('aividSessionStatus').textContent = 'Sign-in stays in ' + browserName + ' on your RDP. Browserless is not used in RDP mode.';
      }
      if (savedMode !== 'rdp' && data.sessionExpired && !active) el('aividConnectionBadge').textContent = 'Session expired';
      if (active) await pollLogin();
      return data;
    } catch (error) { message(error.message, true); if(strict)throw error; return null; }
    finally { buttons(); }
  };
  window.saveAividAdmin = async () => {
    busy = true; buttons(); message('Saving AIVID settings…');
    try {
      const expectedEnabled=el('aividRdpEnabled').checked;
      const expectedCeiling=Number(el('aividRdpCeiling').value);
      const expectedHandoff=el('aividManualHandoff').checked;
      const saved=await api('/admin/aivid/settings', { method: 'POST', body: JSON.stringify({
        mode: el('aividTransport').value,
        manualHandoff: expectedHandoff, enabled: expectedEnabled, maxSourceCredits: Number(el('aividRdpCeiling').value),
        apiKey: el('aividBrowserlessKey').value.trim(), endpoint: el('aividBrowserlessRegion').value,
        ttlDays: Number(el('aividSessionDays').value),
      }) });
      el('aividBrowserlessKey').value = '';
      const verified=await window.loadAividAdmin({strict:true});
      if(saved.enabled!==expectedEnabled || Number(saved.maxSourceCredits)!==expectedCeiling ||
         verified.enabled!==expectedEnabled || Number(verified.maxSourceCredits)!==expectedCeiling ||
         Boolean(saved.manualHandoff)!==expectedHandoff || Boolean(verified.manualHandoff)!==expectedHandoff ||
         saved.browser!=='edge' || verified.browser!=='edge')
        throw new Error('Saved AIVID state differs from your settings. Refresh Admin and check database write access.');
      message(savedMode === 'rdp'
        ? 'Saved and verified: AIVID '+(expectedEnabled?'enabled':'disabled')+
          ', browser Microsoft Edge, maximum '+expectedCeiling+' source credits/video. '+(expectedCeiling<=0?'A credit ceiling of 0 still blocks generation.':'Refresh customer Video Studio.')
        : 'Browserless settings saved and verified.');
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
      pairingExpiresAt = Date.parse(data.expiresAt);
      el('aividPairCodeInput').value = data.code;
      el('aividPairCopyRow').hidden = false;
      el('aividPairCode').textContent = 'Expires ' + new Date(data.expiresAt).toLocaleTimeString() + '. Click Copy code, then Paste code in the Agent pairing window. Saved pairing is reused on future starts.';
      message('Code ready. Copy it, then click Paste code in AIVID-Agent.exe.');
    } catch (error) { message(error.message, true); }
    finally { busy = false; buttons(); }
  };
  window.copyAividRdpCode = async () => {
    const input = el('aividPairCodeInput');
    if (!input.value || !Number.isFinite(pairingExpiresAt) || Date.now() >= pairingExpiresAt) {
      message('This pairing code expired. Generate a fresh code.', true); return;
    }
    try {
      await navigator.clipboard.writeText(input.value);
      message('Code copied. In the RDP Agent pairing window, click Paste code, then Connect.');
    } catch {
      input.focus(); input.select();
      message('Code selected. Press Ctrl+C, then paste it into the Agent pairing window.');
    }
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
  window.checkAividModels = async () => {
    if(busy||active)return;
    busy=true;buttons();
    const models=[['aivid_seedance_2_0_mini','Seedance 2.0 Mini'],['aivid_seedance_2_0','Seedance 2.0'],['aivid_seedance_2_0_fast','Seedance 2.0 Fast'],['aivid_seedance_2_5','Seedance 2.5']];
    const lines=[],total=models.length*2;let passed=0;
    try {
      for(const [model,label] of models)for(const resolution of ['480p','720p']){
        message(lines.concat('Checking '+label+' · '+resolution+' · 5 seconds…').join('\n'));
        try {
          const data=await api('/admin/aivid/check',{method:'POST',body:JSON.stringify({model,duration:5,resolution,aspectRatio:'16:9'})});
          if(data.modelVerified!==true)throw new Error('Server or agent did not verify the requested model/settings. Deploy current server and use the complete current agent.');
          const limit=data.withinLimit===false?' · exceeds saved source-credit limit':'';
          lines.push(label+' · '+resolution+' · 5 seconds: '+data.price+' AIVID credits · balance '+data.balance+
            (Number.isFinite(data.standardCustomerCredits)?' · standard customer '+data.standardCustomerCredits+' credits':'')+limit);
          if(!limit)passed++;
        } catch(error){lines.push(label+' · '+resolution+' · 5 seconds: FAILED — '+error.message);}
      }
      message(lines.concat(passed+'/'+total+' checks passed. No video was generated and no credits were charged. These checks do not verify completed videos or reference uploads.').join('\n'),passed!==total);
    } finally {busy=false;buttons();}
  };
  window.checkAividReferences=async()=>{
    if(busy||active)return;busy=true;buttons();
    const lines=[],models=[['aivid_seedance_2_0_mini','Seedance Mini'],['aivid_seedance_2_0','Seedance 2.0'],['aivid_seedance_2_0_fast','Seedance 2.0 Fast'],['aivid_seedance_2_5','Seedance 2.5']];let passed=0;
    const checks=[['aivid_seedance_2_0_mini','Seedance Mini',true],...models];
    try{
      for(const [model,label,imageOnly=false] of checks){
        const media=imageOnly?'three images':'image, video and audio';
        const expected=imageOnly?{image:3,video:0,audio:0}:{image:1,video:1,audio:1};
        message(lines.concat('Checking '+label+' · '+media+'…').join('\n'));
        try{
          const data=await api('/admin/aivid/check-references',{method:'POST',body:JSON.stringify({model,imageOnly})});
          if(data.verified!==true||data.submitted!==false||data.generationBlocked!==true||data.modelId!==model||
            data.balanceBefore!==data.balanceAfter||Object.entries(expected).some(([kind,count])=>data.uploadedCounts?.[kind]!==count))throw new Error('Reference upload verification was incomplete.');
          lines.push(label+': '+media+' uploaded; video submission blocked; balance '+data.balanceAfter+' unchanged.');passed++;
        }catch(error){lines.push(label+' · '+media+': FAILED — '+error.message);}
      }
      message(lines.concat(passed+'/'+checks.length+' reference checks passed. Only synthetic test media is uploaded. No video is submitted or customer wallet charged. Completed reference-based videos still need a paid acceptance test.').join('\n'),passed!==checks.length);
    }finally{busy=false;buttons();}
  };
})();
