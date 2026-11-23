'use strict';

const videoToolCopy = {
  'character-swap': {
    label: 'Character Swap', image: 'Replacement character image', clip: 'Source video',
    description: 'Replace the main person in a clip while keeping the source performance.',
  },
  'motion-control': {
    label: 'Motion Control', image: 'Character image', clip: 'Motion video',
    description: 'Animate the character in your image using the movement in a reference clip.',
  },
  'object-swap': {
    label: 'Object Swap', image: 'Replacement object image', clip: 'Source video',
    description: 'Recreate a clip with a replacement object. Clear shots and a specific object description work best.',
  },
};
const videoToolHeaders = { 'x-cmm-video-tool': '1' };
let videoToolReady = false;
let videoToolCost = null;
let videoToolQuoteVersion = 0;
let videoToolSubmitting = false;

function videoToolLabel(generation) {
  const tool = generation?.generation_options?.video_tool;
  return Object.hasOwn(videoToolCopy, tool) ? videoToolCopy[tool].label : '';
}

function renderVideoTools() {
  if (!$('video-tools').classList.contains('active')) return;
  updateGallery('videoToolsGallery', generations.filter(g => videoToolLabel(g)),
    'Your character swaps, motion clips, and object swaps will appear here.');
}

function openVideoTools() {
  if (!videoToolReady) {
    const duration = $('videoToolDuration');
    for (let seconds = 4; seconds <= 15; seconds++) duration.add(new Option(seconds + ' seconds', seconds));
    duration.value = '5';
    $('videoToolMode').addEventListener('change', updateVideoToolForm);
    duration.addEventListener('change', refreshVideoToolQuote);
    $('videoToolForm').addEventListener('submit', submitVideoTool);
    videoToolReady = true;
  }
  updateVideoToolForm();
  renderVideoTools();
}

function updateVideoToolForm() {
  const id = $('videoToolMode').value;
  const copy = videoToolCopy[id];
  const objectSwap = id === 'object-swap';
  $('videoToolDescription').textContent = copy.description;
  $('videoToolImageLabel').textContent = copy.image;
  $('videoToolClipLabel').textContent = copy.clip;
  $('videoToolPromptLabel').textContent = objectSwap ? 'Describe the object to replace' : 'Instructions (optional)';
  $('videoToolPrompt').placeholder = objectSwap ? 'For example, the green cup in the person’s hand' : '';
  $('videoToolPrompt').required = objectSwap;
  $('videoToolStartField').classList.toggle('hide', objectSwap);
  refreshVideoToolQuote();
}

async function refreshVideoToolQuote() {
  const version = ++videoToolQuoteVersion;
  videoToolCost = null;
  $('videoToolSubmit').disabled = true;
  const label = $('videoToolPrice');
  label.textContent = 'Checking price…';
  try {
    const result = await api('/api/video-tools/quote', {
      method: 'POST',
      headers: videoToolHeaders,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ tool: $('videoToolMode').value, duration: Number($('videoToolDuration').value) }),
    });
    if (version !== videoToolQuoteVersion) return;
    videoToolCost = result.cost;
    label.textContent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(result.cost) + ' credits';
    $('videoToolSubmit').disabled = videoToolSubmitting;
  } catch (error) {
    if (version === videoToolQuoteVersion) label.textContent = error.message;
  }
}

async function submitVideoTool(event) {
  event.preventDefault();
  if (videoToolSubmitting || !(videoToolCost > 0)) return;
  const form = $('videoToolForm');
  const status = $('videoToolStatus');
  const tool = $('videoToolMode').value;
  const image = $('videoToolImage').files[0];
  const clip = $('videoToolClip').files[0];
  if (!image || !clip || image.size > 5 * 1024 * 1024 || clip.size > 25 * 1024 * 1024) {
    status.className = 'msg err';
    status.textContent = 'Upload one image up to 5 MB and one MP4 up to 25 MB.';
    return;
  }
  if (me && Number(me.credits) < videoToolCost) {
    status.className = 'msg err';
    status.textContent = 'Not enough credits.';
    return;
  }
  const data = new FormData();
  const fields = {
    tool, duration: $('videoToolDuration').value, aspectRatio: $('videoToolRatio').value,
    instructions: $('videoToolPrompt').value, preserveAudio: $('videoToolAudio').checked,
    motionStart: tool === 'object-swap' ? '0' : $('videoToolStart').value,
    permission: $('videoToolPermission').checked ? 'accepted' : '',
    priceLimit: videoToolCost,
  };
  for (const [name, value] of Object.entries(fields)) data.append(name, value);
  const controls = Array.from(form.elements);
  videoToolSubmitting = true;
  controls.forEach(control => { control.disabled = true; });
  status.className = 'msg muted';
  status.textContent = 'Uploading references…';
  try {
    const direct = await uploadReferencesDirect([
      { kind: 'image', item: { file: image, filename: image.name } },
      { kind: 'video', item: { file: clip, filename: clip.name } },
    ], status);
    if (direct) {
      data.append('imageUploads', JSON.stringify([direct[0].upload]));
      data.append('videoUploads', JSON.stringify([direct[1].upload]));
    } else {
      data.append('images', image, image.name);
      data.append('videos', clip, clip.name);
    }
    status.textContent = 'Queueing video…';
    const result = await postFormWithProgress('/api/video-tools', data, (sent, total) => {
      status.textContent = sent < total ? 'Uploading references… ' + Math.round(sent / total * 100) + '%' : 'Queueing video…';
    }, videoToolHeaders);
    me = result.user;
    syncUser();
    $('videoToolImage').value = '';
    $('videoToolClip').value = '';
    $('videoToolPermission').checked = false;
    status.className = 'msg ok';
    status.textContent = videoToolCopy[tool].label + ' queued.';
    await Promise.all([loadGenerations(), loadDashboard(), loadCredits()]);
  } catch (error) {
    status.className = 'msg err';
    status.textContent = error.message;
  } finally {
    videoToolSubmitting = false;
    controls.forEach(control => { control.disabled = false; });
    refreshVideoToolQuote();
  }
}
