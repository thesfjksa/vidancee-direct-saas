'use strict';

// The CMM Tools card Claude shows in the chat (an MCP App): the job's status
// while it runs, then the finished image or a video player and a Download
// button. The card refreshes itself through get_job until the job finishes.
// When Claude checks the same job again, the older card steps aside for the
// newest one (BroadcastChannel election on the server's timestamp).

const VIEW_URI = 'ui://cmm-tools/job';
const VIEW_MIME = 'text/html;profile=mcp-app';
const APP_SDK_PATH = '/vendor/mcp-ext-apps-1.7.5.js';

function viewHtml(base) {
  const sdk = JSON.stringify(base + APP_SDK_PATH), share = JSON.stringify(base + '/media-share/');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CMM Tools</title>
<style>
html,body{margin:0;background:transparent}
body{font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:14px;color:var(--color-text-primary,light-dark(#141413,#faf9f5))}
.card{border:var(--border-width-regular,1px) solid var(--color-border-primary,light-dark(#e3e1d9,#3d3c38));border-radius:var(--border-radius-lg,12px);overflow:hidden}
.head{display:flex;align-items:center;gap:10px;padding:10px 12px}
.brand{font-weight:600;white-space:nowrap}
.meta{flex:1;min-width:0;color:var(--color-text-secondary,light-dark(#5e5d59,#b7b5a9));font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px;background:var(--color-background-secondary,light-dark(#f0eee6,#30302e));white-space:nowrap}
.chip.ok{color:light-dark(#1f7a3d,#7ad19a)} .chip.bad{color:light-dark(#b42318,#f97066)}
.media{display:grid;place-items:center;background:light-dark(#f4f3ee,#1d1c1a)}
.media img,.media video{display:block;max-width:100%;max-height:560px;width:auto;height:auto}
.wait{display:grid;place-items:center;align-content:center;gap:10px;min-height:170px;padding:16px;text-align:center;color:var(--color-text-secondary,light-dark(#5e5d59,#b7b5a9))}
.spin{width:26px;height:26px;border:3px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite;opacity:.65}
@keyframes spin{to{transform:rotate(360deg)}}
.err{padding:14px 12px;color:light-dark(#b42318,#f97066)}
.foot{display:flex;gap:8px;align-items:center;padding:10px 12px}
.foot[hidden]{display:none}
.foot .note{flex:1;color:var(--color-text-secondary,light-dark(#5e5d59,#b7b5a9));font-size:12px}
button{min-height:36px;padding:0 14px;border-radius:var(--border-radius-md,8px);border:1px solid var(--color-border-primary,light-dark(#d6d3c8,#4a4945));background:var(--color-background-primary,transparent);color:inherit;font:inherit;font-weight:600;cursor:pointer}
.old{padding:9px 12px;color:var(--color-text-secondary,light-dark(#5e5d59,#b7b5a9));font-size:13px}
</style></head>
<body><div class="card" id="card">
<div class="head"><span class="brand">CMM Tools</span><span class="meta" id="meta"></span><span class="chip" id="chip">Starting</span></div>
<div id="body" class="wait"><div class="spin"></div><div id="waitText">Starting…</div></div>
<div class="foot" id="foot" hidden><span class="note" id="note"></span><button id="dl" type="button">Download</button></div>
</div>
<script type="module">
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from ${sdk};
const SHARE = ${share};
const $ = id => document.getElementById(id);
const app = new App({ name: "CMM Tools job", version: "1.0.0" });
let job = null, key = null, superseded = false, polling = false, startedPolling = 0;
const instanceId = crypto.randomUUID();
let channel = null;

function theme(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
function el(tag, props) { return Object.assign(document.createElement(tag), props || {}); }
// argo_seedance_2_5 -> Seedance 2.5, studio_gw_recraft_recraft_v4 -> Recraft V4 (as the website names them).
function modelName(id) {
  return String(id || "").replace(/^studio_gw_[a-z0-9]+_|^argo_|^api888_/, "").replace(/_studio$/, "").replace(/(\\d)_(?=\\d)/g, "$1.")
    .split("_").filter(Boolean).map(w => w === "gpt" ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function minutes(since) {
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
}

function render() {
  if (superseded) {
    $("card").replaceChildren(el("div", { className: "old", textContent: "CMM Tools · this job is shown in a newer card below." }));
    return;
  }
  if (!job) return;
  const kind = job.kind === "upscale" ? "Upscale" : job.media_type === "image" ? "Image" : "Video";
  $("meta").textContent = [kind, modelName(job.model), job.resolution, job.aspect_ratio, job.duration_seconds ? job.duration_seconds + " s" : ""].filter(Boolean).join(" · ");
  const chip = $("chip"), body = $("body"), foot = $("foot");
  const done = job.status === "completed" && typeof job.download_url === "string" && job.download_url.startsWith(SHARE);
  if (done) {
    chip.textContent = "Ready"; chip.className = "chip ok";
    if (!body.dataset.url || body.dataset.url !== job.download_url) {
      body.className = "media"; body.dataset.url = job.download_url;
      const media = job.media_type === "image"
        ? el("img", { src: job.download_url, alt: job.prompt || "Generated image" })
        : el("video", { src: job.download_url, controls: true, playsInline: true, preload: "metadata" });
      body.replaceChildren(media);
    }
    $("note").textContent = job.credits_charged + " credits · link valid " + (job.download_link_expires || "7 days");
    foot.hidden = false;
  } else if (job.finished) {
    chip.textContent = job.refunded ? "Refunded" : "Failed"; chip.className = "chip bad";
    body.className = "err"; body.textContent = job.message || "This job did not finish.";
    foot.hidden = true;
  } else {
    chip.textContent = "Generating"; chip.className = "chip";
    body.className = "wait";
    if (!$("waitText")) body.replaceChildren(el("div", { className: "spin" }), el("div", { id: "waitText" }));
    $("waitText").textContent = (job.media_type === "image" ? "Creating your image… " : "Creating your video… usually 2–10 minutes. ") + (job.created_at ? minutes(job.created_at) + " so far" : "");
    foot.hidden = true;
  }
}

async function poll() {
  if (polling) return;
  polling = true; startedPolling = Date.now();
  while (job && !job.finished && !superseded && Date.now() - startedPolling < 30 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const result = await app.callServerTool({ name: "get_job", arguments: { job_id: job.job_id } });
      if (result?.structuredContent?.job_id === job.job_id) { job = result.structuredContent; render(); }
    } catch { /* keep the last state and try again */ }
  }
  polling = false;
}

function elect() {
  if (!job || !key) return;
  if (!channel) {
    channel = new BroadcastChannel("cmm-tools-job-" + job.job_id);
    channel.onmessage = ev => {
      const m = ev.data;
      if (!m || m.instanceId === instanceId || !key) return;
      if (m.type === "hello") channel.postMessage({ type: "born", instanceId, key });
      const younger = m.key.createdAt !== key.createdAt ? m.key.createdAt > key.createdAt : (m.key.seq !== key.seq ? m.key.seq > key.seq : m.instanceId > instanceId);
      if (younger && !superseded) { superseded = true; render(); }
    };
  }
  channel.postMessage({ type: "hello", instanceId, key });
}

app.ontoolresult = params => {
  const sc = params?.structuredContent;
  if (!sc?.job_id) {
    const text = params?.content?.find?.(c => c.type === "text")?.text || "The request did not start a job.";
    $("chip").textContent = "Not started"; $("chip").className = "chip bad";
    $("body").className = "err"; $("body").textContent = text;
    return;
  }
  job = sc; key = sc.view || { createdAt: Date.now(), seq: 0 };
  render(); elect();
  if (!job.finished) poll();
};
app.onhostcontextchanged = theme;
$("dl").onclick = async () => {
  if (!job?.download_url) return;
  try {
    const r = await app.downloadFile({ contents: [{ type: "resource_link", uri: job.download_url, name: "cmm-tools-" + job.job_id.slice(0, 8) + (job.media_type === "image" ? ".png" : ".mp4"), mimeType: job.media_type === "image" ? "image/png" : "video/mp4" }] });
    if (r?.isError) throw new Error("download refused");
  } catch { await app.openLink({ url: job.download_url }).catch(() => {}); }
};
setInterval(() => { if (job && !job.finished && !superseded) render(); }, 1000);
await app.connect();
theme(app.getHostContext());
</script></body></html>`;
}

function viewResource(base) {
  return {
    uri: VIEW_URI,
    mimeType: VIEW_MIME,
    text: viewHtml(base),
    _meta: { ui: { prefersBorder: false, csp: { resourceDomains: [base, 'https://assets.claude.ai'] } } },
  };
}

const VIEW_LISTING = { uri: VIEW_URI, name: 'CMM Tools job', title: 'CMM Tools job', description: 'Shows a CMM Tools job and its finished image or video.', mimeType: VIEW_MIME };

module.exports = { VIEW_URI, VIEW_MIME, APP_SDK_PATH, viewHtml, viewResource, VIEW_LISTING };
