'use strict';

// The longest prompt the app accepts (generations.js refuses longer ones).
const MAX_PROMPT_CHARS = 50000;

// 888API publishes no prompt limit. 20,000 matches what Seedance 2.5 accepts
// elsewhere (Sluice); 4,096 was the app's old blanket value for 888API.
const API888_PROMPT_CHARS = 20000;

module.exports = { MAX_PROMPT_CHARS, API888_PROMPT_CHARS };
