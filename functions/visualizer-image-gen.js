/**
 * NBD — Visualizer Image Generation (FLUX.1 Kontext Max via Replicate)
 * ═══════════════════════════════════════════════════════════════
 *
 * Generates a real AI-edited image of the user's home showing their
 * selected roofing / siding / gutter choices. ~$0.08 per call via
 * Replicate's FLUX.1 Kontext Max model.
 *
 * Why this model: we started with Gemini 2.5 Flash Image ("Nano
 * Banana") but it refused to commit to material swaps (asphalt →
 * metal came back as tinted asphalt, no matter how aggressive the
 * prompt). FLUX.1 Kontext Max is purpose-built for image editing
 * and consistently commits to substantive changes — including
 * material and texture swaps on real architectural photos.
 *
 * The Claude-based text analysis (publicVisualizerAI in index.js)
 * still runs in parallel — it returns Joe's written assessment.
 * This function just returns the edited image.
 *
 * Safety:
 *   - Gated by VISUALIZER_IMAGEGEN_ENABLED env flag (default OFF).
 *     When disabled, returns 503 and frontend falls back to the
 *     legacy canvas color filter.
 *   - Rate limit 15/hour per IP during initial tuning; tighten to
 *     5/hour after launch (~$0.40/hour worst case per abuser).
 *
 * Model swap history:
 *   2026-04-18: Gemini 2.5 Flash Image (too conservative, color-only)
 *   2026-04-18: FLUX.1 Kontext Max via Replicate (current default)
 *   2026-08-05: kie.ai added as a flag-gated ALTERNATE provider for the
 *               same Flux Kontext models (IMAGEGEN_PROVIDER=kie).
 *   2026-10-04: kie.ai removed — its key was never set, so it never ran.
 *               Replicate is the one provider, still behind the
 *               VISUALIZER_IMAGEGEN_ENABLED flag (default OFF).
 *               documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md, Lane C.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');

// Shared with other functions — re-use the same rate limiter
const { httpRateLimit } = require('./rate-limit');

// ───────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────

// New secret for the Replicate backend.
//
// CORRECTION 2026-09-05: this used to say GOOGLE_AI_API_KEY "stays declared
// elsewhere in case a future feature uses Gemini again". It is not declared
// anywhere — no defineSecret() in functions/ references it, so no function
// can load it. The secret still EXISTS in Secret Manager (2 versions, v1
// disabled) where it costs ~$0.06/version/month and is one more credential
// with no owner. The Gemini API is not even enabled on nobigdeal-pro.
// If Gemini is ever wanted again it needs a fresh defineSecret() and the
// API enabled, so the secret is not "kept ready" for anything — delete it.
const REPLICATE_API_TOKEN = defineSecret('REPLICATE_API_TOKEN');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Replicate model selection.
//
// Two-tier strategy (per Joe, 2026-04-28): shingle edits go through
// flux-kontext-max because granule/shadow texture survives the round-trip
// noticeably better there; everything else (metal roofs, siding-only,
// gutter swaps) stays on flux-kontext-pro to control cost.
//
// Model             Approx cost   Notes
// flux-kontext-pro  ~$0.04/img    Default for non-shingle edits
// flux-kontext-max  ~$0.08/img    Default for shingle edits (NS/HDZ/UHDZ/Camelot II)
//
// Both env vars below override the defaults — useful for cost-tuning
// without a redeploy.
//   FLUX_MODEL          → overrides the non-shingle / fallback model
//   FLUX_SHINGLE_MODEL  → overrides the shingle-specific model
const DEFAULT_BASE_MODEL    = 'black-forest-labs/flux-kontext-pro';
const DEFAULT_SHINGLE_MODEL = 'black-forest-labs/flux-kontext-max';

function replicateEndpoint(modelOverride) {
  const model = modelOverride || process.env.FLUX_MODEL || DEFAULT_BASE_MODEL;
  return 'https://api.replicate.com/v1/models/' + model + '/predictions';
}

function pickModelForSelections(selections) {
  const structuredLine = selections.structured && selections.structured.roof && selections.structured.roof.line;
  const lineId = structuredLine || (selections.roofStyle === 'metal' ? 'metal' : null);
  const isMetal = lineId === 'metal' || selections.roofStyle === 'metal';
  const shinglesPicked = !!selections.features && selections.features.includes('roof') && !isMetal;
  if (shinglesPicked) {
    return process.env.FLUX_SHINGLE_MODEL || DEFAULT_SHINGLE_MODEL;
  }
  return process.env.FLUX_MODEL || DEFAULT_BASE_MODEL;
}

// Max input image — match the text endpoint's cap so the frontend can
// use one resize path for both requests.
const MAX_B64_BYTES = 1_500_000; // ~1.1 MB raw before base64 inflation

// Prompt fragments for each material/style option. Kept as a dict so
// unknown selections fall back cleanly instead of leaking raw tile IDs
// into the prompt.

// Each style/color label includes (a) the human-readable material name
// and (b) an explicit hex color so FLUX can't drift from the target.
// Hexes are picked to match the swatches shown in the UI.

// ── Per-line shingle texture descriptions ─────────────────────────
// Why per-line: collapsing NS, HDZ, and UHDZ to a single "architectural"
// prompt was producing weak / under-edited shingle results — FLUX would
// often just tint the existing roof. Each line below gets its own
// signature texture cues so the model commits to a believable swap.
const ROOF_LINE_PROFILES = {
  'timberline-ns': {
    label: 'GAF Timberline Natural Shadow (NS) architectural laminated asphalt shingles',
    texture:
      'The new surface is laminated architectural asphalt shingles with subtle dimensional ' +
      'shadow lines between courses, uniform dragon-tooth tabs, and a clean staggered cut ' +
      'pattern — a clear step up from flat 3-tab but more understated than HDZ. Show ' +
      'individual granules and crisp horizontal course lines.',
  },
  'timberline-hdz': {
    label: 'GAF Timberline HDZ architectural laminated asphalt shingles',
    texture:
      'The new surface is laminated architectural asphalt shingles with deep, well-defined ' +
      'shadow lines between every course, thick double-laminated tabs, the signature ' +
      'high-definition dragon-tooth profile, and a distinctly dimensional look. Show ' +
      'visible granule texture, crisp course lines, ridge cap shingles at the peak, and ' +
      'clean cuts at hips and valleys.',
  },
  'timberline-uhdz': {
    label: 'GAF Timberline UHDZ premium architectural shingles, Class 4 impact-rated (UL 2218)',
    texture:
      'The new surface is premium ultra-dimensional laminated architectural shingles with ' +
      'extra-thick tabs, an exaggeratedly deep shadow band between courses, a wider exposure ' +
      'than standard HDZ, and a noticeably heavier, more sculpted profile that reads as ' +
      'high-end. Show the heavier shadow lines, dense granule texture, and ridge cap detail.',
  },
  'camelot-2': {
    label: 'GAF Camelot II designer slate-look dimensional luxury asphalt shingles',
    texture:
      'The new surface is designer slate-look luxury asphalt shingles arranged in a layered, ' +
      'irregular staggered pattern that mimics natural slate — varying tab widths, scalloped ' +
      'or saw-tooth bottom edges, deep dimensional shadows, and subtle color variation between ' +
      'individual tabs. Definitively NOT uniform horizontal courses; this must read as ' +
      'high-end designer shingle, not standard architectural.',
  },
  metal: {
    label: 'standing-seam metal roofing panels (NOT metal shingles — flat panels with raised seams)',
    texture:
      'The new surface is smooth, flat metal panels with visible STANDING SEAMS running ' +
      'continuously down each slope from ridge to eave, crisp ridge cap trim, and clean drip ' +
      'edges — NOT asphalt shingle courses. If the input photo shows asphalt shingles, those ' +
      'must be entirely replaced with flat metal panels. The surface must read as metal, not ' +
      'as tinted shingles.',
  },
};

// Legacy roof-style → line-id mapping for the original (pre-structured)
// request format. The new request shape sends `selections.roof.line`
// directly; this fallback only fires when the frontend hasn't been updated.
const LEGACY_ROOFSTYLE_TO_LINE = {
  architectural: 'timberline-hdz',
  '3-tab': 'timberline-ns',
  luxury: 'camelot-2',
  metal: 'metal',
  slate: 'camelot-2',
};

// Fallback only — used when the frontend doesn't send a hex in the
// structured `selections.roof` payload. The frontend (visualizer.html)
// now ships hex straight through, so this table only catches stale
// clients or non-roof color requests.
const ROOF_COLOR_LABELS = {
  charcoal:        { name: 'charcoal black-gray',       hex: '#3a3a3a' },
  'weathered-wood':{ name: 'weathered-wood warm brown', hex: '#5c4a3a' },
  driftwood:       { name: 'driftwood tan',             hex: '#8b7355' },
  onyx:            { name: 'deep onyx black',           hex: '#1a1a1a' },
  sand:            { name: 'sand beige',                hex: '#c8b89a' },
  pewter:          { name: 'pewter gray',               hex: '#6b7280' },
  'rustic-red':    { name: 'rich rustic barn red',      hex: '#8b3a3a' },
  'hunter-green':  { name: 'deep hunter green',         hex: '#3d5a3e' },
};

const SIDING_STYLE_LABELS = {
  'dutch-lap': 'dutch-lap vinyl siding',
  'board-batten': 'board-and-batten vertical siding',
  shake: 'cedar-shake-style siding',
  horizontal: 'horizontal lap siding',
  'fiber-cement': 'James Hardie fiber-cement lap siding',
};

const SIDING_COLOR_LABELS = {
  cream:          { name: 'warm cream',         hex: '#f5f0e8' },
  linen:          { name: 'soft linen white',   hex: '#e8e0d0' },
  'slate-gray':   { name: 'slate gray',         hex: '#6b7280' },
  'charcoal-blue':{ name: 'charcoal blue-gray', hex: '#374151' },
  navy:           { name: 'deep navy blue',     hex: '#1a3057' },
  cedar:          { name: 'cedar brown',        hex: '#78350f' },
  forest:         { name: 'forest green',       hex: '#065f46' },
  black:          { name: 'matte black',        hex: '#1c1917' },
};

const GUTTER_COLOR_LABELS = {
  white:        { name: 'crisp white',            hex: '#ffffff' },
  bronze:       { name: 'dark bronze',            hex: '#3c2a20' },
  black:        { name: 'matte black',            hex: '#1c1917' },
  brown:        { name: 'warm brown',             hex: '#57392a' },
  'match-trim': { name: 'a color matching trim',  hex: null },
};

function sanitizeString(value, maxLen = 400) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function resolveColor(map, key, fallbackKey) {
  return map[key] || (fallbackKey ? map[fallbackKey] : null) || { name: key || 'neutral', hex: null };
}

// Resolve the roof line + color for the prompt. Prefers the structured
// `selections.roof` payload (line id + colorName + hex + blend sent
// straight from the frontend's VIZ_OPTIONS), falls back to legacy
// roofStyle/roofColor fields for older clients. The `blend` field is
// the multi-tone granule description the frontend now ships for every
// color; without it FLUX renders shingles as a flat painted-looking
// tone instead of the real granule mix.
function resolveRoofLineAndColor(selections) {
  const structured = selections.structured && selections.structured.roof;

  let lineId = (structured && structured.line) || LEGACY_ROOFSTYLE_TO_LINE[selections.roofStyle] || 'timberline-hdz';
  if (!ROOF_LINE_PROFILES[lineId]) lineId = 'timberline-hdz';
  const profile = ROOF_LINE_PROFILES[lineId];

  let colorName, colorHex, blend;
  if (structured && structured.colorName) {
    colorName = structured.colorName;
    colorHex  = structured.hex || null;
    blend     = structured.blend || '';
  } else {
    const fallback = resolveColor(ROOF_COLOR_LABELS, selections.roofColor, 'charcoal');
    colorName = fallback.name;
    colorHex  = fallback.hex;
    blend     = '';
  }

  return { lineId, profile, colorName, colorHex, blend };
}

function buildPrompt(selections) {
  const instructions = [];

  if (selections.features.includes('roof')) {
    const { lineId, profile, colorName, colorHex, blend } = resolveRoofLineAndColor(selections);
    const hexClause = colorHex ? ` (target color ${colorHex})` : '';
    const isMetal = lineId === 'metal';

    // Three-section prompt layout: ACTION, COLOR, TEXTURE. FLUX Kontext
    // commits harder to material+color edits when the prompt is sectioned
    // — when a single run-on sentence mixes "in color X with texture Y"
    // the model averages everything into a flat tinted version of the
    // input. Sectioning forces it to satisfy each constraint.
    let block = `RE-ROOF THIS HOUSE: Completely replace every visible section of the existing roof with brand-new ${profile.label} in ${colorName}${hexClause}.\n\n`;

    if (blend) {
      block += `COLOR DETAIL — ${colorName}: ${blend}. ` +
               (isMetal
                 ? 'The painted-metal panels must show this exact tone uniformly across every panel, with realistic painted-metal sheen rather than a flat color filter.'
                 : 'The shingle granule mix MUST show this multi-tone variation — never a uniform painted look. Preserve the granule blend; do not average it to a single flat tone. Color should match a freshly-installed real shingle photographed in natural daylight.') +
               '\n\n';
    }

    block += `TEXTURE — ${profile.texture}\n\n`;

    block += isMetal
      ? 'INSTALLATION: The standing-seam panels must be unmistakable — parallel raised seams running ridge-to-eave, smooth painted-metal sheen, crisp drip edges along the eaves, and a continuous ridge cap. Replace EVERY visible roof slope (main, dormers, porch, side, rear) with the new metal panels.'
      : 'INSTALLATION: Replace EVERY visible inch of the old roof — main slopes, dormers, porch roof, any side or rear slopes visible in the photo. Show actual granule grain, course-by-course shingle tabs with deep dimensional shadow lines, ridge cap shingles at every peak, and clean cuts at hips and valleys. Do NOT tint or color-shift the existing shingles; the old material must be entirely replaced with freshly installed new shingle.';

    instructions.push(block);
  }

  if (selections.features.includes('siding')) {
    const structured = selections.structured && selections.structured.siding;
    const styleKey = (structured && structured.style) || selections.sidingStyle;
    const style = SIDING_STYLE_LABELS[styleKey] || 'horizontal lap siding';
    let colorName, colorHex, blend;
    if (structured && structured.colorName) {
      colorName = structured.colorName;
      colorHex  = structured.hex || null;
      blend     = structured.blend || '';
    } else {
      const fallback = resolveColor(SIDING_COLOR_LABELS, selections.sidingColor, 'cream');
      colorName = fallback.name;
      colorHex  = fallback.hex;
      blend     = '';
    }
    const hexClause = colorHex ? ` (target color ${colorHex})` : '';
    let block = `RE-SIDE THIS HOUSE: Replace every exterior wall with brand-new ${style} in ${colorName}${hexClause}.\n\n`;
    if (blend) {
      block += `COLOR DETAIL — ${colorName}: ${blend}. The painted siding must show this exact tone uniformly across every wall — clean and saturated, not faded or filtered.\n\n`;
    }
    block += 'INSTALLATION: Show every panel line, every trim transition, and consistent color saturation across every wall. The siding change must be clearly visible — replace the existing siding entirely, do not tint it.';
    instructions.push(block);
  }

  if (selections.features.includes('gutters')) {
    const structured = selections.structured && selections.structured.gutters;
    let colorName, colorHex, blend;
    if (structured && structured.colorName) {
      colorName = structured.colorName;
      colorHex  = structured.hex || null;
      blend     = structured.blend || '';
    } else {
      const fallback = resolveColor(GUTTER_COLOR_LABELS, selections.gutterColor, 'white');
      colorName = fallback.name;
      colorHex  = fallback.hex;
      blend     = '';
    }
    const hexClause = colorHex ? ` (target color ${colorHex})` : '';
    instructions.push(
      `Replace the gutters and downspouts with clean seamless K-style in ${colorName}${hexClause}.` +
      (blend ? ` ${blend}.` : '')
    );
  }

  if (selections.features.includes('windows')) instructions.push('Freshen the window frames with clean modern trim.');
  if (selections.features.includes('garage'))  instructions.push('Update the garage door to a modern paneled design (same size and placement).');
  if (selections.features.includes('shutters'))instructions.push('Add or refresh exterior shutters in a color that complements the new trim.');
  if (selections.features.includes('doors'))   instructions.push('Freshen the front door with a color that complements the new exterior palette.');

  if (!instructions.length) {
    instructions.push('No specific exterior changes were selected — return the image essentially unchanged.');
  }

  const notes = sanitizeString(selections.notes, 300);
  if (notes) instructions.push(`Homeowner\'s extra notes: ${notes}`);

  // Keep-unchanged list is kept TIGHT — we only call out the things
  // Gemini might otherwise re-invent (sky, vehicles, neighboring homes).
  // We intentionally do NOT say "preserve every detail" — that wording
  // made 2.5 Flash Image under-edit the roof.
  const keepUnchanged = [
    'The house\'s silhouette, window placement, door placement, and overall geometry.',
    'The sky, trees, lawn, driveway, sidewalks, vehicles, and any neighboring properties or power lines.',
    'The camera angle, perspective, and time of day (same sun direction, same shadows).',
    'Any people or pets visible in the photo.',
  ];

  const outputRules = [
    'Output ONE photorealistic image showing the SAME house from the SAME angle, with the exterior changes above actually performed — not a color filter, not a tint, actually re-roofed / re-sided.',
    'Do not add watermarks, logos, text, signage, or floating labels.',
    'Keep the result believable. Match lighting, shadow direction, and material realism so it looks like a professional photograph.',
  ];

  return [
    'You are generating an exterior-remodel preview for a real homeowner. They want to see what their house would look like after the following renovation work:',
    '',
    instructions.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    '',
    'Keep the following unchanged from the input photo:',
    keepUnchanged.map((s) => `- ${s}`).join('\n'),
    '',
    'Output rules:',
    outputRules.map((s) => `- ${s}`).join('\n'),
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────
// Provider
// ───────────────────────────────────────────────────────────────
// Returns { imgBuf, outMediaType } or throws { httpStatus, token }-shaped
// errors the endpoint maps onto its existing error contract.

function _provErr(httpStatus, token, extra) {
  const e = new Error(token);
  e.httpStatus = httpStatus;
  e.token = token;
  e.extra = extra || {};
  return e;
}

// Replicate: single POST with Prefer: wait — the original path, unchanged.
async function generateViaReplicate(prompt, inputDataUrl, model) {
  const replicateBody = {
    input: {
      prompt,
      input_image: inputDataUrl,
      aspect_ratio: 'match_input_image',
      output_format: 'jpg',
      safety_tolerance: 2,
    },
  };

  const response = await fetch(replicateEndpoint(model), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + REPLICATE_API_TOKEN.value(),
      // Replicate returns as soon as the prediction completes OR after
      // this many seconds, whichever comes first. FLUX Kontext Max
      // typically returns in 8-15s.
      'Prefer': 'wait=60',
    },
    body: JSON.stringify(replicateBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.warn('visualizerImageGen: upstream error', {
      provider: 'replicate', status: response.status, body: errText.slice(0, 2000),
    });
    throw _provErr(502, 'upstream_error', { upstream_status: response.status });
  }

  const data = await response.json();

  // When Prefer: wait completes within the window, status is 'succeeded'
  // and output contains the result. If the model took longer than 60s, we
  // get 'processing' and would need to poll (we don't — timeout).
  if (data.status !== 'succeeded') {
    logger.warn('visualizerImageGen: not succeeded', {
      provider: 'replicate', status: data.status, error: data.error,
    });
    throw _provErr(504, 'prediction_timeout_or_failed', { prediction_status: data.status });
  }

  // FLUX Kontext returns output as either a string URL or an array with
  // one URL. Normalize.
  const output = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!output || typeof output !== 'string') {
    logger.warn('visualizerImageGen: no output in response', {
      provider: 'replicate', outputType: typeof output, keys: Object.keys(data),
    });
    throw _provErr(502, 'no_image_returned');
  }

  const imgResp = await fetch(output);
  if (!imgResp.ok) {
    logger.warn('visualizerImageGen: output fetch failed', {
      provider: 'replicate', status: imgResp.status, url: output,
    });
    throw _provErr(502, 'output_fetch_failed');
  }
  const imgBuf = Buffer.from(await imgResp.arrayBuffer());
  const outMediaType = imgResp.headers.get('content-type') || 'image/jpeg';
  return { imgBuf, outMediaType };
}

// ───────────────────────────────────────────────────────────────
// visualizerImageGen — HTTP endpoint
// ───────────────────────────────────────────────────────────────
//
// Request body:
//   {
//     imageBase64:  string (required, raw b64 no data-URL prefix),
//     mediaType:    'image/jpeg' | 'image/png' | 'image/webp',
//     features:     string[],  // ['roof','siding','gutters','windows','garage','shutters','doors']
//     roofStyle:    string,
//     roofColor:    string,
//     sidingStyle:  string,
//     sidingColor:  string,
//     gutterColor:  string,
//     notes?:       string
//   }
//
// Response (success):
//   { imageBase64: string, mediaType: 'image/png' }
//
// Response (error):
//   { error: 'descriptive_token' }  — HTTP 400 | 413 | 429 | 503 | 500

exports.visualizerImageGen = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [REPLICATE_API_TOKEN],
    maxInstances: 5,
    concurrency: 10,
    timeoutSeconds: 120, // Replicate sync wait can take up to 60s + our own overhead
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // Feature flag — keeps this off until Joe confirms quality + cost
    if (process.env.VISUALIZER_IMAGEGEN_ENABLED !== 'true') {
      res.status(503).json({ error: 'disabled' });
      return;
    }

    // Global AI kill-switch (Audit #4) — emergency halt without a deploy.
    if (await require('./integrations/killswitch').isAiDisabled()) {
      res.status(503).json({ error: 'ai_disabled' });
      return;
    }

    // Rate limit per IP: 5 calls per hour. Image gen via FLUX Kontext Pro
    // is ~$0.04/call, so a pegged attacker caps at ~$0.20/hour per IP.
    // Tuning mode (15/hr) was used during launch; safe to tighten now
    // that quality is confirmed.
    if (!(await httpRateLimit(req, res, 'visualizerImageGen:ip', 5, 3_600_000))) return;

    try {
      const body = req.body || {};
      const imageBase64 = sanitizeString(body.imageBase64, MAX_B64_BYTES * 2);
      if (!imageBase64 || imageBase64.length === 0) {
        res.status(400).json({ error: 'imageBase64 required' });
        return;
      }
      if (imageBase64.length > MAX_B64_BYTES) {
        res.status(413).json({ error: 'image_too_large' });
        return;
      }

      const allowedMedia = new Set(['image/jpeg', 'image/png', 'image/webp']);
      const mediaType = allowedMedia.has(body.mediaType) ? body.mediaType : 'image/jpeg';

      // Sanitize the structured `selections` block the new frontend sends.
      // Only the fields the prompt builder actually reads are kept. Hex
      // values are validated against #RRGGBB to keep us from injecting
      // arbitrary text into the FLUX prompt via the colorHex field. Blend
      // descriptions are length-capped + stripped of newlines so they
      // can't break out of their prompt section.
      const HEX_RE = /^#[0-9a-fA-F]{6}$/;
      function sanHex(v) { return typeof v === 'string' && HEX_RE.test(v) ? v : null; }
      function sanBlend(v) {
        if (typeof v !== 'string') return '';
        // Strip newlines and clamp length — blends are sentence fragments
        // describing granule tones; ~240 chars is plenty.
        return v.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
      }
      const rawStructured = (body.selections && typeof body.selections === 'object') ? body.selections : {};
      const structured = {
        roof: rawStructured.roof ? {
          line:      sanitizeString(rawStructured.roof.line, 40),
          colorName: sanitizeString(rawStructured.roof.colorName, 60),
          hex:       sanHex(rawStructured.roof.hex),
          blend:     sanBlend(rawStructured.roof.blend),
        } : null,
        siding: rawStructured.siding ? {
          style:     sanitizeString(rawStructured.siding.style, 40),
          colorName: sanitizeString(rawStructured.siding.colorName, 60),
          hex:       sanHex(rawStructured.siding.hex),
          blend:     sanBlend(rawStructured.siding.blend),
        } : null,
        gutters: rawStructured.gutters ? {
          colorName: sanitizeString(rawStructured.gutters.colorName, 60),
          hex:       sanHex(rawStructured.gutters.hex),
          blend:     sanBlend(rawStructured.gutters.blend),
        } : null,
      };

      const selections = {
        features: Array.isArray(body.features) ? body.features.slice(0, 10).map((s) => sanitizeString(s, 40)) : ['roof'],
        roofStyle:   sanitizeString(body.roofStyle, 40),
        roofColor:   sanitizeString(body.roofColor, 40),
        sidingStyle: sanitizeString(body.sidingStyle, 40),
        sidingColor: sanitizeString(body.sidingColor, 40),
        gutterColor: sanitizeString(body.gutterColor, 40),
        notes:       sanitizeString(body.notes, 300),
        structured,
      };

      const prompt = buildPrompt(selections);
      const modelForRequest = pickModelForSelections(selections);

      const inputDataUrl = 'data:' + mediaType + ';base64,' + imageBase64;
      const result = await generateViaReplicate(prompt, inputDataUrl, modelForRequest);

      res.json({
        imageBase64: result.imgBuf.toString('base64'),
        mediaType: result.outMediaType,
      });
    } catch (e) {
      // Typed provider errors keep the original per-condition contract.
      if (e && e.httpStatus && e.token) {
        res.status(e.httpStatus).json(Object.assign({ error: e.token }, e.extra));
        return;
      }
      logger.error('visualizerImageGen error', { err: e && e.message, stack: e && e.stack });
      res.status(500).json({ error: 'server_error' });
    }
  }
);
