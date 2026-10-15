# Cloudflare Turnstile — the CAPTCHA the public forms never had (2026-09-06)

*Companion: [SECRET_ROTATION](SECRET_ROTATION.md), [ALERT_RESPONSE](ALERT_RESPONSE.md).
Contract pinned by `tests/turnstile-contract.test.js`.*

> **Update 2026-09-13 — coverage now includes the area and service quick forms.**
> This page used to say four pages were covered, and that was true only of the
> four that load the key stub. **181** pages can reach `submitPublicLead`: 10
> load `public-lead-submit.js` directly, 170 `/areas/*` + `/services/*` pages
> inject it through `quick-lead-form.js`, and `sites/index.html` reaches it
> through `marketing-firebase.js`. 177 of them had no key, so setting the secret
> would have 403'd every lead from them
> ([NEXT_SESSION-2026-09-09 §1](../projects/NEXT_SESSION-2026-09-09.md)).
> `public-lead-submit.js` now carries `DEFAULT_TURNSTILE_SITEKEY`, which keys all
> 181 with no HTML edits, and the contract test derives the page list from the
> tree instead of hardcoding it. Two client defects were fixed in the same
> change: a second submit on a page got no usable token (§"The second-submit
> defect"), and a stalled Cloudflare script load never sent the lead at all
> (§"What the challenge costs a lead"). **The enforcement order below is
> unchanged:** measure real `turnstileTokenPresent:true` in Cloud Logging
> first. `TURNSTILE_SECRET` was not touched.
>
> **Follow-up the same day:** the safety timeout was cut from 8 s to **6 s**
> (4 s was measured and rejected). See §"The safety timeout is 6 s".

## What was actually wrong

Not "the secret was unset". **Nothing was wired at all.** The server verifier
(`functions/integrations/turnstile.js`) and the client auto-wiring
(`docs/assets/js/public-lead-submit.js`) have both existed since the C-3 audit,
but `window.__NBD_TURNSTILE_SITEKEY` was `""`, no `docs/` page contained a
`.cf-turnstile` element, so the Cloudflare script was never fetched,
`nbdTurnstileExecute()` returned `''`, and `public-lead-submit.js` omitted the
field entirely. `verifyTurnstile` then hit its unconfigured branch and returned
`{ok: true, configured: false}` — **every public submission waved through**, on
a honeypot and an IP rate limit alone.

## The rollout order — get this wrong and you lose every lead

`verifyTurnstile` rejects any tokenless submission the moment `TURNSTILE_SECRET`
is set. So:

1. **Populate the site key** in `docs/assets/js/inline/7cd8e505ab.js`, and
   keep `DEFAULT_TURNSTILE_SITEKEY` in `docs/assets/js/public-lead-submit.js`
   identical. The default is what keys the 177 pages without the stub; the
   contract test fails if the two differ.
2. **Deploy it** (a hosting deploy is enough — it is a static file).
3. **Verify real traffic is producing tokens** (below). This step is the whole
   point of the ordering and is easy to skip.
4. **Only then** `firebase functions:secrets:set TURNSTILE_SECRET`, and
   redeploy functions so the new version binds.

Setting the secret before a deployed site key 403s **100% of public leads**,
silently. Steps 1–3 are done; step 4 is deliberately not.

## Verifying step 3

`submitPublicLead` logs `turnstileTokenPresent` on every successful submission
(a boolean — a token is a credential and is never logged). Before setting the
secret, confirm it is `true` on real traffic:

```bash
gcloud logging read \
  'jsonPayload.message="submitPublicLead" AND jsonPayload.turnstileTokenPresent=true' \
  --project nobigdeal-pro --limit 5 --freshness=7d
```

If that comes back empty while leads are still arriving, the client is not
producing tokens — **do not set the secret**. Look at
`window.__NBD_TURNSTILE_SITEKEY` on the live page first.

**A standing alert watches for it (live since 2026-09-13).** Cloud Monitoring
policy `projects/nobigdeal-pro/alertPolicies/15802792625691337472`, defined in
`monitoring/alert-turnstile-token-present.json`, emails and texts Joe (at
most once a day) when that log line appears with
`turnstileTokenPresent=true`. So nobody has to remember to run the query
above. What an alert does and does not prove:

- **It proves a token was sent, not that it is valid.** Nothing verifies
  tokens while the secret is unset.
- **It doesn't say which page.** The log carries `kind` and doc `id`; the
  lead doc's `source` names the page.
- **One alert is not a token rate.** The enforcement decision still needs
  the rate from the query above, with trues from `/inspect` *and* from at
  least one `/areas/*` or `/services/*` quick form (`source` starting
  `page-form:`).

Details and the Windows `gcloud` traps are in `monitoring/README.md` §11.

## The widget

Created 2026-09-06 in the Cloudflare dashboard (Turnstile → Add widget
manually):

| Setting | Value | Why |
|---|---|---|
| Name | `NBD public lead forms` | — |
| Hostnames | `nobigdealwithjoedeal.com`, `www.nobigdealwithjoedeal.com` | every lead surface is on this host, tenant microsites (`/sites/t/`) included. A submit from the Firebase default domains (`*.web.app`, `*.firebaseapp.com`) gets no token. |
| Mode | **Invisible** | `public-lead-submit.js` renders into a container it appends to `document.body`. (It passes `size:'invisible'`, but Cloudflare's documented `size` values are `normal`, `flexible` and `compact`. The widget is invisible because of this dashboard mode, not that option.) A **Managed** widget that decided to show an interactive challenge would be invisible and unusable — the visitor gets no token and, once the secret is set, loses their lead. Invisible is marginally weaker against a determined bot and cannot ever block a human, which is the right trade for a lead form. |
| Pre-clearance | off | needs the site proxied through Cloudflare |

Site key `0x4AAAAAAEqcVVOXW3xyusXQ` is **public by design** and lives in the
repo. The secret key is viewable again in the dashboard (Turnstile → the widget
→ Settings) if it is ever needed.

**Legal condition of invisible mode:** Cloudflare requires the [Turnstile
Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/) to be
referenced in our own privacy policy. `docs/privacy.html` §"Security &
Monitoring" does that. If the mode is ever switched away from invisible that
sentence can go; if a new public surface adopts Turnstile, it stays.

## Which pages are covered

*Corrected 2026-09-13. Until then this section listed only the four stub pages,
which were 4 of 181.*

Every page that can reach `submitPublicLead`. `tests/turnstile-contract.test.js`
walks `docs/` for pages that load `public-lead-submit.js`,
`quick-lead-form.js` or `marketing-firebase.js`, directly or through any
script that imports or injects one of them. It asserts each page is keyed:
either the stub loads before the client, or the client's
`DEFAULT_TURNSTILE_SITEKEY` equals the stub key. It also fails any page that
sets `window.__NBD_TURNSTILE_SITEKEY` to a different value. An explicit `''`
still opts a page out, and an opted-out page is tokenless once the secret is
set.

No per-page markup is needed: the client creates its own
`.cf-turnstile-auto` container. Do not add a static `.cf-turnstile` div. The
contract test fails one that pins a different `data-sitekey`, or any widget at
all while the key is empty.

## Verified before shipping

The client path was proved against Cloudflare's official test keys on a local
probe, both directions:

| Test site key | Result |
|---|---|
| `1x00000000000000000000AA` (always passes) | token in ~2.8 s, container created, API script loaded |
| `2x00000000000000000000AB` (always blocks) | resolves to `''` in ~1.9 s — **does not hang, does not throw** |

That second row is the one that matters: a failing widget degrades to "no
token", `public-lead-submit.js` omits the field, and while the secret is unset
the lead still lands. So step 1–3 carry no risk of losing leads; only step 4
makes the token load-bearing.

*Correction 2026-09-13:* "no risk" was not quite true. A test key that
**fails** fails fast. A `challenges.cloudflare.com` that **stalls** (the network
drops the request rather than refusing it) was different: the script load sat
outside the 8 s safety timeout, and the submit never POSTed at all. That was
live on the four keyed pages and would have spread to all 181 with the key
hoist. It is fixed; see "What the challenge costs a lead" below.

### The live-page probe returns no token — and that is expected

Running `window.nbdTurnstileExecute()` on the real site from an **automated**
browser returns `''` with `[Cloudflare Turnstile] Error: 600010` in the
console. That is a *challenge* failure, not `110200` ("domain not allowed") and
not a sitekey error — the script loads, the widget renders, the hostname is
accepted. The most likely cause is Turnstile correctly refusing a CDP-driven
browser, which is the product working.

The consequence for operations: **an automated probe cannot verify this
integration.** Cloudflare's test keys pass unconditionally and prove only the
wiring; the real key applies real bot detection and will fail any automation.
The only trustworthy signal is `turnstileTokenPresent` on genuine human
traffic. Plan the rollout around that, not around a synthetic check.

### The second-submit defect (fixed 2026-09-13; it was not cosmetic)

This section used to call it cosmetic. The client called `turnstile.render()`
into the same container on **every** submit, then `execute()`. Real `api.js`
in Chromium showed what that does on a page's second submit, which is the retry
after a failed first one:

- `Turnstile has already been rendered in this container. The render attempt
  was rejected.` The new promise's callback was never registered.
- With Cloudflare's always-pass test key: `Call to execute() on a widget that
  was already executed … execute() will return the previous token obtained`.
  The retry POSTed the **spent** single-use token.
- With the real key, the retry waited the full 8 s safety timeout and POSTed
  no token (8,002 ms).

Either way, a configured server rejects that retry. The client now renders
once (`execution: 'execute'`), then calls `reset(id)` + `execute(id)` on each
later submit. The widget's callbacks are bound once, so they settle whichever
submit is waiting at the time. The safety timeout is cleared when a callback
fires. A vm-sandbox test in the contract suite pins all of that, and it fails
against the old client.

## What the challenge costs a lead (measured 2026-09-13)

Before the key hoist, 177 surfaces sent the lead the instant it was clicked.
Now every surface runs a challenge first. This is what that costs, from the
click to `submitPublicLead`'s POST attempt.

**Setup.** Playwright Chromium (headless), 5 runs per row. Every
`nobigdealwithjoedeal.com` request was answered from a local static server of
`docs/` with the production CSP header. The POST was fulfilled by a stub, and
the first POST returned 503 so the form re-enabled for a real second click.
Every host except `*.challenges.cloudflare.com` was aborted, DNS for everything
else was mapped to NOTFOUND, and service workers were blocked. Nothing reached
production.

| Cloudflare | Page | 1st submit (median, range) | 2nd submit (median, range) | Token |
|---|---|---|---|---|
| — (origin/main: no key on these pages) | `/inspect` | 1 ms | 1 ms | none |
| — (origin/main) | `/areas/mason-oh` | 13 ms (12–14) | 0 ms | none |
| reachable, **real key** | `/inspect` | 1,832 ms (1,656–2,139) | 1,580 ms (1,224–1,691) | 0/5, error 600010 |
| reachable, real key | `/areas/mason-oh` | 2,034 ms (1,555–2,420) | 1,509 ms (1,261–1,626) | 0/5, error 600010 |
| reachable, always-pass **invisible test key** `1x…BB` | `/inspect` | 2,113 ms (1,763–2,271) | 1,672 ms (1,584–1,791) | 5/5 both submits |
| reachable, test key | `/areas/mason-oh` | 2,023 ms (1,769–2,067) | 1,654 ms (1,571–1,681) | 5/5 both submits |
| **refused** (blocked-by-client) | `/inspect` | 12 ms (11–13) | 1 ms | none |
| refused | `/areas/mason-oh` | 16 ms (15–18) | 0 ms | none |
| **stalled** (never answers) | `/inspect` | 8,011 ms (8,008–8,013) | 8,003 ms (8,001–8,010) | none |
| stalled | `/areas/mason-oh` | 8,019 ms (8,018–8,026) | 8,011 ms (8,004–8,013) | none |
| stalled, **before** the load fix | both pages | **never POSTed** (2/2 runs, 30 s cap; 45 s in an earlier probe) | — | — |

How to read it:

- **No human timing exists in this table.** The real key refuses automation
  (600010), so its rows are time-to-refusal. The test-key rows are the success
  path: the real `api.js` and iframe round trip to Cloudflare, but no real
  challenge work. Expect roughly 1.5–2.5 s on a fast desktop connection, and
  more on mobile.
- **Refused is cheap and stalled is the worst case.** An ad blocker or DNS
  sinkhole fails the script at once. A network that drops packets costs
  exactly the safety timeout, and the lead is still sent (tokenless). The
  stalled rows above were measured at the original 8 s. **The timeout is now
  6 s**; see the next section.
- **Before enforcement, the timeout only costs waiting, never a lead.** Once
  `TURNSTILE_SECRET` is set, a submit that hits the timeout is tokenless and gets
  403'd. So the timeout must stay above real visitors' challenge time, and only
  `turnstileTokenPresent` on live traffic can show what that is.

## The safety timeout is 6 s (decided 2026-09-13)

`TURNSTILE_TIMEOUT_MS = 6000` in `docs/assets/js/public-lead-submit.js`, pinned
by `tests/turnstile-contract.test.js`. It is the longest a submit waits for a
token, covering both the script load and the challenge, before it POSTs without
one.

**Why it moved.** At 8 s, a visitor on a stalled network watched "Sending…" for
8 s. That was proposed as a lead cost, and Jo chose to cut it.

**Why 6 s and not 4 s.** 4 s was built and measured first, and it cut into the
success path:

| 4 s client, 5 runs | 1st submit | 2nd submit |
|---|---|---|
| stalled, `/inspect` | 4,010 ms (4,006–4,017) | 4,005 ms (4,001–4,010) |
| stalled, `/areas/mason-oh` | 4,018 ms (4,010–4,028) | 4,012 ms (4,004–4,015) |
| always-pass test key, `/inspect` | 2,058 ms median, **but run 1 hit the timeout at 4,007 ms with no token** (4/5 tokens) | 1,626 ms (1,595–1,690), 5/5 |
| always-pass test key, `/areas/mason-oh` | 2,007 ms (1,809–2,455), 5/5 | 1,648 ms (1,582–1,776), 5/5 |

A challenge that always passes, over a fast connection, missed 4 s once. After
enforcement that visitor is 403'd. Before enforcement, that submit still logs
`turnstileTokenPresent:false`, which drags down the very token rate the
enforcement decision depends on.

A larger uncut sample (8 s client, always-pass test key, 20 runs per page) put
the normal success path well clear of 6 s:

| 40 samples | tokens | median | p90 | max | over 4 s | over 6 s |
|---|---|---|---|---|---|---|
| 1st submit | 40/40 | 1,904 ms | 2,237 ms | 2,613 ms | 0 | 0 |
| 2nd submit | 40/40 | 1,650 ms | 1,704 ms | 1,807 ms | 0 | 0 |

Across all 70 test-key first submits measured on the fixed client that day (10
at 8 s, 10 at 4 s, 10 at 6 s, 40 above), 1 went over 4 s and none came near
6 s. The first submit is the slower one because it also
downloads `api.js`. Mobile networks will be slower than these numbers, and that
is the margin 6 s buys.

The shipped 6 s client, measured the same way (5 runs per row):

| 6 s client | 1st submit | 2nd submit | Token |
|---|---|---|---|
| stalled, `/inspect` | 6,006 ms (6,003–6,008) | 6,010 ms (6,009–6,011) | none (lead still sent) |
| stalled, `/areas/mason-oh` | 6,019 ms (6,014–6,025) | 6,002 ms (6,001–6,011) | none (lead still sent) |
| always-pass test key, `/inspect` | 2,116 ms (1,792–2,219) | 1,617 ms (1,584–1,749) | 5/5 both submits |
| always-pass test key, `/areas/mason-oh` | 2,129 ms (1,852–2,283) | 1,626 ms (1,580–1,654) | 5/5 both submits |

**Revisit with live data.** Once `turnstileTokenPresent` has real traffic
behind it, a token rate noticeably below the share of visitors who do not block
Cloudflare suggests real challenges are hitting the timeout. Re-measure before
moving the number in either direction, and update the pin in the contract test
with it.

## Emergency

**Update 2026-10-13:** `TURNSTILE_REQUIRED=true` is now set in
`functions/.env.nobigdeal-pro` (the tracked, project-scoped env file the deploy
reads; not a secret). An *unset or blank* `TURNSTILE_SECRET` therefore fails
CLOSED: every lead submit and Roof Care Plan checkout gets `403
turnstile-required`. That is the point (a cleared secret can no longer
silently turn the CAPTCHA off) and it reverses the old emergency move.

To disable Turnstile enforcement quickly in an incident:

1. Set `TURNSTILE_REQUIRED=false` in `functions/.env.nobigdeal-pro`.
2. Redeploy. The verifier then behaves as before: with the secret set it still
   verifies tokens; to also stop verifying, blank `TURNSTILE_SECRET` in the same
   deploy and it returns to the unconfigured passthrough.

Blanking the secret alone, with the flag still `true`, takes the lead forms
*down*. Both callers (`submitPublicLead`, `carePlanPublic`) bind the secret;
`tests/turnstile-contract.test.js` fails if a new `verifyTurnstile` caller
does not.

## Related

- [SECRET_ROTATION](SECRET_ROTATION.md) — add `TURNSTILE_SECRET` to any future rotation sweep
- Session note: [SESSION-2026-09-06-instantroofer-adapter](../projects/SESSION-2026-09-06-instantroofer-adapter.md) — where the gap was found
