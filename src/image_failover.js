'use strict';

// Image Studio runs on the AI Gateway (Vercel) and SmartAIPI first. When one of
// them runs out of credits, its jobs move to the same model on ArgoLink. The
// customer keeps the price they were charged; only the source changes.
const { modelFamily } = require('./model_families.js');
const { quoteGateway, validateReferences } = require('./vercel_models.js');
const { smartImageModel } = require('./smartaipi_images.js');
const { listProviderModels } = require('./provider_models.js');
const { readProviderStatus } = require('./provider_usage.js');
const { logActivity } = require('./activity_log.js');

const FIRST_SOURCES = ['vercel', 'smartaipi'];

function isOutOfCredits(status, source) {
  return Number(status?.outOfCredits?.[source] || 0) > Date.now();
}

async function argoEquivalent(label) {
  const family = modelFamily(label);
  if (!family) return null;
  const models = await listProviderModels('argolink', { mediaType: 'image', enabledOnly: true, availableOnly: true });
  return models.find(m => m.ready && modelFamily(m.label) === family) || null;
}

// The same request in the ArgoLink model's terms: size and quality fall back to
// the model's defaults when it does not offer the chosen ones.
function adaptRequest(model, request) {
  const pick = (value, list, fallback) => (list?.length ? (list.includes(value) ? value : fallback) : undefined);
  const out = { ...request, aspectRatio: request.aspectRatio || request.aspect_ratio };
  out.imageSize = pick(request.imageSize, model.imageSizes, model.defaultImageSize);
  out.quality = pick(request.quality, model.qualities, model.defaultQuality);
  if (out.imageSize === undefined) delete out.imageSize;
  if (out.quality === undefined) delete out.quality;
  return out;
}

function argoActive(settings) {
  return Boolean(settings?.argoLinkEnabled && settings?.argoLinkApiKey);
}

// Web: a new request for a source that is out of credits goes to ArgoLink.
// Returns { model, body, cost } for ArgoLink, or null to keep the original source.
// A page opened before the switch still shows the first source's price, so
// the customer pays that price (cost, from firstPrice), as when the worker
// moves a job. cost is undefined when the first source cannot price it.
async function submissionFailover(db, { source, label, body, settings, access, firstPrice }) {
  if (!FIRST_SOURCES.includes(source) || !access?.argolink || !argoActive(settings)) return null;
  const status = await readProviderStatus(db).catch(() => ({}));
  if (!isOutOfCredits(status, source)) return null;
  const model = await argoEquivalent(label);
  if (!model) return null;
  const adapted = adaptRequest(model, body);
  try { validateReferences(model, adapted); quoteGateway(model, adapted, 1); } catch { return null; }
  let cost;
  try { const n = Number(firstPrice?.()); if (n > 0) cost = n; } catch {}
  return { model, body: adapted, cost };
}

function jobLabel(job) {
  if (job.provider === 'smartaipi') return smartImageModel(job.model)?.label || '';
  try { return JSON.parse(job.generation_options || '{}').model?.label || ''; } catch { return ''; }
}

// Worker: moves a claimed image job to ArgoLink and queues it there.
// Returns true when moved; false leaves the job with its original source.
async function moveImageJobToArgo(db, job, settings) {
  if (job.media_type !== 'image' || !FIRST_SOURCES.includes(job.provider) || !argoActive(settings)) return false;
  const [accessRows] = await db.execute("SELECT enabled FROM user_provider_access WHERE user_id=? AND provider='argolink'", [job.user_id]);
  if (accessRows[0] && !Number(accessRows[0].enabled)) return false;
  const model = await argoEquivalent(jobLabel(job));
  if (!model) return false;
  let saved = {};
  try { saved = JSON.parse(job.generation_options || '{}') || {}; } catch {}
  const [[refs]] = await db.query('SELECT COUNT(*) AS total FROM generation_images WHERE generation_id=?', [job.id]);
  if (Number(refs?.total || 0) > Number(model.referenceCapabilities?.image?.max || 0)) return false;
  let quote;
  try {
    quote = quoteGateway(model, adaptRequest(model, { aspectRatio: job.aspect_ratio, imageSize: saved.imageSize, quality: job.image_quality || saved.quality }), 1);
  } catch { return false; }
  const [result] = await db.execute(
    `UPDATE generations SET provider='argolink',model=?,generation_options=?,image_quality=?,provider_cost=?,provider_cost_unit='usd',
       status='queued',submitted_at=NULL,error_message=NULL,updated_at=UTC_TIMESTAMP()
     WHERE id=? AND provider=? AND status IN ('submitting','processing') AND refunded_at IS NULL`,
    [model.publicModelId, JSON.stringify({ ...quote, model }), quote.quality || null, quote.sourceUsd, job.id, job.provider],
  );
  if (result.affectedRows === 1) logActivity({ level: 'warn', category: 'provider', event: 'image.moved_to_argolink', userId: job.user_id, generationId: job.id,
    provider: job.provider, message: job.provider + ' is out of credits; moved to ArgoLink ' + model.label, details: { argoModel: model.providerModelId, sourceUsd: quote.sourceUsd } });
  return result.affectedRows === 1;
}

module.exports = { FIRST_SOURCES, isOutOfCredits, argoEquivalent, adaptRequest, submissionFailover, moveImageJobToArgo, jobLabel };
