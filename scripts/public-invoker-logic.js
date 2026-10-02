/**
 * scripts/public-invoker-logic.js — pure rules for the weekly public-invoker
 * watch (scripts/check-public-invoker.mjs, .github/workflows/invoker-watch.yml).
 *
 * Gen2 functions run on Cloud Run, which checks IAM before any code runs. A
 * browser-facing function (onRequest or onCall) needs allUsers →
 * roles/run.invoker; the handler does the real auth. Without the binding,
 * every browser request is a 403 that never reaches the function's logs.
 * Four had lost it by 2026-10-02 (documentation/audit/PUBLIC-INVOKER-SWEEP-
 * 2026-10-02.md), including cspReport (261/261 reports refused) and the
 * extractReceiptData callable, which no code change can re-grant.
 *
 * No network here. The checker supplies the endpoint list and the policies.
 */
'use strict';

/**
 * Exported functions → the ones that must be public. Takes the module
 * exports of functions/index.js; each Gen2 function carries __endpoint. A
 * function opts out with an `invoker` that is not public (none do today).
 */
function browserFacing(exportsObj) {
  const out = [];
  for (const [name, fn] of Object.entries(exportsObj || {})) {
    const ep = fn && fn.__endpoint;
    if (!ep) continue;
    if (ep.httpsTrigger) {
      const inv = ep.httpsTrigger.invoker;
      if (Array.isArray(inv) && inv.length && !inv.includes('public')) continue; // deliberately private
      out.push({ name, service: name.toLowerCase(), kind: 'https' });
    } else if (ep.callableTrigger) {
      out.push({ name, service: name.toLowerCase(), kind: 'callable' });
    }
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

/** An IAM policy (Cloud Run v2 getIamPolicy JSON) grants allUsers run.invoker. */
function isPublic(policy) {
  return !!policy && Array.isArray(policy.bindings) && policy.bindings.some(
    (b) => b && b.role === 'roles/run.invoker' && Array.isArray(b.members) && b.members.includes('allUsers'));
}

/**
 * Judge every browser-facing function.
 *   results: { [service]: { policy } | { error } | { missingService: true } }
 * → { ok, notPublic: [...], errors: [...], missingService: [...] }
 * An API error is an ERROR, never "not public" (2026-10-02: a gcloud value()
 * format that printed nothing made 205 of 223 services look private).
 */
function judge(functions, results) {
  const notPublic = [], errors = [], missingService = [];
  for (const f of functions) {
    const r = results[f.service];
    if (!r) { errors.push({ ...f, error: 'no result' }); continue; }
    if (r.missingService) { missingService.push(f); continue; }
    if (r.error) { errors.push({ ...f, error: String(r.error).slice(0, 160) }); continue; }
    if (!isPublic(r.policy)) notPublic.push(f);
  }
  return { ok: notPublic.length === 0 && errors.length === 0, checked: functions.length, notPublic, errors, missingService };
}

/** The fix to print for each function that is not public. */
function fixFor(f, { project = 'nobigdeal-pro', region = 'us-central1' } = {}) {
  const grant = `gcloud run services add-iam-policy-binding ${f.service} --region ${region} --project ${project} --member=allUsers --role=roles/run.invoker`;
  return f.kind === 'https'
    ? `declare invoker: 'public' in its onRequest options (every deploy re-applies it), or one-off: ${grant}`
    : `onCall ignores invoker in code; one-off (production IAM write, owner's OK): ${grant}`;
}

module.exports = { browserFacing, isPublic, judge, fixFor };
