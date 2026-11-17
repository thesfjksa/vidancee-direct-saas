'use strict';

// The longest prompt the app accepts (generations.js refuses longer ones).
const MAX_PROMPT_CHARS = 50000;

// 888API publishes no prompt limit. 20,000 matches what Seedance 2.5 accepts
// elsewhere (Sluice); 4,096 was the app's old blanket value for 888API.
const API888_PROMPT_CHARS = 20000;

// Models 888API rejects above 8,000 ("prompt 超过最大长度 8000", 26 Oct 2026).
const API888_SHORT_PROMPT = /^seedance2\.5-301010-wool(?:-1080p)?$/;
function api888PromptLimit(id) {
  const current=require('./api888_seedance_catalog.json').models[String(id||'')];
  return current?.promptMaxChars || (API888_SHORT_PROMPT.test(String(id || '')) ? 8000 : API888_PROMPT_CHARS);
}

module.exports = { MAX_PROMPT_CHARS, API888_PROMPT_CHARS, api888PromptLimit };

