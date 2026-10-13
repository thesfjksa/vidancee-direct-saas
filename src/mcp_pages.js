'use strict';

// Pages people see while connecting Claude: sign-in, consent, errors, and the
// photo upload page that request_image_upload links to. Every value from a
// request or an app's registration is escaped.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CMM Tools</title><link rel="icon" href="/assets/cmmtools-icon.png"><link rel="stylesheet" href="/brand.css">
<style>
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg)}
.card{width:100%;max-width:440px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-lg);padding:28px}
.logo{display:block;height:34px;margin:0 0 22px}
h1{margin:0 0 6px;font-size:20px;letter-spacing:-.02em;color:var(--text)}
p{margin:0 0 14px;color:var(--text-2)}
.muted{color:var(--muted);font-size:13px}
.app{display:flex;gap:12px;align-items:center;padding:12px 14px;margin:16px 0;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.app b{display:block;color:var(--text)} .app span{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
ul{margin:0 0 16px;padding-left:20px;color:var(--text-2)} li{margin:4px 0}
.warn{padding:10px 12px;border-radius:10px;background:#fff7e6;border:1px solid #f3d9a4;color:#7a5200;font-size:13px;margin:0 0 16px}
.err{padding:10px 12px;border-radius:10px;background:#fdecec;border:1px solid #f5c2c2;color:#8a1f1f;font-size:13px;margin:0 0 14px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
button{min-height:44px;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer}
.primary{color:#fff;background:linear-gradient(180deg,#0b5a8e,var(--brand));border:1px solid #003a62}
.secondary{color:var(--text);background:#fff;border:1px solid var(--line-2)}
label{display:block;font-size:13px;font-weight:600;color:var(--text-2);margin:12px 0 6px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;min-height:42px;padding:9px 12px;border:1px solid var(--line-2);border-radius:10px;font:inherit}
.full{width:100%;margin-top:16px}
.drop{display:grid;place-items:center;gap:6px;min-height:150px;margin:14px 0;border:1.5px dashed var(--line-strong);border-radius:12px;background:var(--panel-2);text-align:center;padding:16px;cursor:pointer}
.drop img{max-width:100%;max-height:220px;border-radius:8px}
.ok{padding:12px 14px;border-radius:10px;background:var(--accent-soft);border:1px solid #bfe7ec;color:var(--accent-2);font-weight:600}
</style></head><body><main class="card"><img class="logo" src="/assets/cmmtools-logo.png" alt="CMM Tools">${body}</main></body></html>`;
}

function errorPage(title, message) {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p class="muted">Close this tab and try connecting again from Claude.</p>`);
}

function hostOf(uri) { try { return new URL(uri).host; } catch { return uri; } }

function loginPage({ appName, error = '' }) {
  return layout('Sign in', `<h1>Sign in to connect ${esc(appName)}</h1>
<p>Use your CMM Tools account. ${esc(appName)} will then ask for permission to use it.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}<div id="msg" class="err" hidden></div>
<form id="login"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
<button class="primary full" type="submit">Sign in</button></form>
<p class="muted" style="margin-top:16px">No account yet? <a href="/" target="_blank" rel="noopener">Create one on CMM Tools</a>, then come back to this tab.</p>
<script>
document.getElementById('login').addEventListener('submit',async e=>{
  e.preventDefault();const msg=document.getElementById('msg');msg.hidden=true;
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',
    body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})}).catch(()=>null);
  if(r&&r.ok){location.reload();return}
  let text='Sign-in failed. Check your email and password.';try{const d=await r.json();if(d.error)text=d.error}catch{}
  msg.textContent=text;msg.hidden=false;
});
</script>`);
}

function consentPage({ appName, redirectUri, email, fields, loopback }) {
  const hidden = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return layout('Connect ' + appName, `<h1>Connect ${esc(appName)} to CMM Tools?</h1>
<p>Signed in as <b>${esc(email)}</b>.</p>
<div class="app"><div><b>${esc(appName)}</b><span>Returns to ${esc(hostOf(redirectUri))}</span></div></div>
${loopback ? '<div class="warn">This app runs on your computer (such as Claude Code). Only continue if you started this connection yourself.</div>' : ''}
<p>It will be able to:</p>
<ul><li>Create videos, images and upscales, which use your CMM Tools credits</li>
<li>See your credit balance, plan and models</li><li>See your videos and images and give download links</li></ul>
<p class="muted">You can disconnect it at any time in CMM Tools under Use with Claude, or in Claude.</p>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><button class="secondary" type="submit" name="decision" value="deny">Cancel</button>
<button class="primary" type="submit" name="decision" value="allow">Allow</button></div></form>`);
}

function uploadPage({ state, expired }) {
  if (expired) return layout('Upload link expired', '<h1>This upload link has expired</h1><p>Ask Claude for a new upload link.</p>');
  return layout('Upload a photo', `<h1>Upload a photo for Claude</h1>
<p>Pick a JPEG, PNG or WebP image (15 MB max). Claude can then use it as a reference for your video or image.</p>
${state === 'uploaded' ? '<div class="ok" id="done">A photo is already uploaded. You can go back to Claude, or pick another to replace it.</div>' : '<div class="ok" id="done" hidden></div>'}
<div id="msg" class="err" hidden></div>
<label class="drop" id="drop"><input id="file" type="file" accept="image/jpeg,image/png,image/webp" hidden><span id="pick">Tap to choose a photo</span></label>
<button class="primary full" id="send" type="button" disabled>Upload</button>
<script>
const file=document.getElementById('file'),send=document.getElementById('send'),msg=document.getElementById('msg'),done=document.getElementById('done'),pick=document.getElementById('pick');
file.addEventListener('change',()=>{const f=file.files[0];if(!f)return;send.disabled=false;pick.innerHTML='';const img=new Image();img.src=URL.createObjectURL(f);pick.appendChild(img)});
send.addEventListener('click',async()=>{
  const f=file.files[0];if(!f)return;msg.hidden=true;send.disabled=true;send.textContent='Uploading…';
  const r=await fetch(location.href,{method:'POST',headers:{'content-type':f.type||'application/octet-stream'},body:f}).catch(()=>null);
  send.textContent='Upload';
  if(r&&r.ok){done.textContent='Uploaded. Go back to Claude and tell it the photo is ready.';done.hidden=false;return}
  let text='The upload failed. Try again.';try{const d=await r.json();if(d.error)text=d.error}catch{}
  msg.textContent=text;msg.hidden=false;send.disabled=false;
});
</script>`);
}

module.exports = { errorPage, loginPage, consentPage, uploadPage, esc };
