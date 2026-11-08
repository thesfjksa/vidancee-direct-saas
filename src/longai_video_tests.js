'use strict';

const SNAPSHOT_DATE = '2026-11-08';
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,190}$/i;
const SNAPSHOT_IDS = [
  'flux-3-video', 'hailuo-03', 'hailuo-2_3', 'hailuo-2_3-fast', 'happy-horse', 'happy-horse-1.1',
  'kling-2.5', 'kling-2.5-turbo-standard', 'kling-2.6', 'kling-3.0', 'kling-3.0-turbo',
  'kling-video-o-1', 'kling-video-v3-omni', 'ltxv-2.3-fast', 'ltxv-2.3-pro',
  'minimax-h3', 'minimax-h3-max', 'motion_2.0', 'motion_2.0-fast',
  'seedance-1.0-pro', 'seedance-1.0-pro-fast', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedance-2.5',
  'veo-3.1-fast-generate-001', 'veo-3.1-generate-001', 'veo-3.1-lite', 'wan-2.6', 'wan-2.7', 'wan-3.0',
];

function cellText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&mdash;|&#8212;|&#x2014;/gi, '—').trim();
}

function parseVideoMarketplace(html) {
  const headings = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const video = headings.findIndex(heading => /^(?:视频生成|video generation\b)/i.test(cellText(heading[1])));
  if (video < 0) throw new Error('LONG AI video marketplace section was not found.');
  const heading = headings[video];
  const section = html.slice(heading.index + heading[0].length, headings[video + 1]?.index);
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(section)?.[1];
  if (!table || !/供货卖家|suppliers|sellers/i.test(table)) {
    throw new Error('LONG AI video supplier table was not found.');
  }

  const models = new Map();
  for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cellText(cell[1]));
    if (!cells.length) continue;
    const [id, , supplierCount] = cells;
    const sellers = /^(?:—|–|-)$/u.test(supplierCount) ? 0 :
      /^\d{1,4}$/.test(supplierCount) ? Number(supplierCount) : NaN;
    if (!MODEL_ID.test(id) || !Number.isInteger(sellers)) {
      throw new Error('LONG AI video supplier table has an unexpected format.');
    }
    // One model can have multiple protocol rows. Avoid double-counting sellers.
    models.set(id, Math.max(sellers, models.get(id) || 0));
  }
  if (!models.size) throw new Error('LONG AI video supplier table is empty.');
  return Array.from(models, ([id, sellers]) => ({ id, sellers }));
}

async function loadVideoMarketplace(client) {
  try {
    const models = parseVideoMarketplace(await client.videoMarketplace());
    return { models, source: 'marketplace', fetchedAt: new Date().toISOString() };
  } catch {
    const models = SNAPSHOT_IDS.map(id => ({ id, sellers: id === 'kling-video-o-1' ? 2 : 1 }));
    return { models, source: 'snapshot', snapshotDate: SNAPSHOT_DATE };
  }
}

async function checkVideoModel(client, id) {
  if (!MODEL_ID.test(id || '')) {
    throw Object.assign(new Error('Enter a valid LONG AI model ID.'), { statusCode: 400 });
  }
  const started = Date.now();
  try {
    await client.verifyModel(id, 12000);
    return { id, status: 'visible', elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      id,
      status: error.providerStatus === 401 ? 'key_rejected' :
        [403, 404].includes(error.providerStatus) || error.statusCode === 400 ? 'not_visible' : 'error',
      providerStatus: error.providerStatus,
      networkCode: error.networkCode,
      elapsedMs: Date.now() - started,
    };
  }
}

module.exports = { parseVideoMarketplace, loadVideoMarketplace, checkVideoModel, MODEL_ID };
