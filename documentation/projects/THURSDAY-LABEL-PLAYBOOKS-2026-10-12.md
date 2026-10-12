# Thursday per-label caller playbooks (2026-10-12)

Jo's ask (2026-10-12): Thursday should treat a caller according to the label he put on that number, and he should be able to hand a number to her entirely, with nothing she does ever being invisible. Companion to [CONTACT-ROUTING-TREE-2026-10-12](CONTACT-ROUTING-TREE-2026-10-12.md) (slice 2d) and [AWAY-MODE-BACKUP-AS-BUILT-2026-10-12](AWAY-MODE-BACKUP-AS-BUILT-2026-10-12.md).

Status: **stage 1 (this note) + stage 2 (built DARK, code only).** Nothing here writes to Bland, places a call or sends a text. The Bland prompt/snippet changes in section 9 are text for Jo to review; nothing applies them.

Examples use fictional 555 numbers; the repo is public.

## 1. Rules every playbook obeys

| Rule | Why |
| --- | --- |
| **Inbound only.** Thursday answers; she never places a call and never sends a text. The CRM sends nothing because of a label. | TCPA. Her SMS stays off (Bland Agent Phone Plan, A2P) and is not touched here. |
| **A label is a hint, never proof of who is speaking.** Every playbook falls back to the normal call script if the caller does not fit. | A spouse, a borrowed phone or a wrong number can be on any line (existing REMEMBERING CALLERS rule). |
| **Never silent.** Every call is a row on Today, a line in a recap, or a counted ledger entry - see section 3. | Jo (2026-10-12): "nothing is invisible". |
| **No promises.** Never a time, price, crew, date or outcome. | Existing rule. |
| **Kentucky insurance rule.** Never "we handle / file / negotiate the claim", never whether anything is covered. | KRS 367.628 / ORC 3951; the Thursday note, section 13, and the site claim-wording gate. |
| **Subs are independent.** Never "in-house", never W-2 language. | NBD policy. |
| **No customer data to a non-customer.** The sub / supplier / insurance / unknown playbooks never say a customer's name, address or job. | A spoofed caller ID must learn nothing. |
| **Dark.** One server flag and one client flag, both off. | Section 8. |

**Honest limit, said once.** The static opening (`first_sentence`) plays about a second after connect, *before* the lookup runs. So the label can change only what she says from her **first reply** on; every caller, including spam, hears the same opening and the recording notice first. The CRM also cannot change carrier forwarding: whether a number's calls reach her at all is a handset/carrier setting.

## 2. The playbooks

The lookup (`thursdayCallerLookup`) already answers `known / first_name / job_hint`. Flag on, it adds `playbook`, `label_kind`, `handled`, `away_text`. Bland receives them as `caller_playbook`, `caller_label_kind`, `caller_handled`, `caller_away_text`.

| Label (kind) | Playbook | She says / asks | She never | Lands on Today as |
| --- | --- | --- | --- | --- |
| *none, lead owns the number* | customer | existing greeting ("Is this Pat?"), what is going on, job address, best number; water in = emergency tool | quote a price, promise a date | own row ("Thursday took a call"); task on the lead as today |
| customer | customer | same | same | own row |
| prospect | prospect | the normal new-lead script | quote | own row |
| *none, nobody owns it* / other | unknown | the normal new-lead script | - | own row |
| sub, contractor | sub | "Is this about a job?" Who, which company, which job or address, what they need, callback | agree scheduling, pay or scope; name any customer | quiet label: recap line, unless urgent or a callback is requested |
| supplier | supplier | delivery / order message: company, job if volunteered, what changed, when | agree a time, accept a change | quiet label: recap line |
| insurance (adjuster / carrier) | insurance | claim number, adjuster, carrier, property address, callback, when they would like to inspect (as a request) | coverage, claim handling, customer details | own row (surface policy) |
| referral | referral | thanks; who they sent (name, number) | payment or credit | own row |
| personal | personal | "I'll let him know you called"; message if they want | intake, address, a guessed name | **ledger only** (Jo hid it); urgent still shows |
| recruiter | recruiter | name, number, trade; "Jo will reach out if there is an opening" | pay | quiet label: recap line |
| spam | spam | "Thanks, we're not interested. Goodbye." then the hang-up tool | collect anything, answer anything | **ledger only**, counted |

Minimal disclosure: `personal` and `spam` never get a first name, even when a lead owns the number. Away wording is never given to a spam number.

## 3. What she captures, and the three tiers

Every non-spam call ends with a name (or "no name given") and a number Jo can call back. The extraction already stores the issue, urgency, callback window and a confidence. Each `thursday_calls` doc then lands in exactly one tier (`disposition()` in `docs/pro/js/thursday-handled-logic.js`):

| Tier | What it is | When |
| --- | --- | --- |
| **item** | its own row on Today ("Thursday took a call") with Call / Open / Reviewed | an ordinary call from an unlabeled or surface-labeled number; **any** call that is urgent or asks for a callback (promise wins); a failed extraction (a call never vanishes) |
| **recap** | one line in the daily "Thursday handled N calls" row | a number Jo handed her, or a quiet-labeled number, with an ordinary message |
| **ledger** | counted only ("3 spam / hang-ups logged quietly") | a spam label; a hide-labeled number unless urgent; the server's own log-only types (spam, test, hang-up) |

A test sweeps the whole matrix (label x handled x caller type x urgency) and requires every unreviewed processed call to be an item, a recap line or a ledger row, and that nothing is merely counted unless Jo himself hid or spam-labeled that number.

The "task" half: calls she attaches to a lead still create the existing lead task (create_lead / attach). A call with no lead (sub, supplier, adjuster without a match) has no task today and gets its Today row from `thursday_calls` itself - that is the gap this closes.

## 4. "Let Thursday handle this number" (opt-in, default off)

- **Where:** a "Let Thursday handle this number" button in the Label sheet (Today row or Call Center card), only when the client flag is on, never for a spam-labeled number, never for a viewer or a rep.
- **What it stores:** `companies/{companyId}/thursday_handled/{digits10}`. The doc's *existence* is the setting (keys: digits, companyId, updatedBy, updatedAtMs, createdAtMs, optional note <= 200). No mode, no flag, nothing sendable.
- **What it changes:** (1) the lookup returns `handled: true` so she takes a fuller message and asks "Is there anything Jo needs to do, and by when?"; (2) Today shows that number's ordinary calls in the recap instead of as separate rows.
- **What it does not change:** carrier forwarding. The sheet says so in one line. Handing a number over does nothing until the phone forwards that number's calls to her.
- **Never invisible:**
  1. The **Thursday-handled** list in the Call Center (a filter; shows every number with a Take back button).
  2. A **daily recap row** on Today: "Thursday handled N calls", the **three she was least sure about on top** (see below), Show all, Mark all reviewed, and a footer with how many numbers are handed over and how many spam / hang-ups were logged quietly.
  3. **Promise wins:** an urgent call or a callback request from a handled number is its own row, not a recap line.
- **Reclaim in one tap:** "Take back" on any recap line or list row deletes the doc (optimistic, rolls back with a toast if the write fails). The next call surfaces the normal way.
- **Least sure** is `uncertainty()`, built only from fields the call doc already has: low (+40) / medium (+10) extraction confidence; a failed extraction (+50); a possible-but-unconfirmed match (+25); not matched to anyone (+15); the label disagreeing with the caller type (+30); a hang-up (+20); no number to call back (+20); no summary (+15); a non-English call (+10); marked urgent (+10). Capped at 100; ties newest first. The top 3 sit on top of the recap.

## 5. Block list

Jo asked for "a per-number policy block that is just a CRM-side suppression plus a list; not carrier blocking".

- **Built as:** a number is *blocked* when its contact label is kind `spam` with policy `hide`. That is the existing suppression (it already drops the number from Today, the Home strip, the badge and the callWatch alert; an urgent call from a spam-labeled number does not break through).
- **Why not a fourth policy value:** every consumer of label policy (`home-attention.js`, `call-watch-logic.js`, `contact-labels-logic.js`, the Firestore rule) knows exactly `surface / quiet / hide`. A fourth value would be treated as the default by every one of them - silently doing nothing. A test pins the policy set at three.
- **The view:** Call Center filter "Block list": the spam-labeled numbers, a **Copy list** button (one number per line), the two-line handset instructions, and **Not spam** (removes the label; calls surface again).
- **Never:** the CRM does not block at the carrier, does not report a number, does not call or text it.

## 6. Away mode

When Away is on and the owner has approved the wording for *this* trip, `thursdayAwayContext()` returns the approved text and the lookup passes it as `caller_away_text`. She says it word for word in her first reply, then runs the label's playbook.

- **Only the approved text**, only while the window is active, only when the stored hash matches the text and the approval was made for this end date (all inherited from `away-mode-logic.js`).
- **Never names the backup.** The wording itself never does (`nameBackupToCallers` is forced false). As defense in depth the lookup drops the text entirely if it contains the backup's name (full name any case, or a first/last name Capitalized), email or phone digits - fail closed to "say nothing about being away".
- **Says only that the owner is away.** The prompt adds: never add anything to it, never say who is covering, never name anyone other than the owner.
- **Spam gets none.** Personal numbers get it (and no name).
- **Same limit as section 1:** it is spoken in her first reply, not in the static opening.

## 7. Data, rules, security

| Item | Decision |
| --- | --- |
| Collection | `companies/{companyId}/thursday_handled/{digits10}`; the lookup reads it by exact doc id under the NBD company only |
| Rules | owner / company_admin / manager write; viewer read-only; **sales_rep neither reads nor writes** (a phone number is a teammate's call); other tenant none; shape locked (hasOnly, id == digits, companyId == path, updatedBy == writer, createdAtMs frozen). `tests/firestore-rules.thursday-handled.test.js` (47 checks, each deny paired with an allow control, break-tested) is wired into ci.yml and the deploy gate |
| Lookup reads | label, handled doc, `away_private`, `away_mode`: four doc gets started **beside** the lead queries (so the lookup costs the slower of the two, not the sum), 900 ms budget (the Bland snippet aborts at 2.5 s). Any failure or timeout = the lookup answers exactly as before, with a warning in the log |
| Tenant isolation | another company's label or handled doc for the same digits is never read (integration test) |
| Disclosure | `label_kind` is a coarse enum; no name, note, address or lead data beyond what the lookup already returned |
| Sendable surface | none. No send function, no `fetch`, no `sms:` / `mailto:` in the new client file (a test pins it); the only write is the setting doc and the existing `thursdayCallAction mark_reviewed` |
| Prompt lint | the prompt block contains no dollar figure, no "in-house", no "licensed", no "guarantee", no claim-handling or coverage phrase (sentences that *prohibit* a phrase are set aside, with a control) |

## 8. Flags (both off)

| Flag | Where | Default | Effect |
| --- | --- | --- | --- |
| `THURSDAY_LABEL_PLAYBOOKS_ENABLED` | `functions/.env.nobigdeal-pro` (a normal deploy); registered in `cron-gates.js` | unset = off | the lookup adds the four fields. Off: byte-identical response (integration test) |
| `thursdayLabelPlaybooks` | `feature_flags/_default` (platform admin), read by `NBDFlags` | unset = off | the Label-sheet toggle, the Today Thursday section, the two Call Center filters. Off: the two lazy files are never even fetched |

## 9. The exact text changes (a diff for Jo to review; nothing applies it)

The code that would build these lives in `functions/integrations/thursday-playbooks.js` (`initCode()`, `PROMPT_BLOCK`) so a test reads the same bytes this note prints. `scripts/thursday-agent-lookup.js` is **unchanged**; it still carries the old snippet.

### 9a. Initialization snippet (builder -> Initialization -> Save code)

```diff
diff --git a/init-snippet.before.js b/init-snippet.after.js
index c2372e9..7038306 100644
--- a/init-snippet.before.js
+++ b/init-snippet.after.js
@@ -3,5 +3,5 @@ export default {
     const json = await request.json().catch(() => ({}));
     const from = json.from || json.phone_number || json.caller || json.short_from || '';
-    const unknown = { caller_known: 'false', caller_first_name: '', caller_job_hint: '' };
+    const unknown = { caller_known: 'false', caller_first_name: '', caller_job_hint: '', caller_playbook: '', caller_label_kind: '', caller_handled: 'false', caller_away_text: '' };
     const token = env && (env.THURSDAY_LOOKUP_TOKEN || (env.vars && env.vars.THURSDAY_LOOKUP_TOKEN));
     if (!from || !token) return Response.json(unknown);
@@ -15,6 +15,15 @@ export default {
       if (!r.ok) return Response.json(unknown);
       const d = await r.json();
-      if (!d || d.known !== true || !d.first_name) return Response.json(unknown);
-      return Response.json({ caller_known: 'true', caller_first_name: String(d.first_name), caller_job_hint: String(d.job_hint || '') });
+      if (!d) return Response.json(unknown);
+      const known = d.known === true && !!d.first_name;
+      return Response.json({
+        caller_known: known ? 'true' : 'false',
+        caller_first_name: known ? String(d.first_name) : '',
+        caller_job_hint: known ? String(d.job_hint || '') : '',
+        caller_playbook: String(d.playbook || ''),
+        caller_label_kind: String(d.label_kind || ''),
+        caller_handled: d.handled === true ? 'true' : 'false',
+        caller_away_text: String(d.away_text || ''),
+      });
     } catch (e) {
       return Response.json(unknown);
```

The step's **Reference Variables** stay as they are (`from` = `{{from}}`; see section 12 of the Thursday note). No new reference variable is needed.

### 9b. Agent node prompt (append after the RECORDING NOTICE block)

Purely additive: it replaces nothing and does not touch OPENING, REMEMBERING CALLERS or RECORDING NOTICE.

```diff
+# CALLER PLAYBOOKS (label playbooks, 2026-10-12)
+The phone system may tell you what Jo already knows about this number. It is a HINT about who usually calls from it, never proof of who is speaking: a spouse, a borrowed phone or a wrong number can all be on that line. If it does not fit what the caller says, drop it and use the normal call script.
+
+Every call, no matter the playbook, ends with two things: a name (or "no name given") and a number Jo can call back (the number they called from is fine if they say so). Say "I'll make sure Jo gets this." Never promise a time, a price, a crew, a date or an outcome.
+
+If {{caller_away_text}} is not empty, say it word for word in your first reply after the greeting, then carry on with the playbook. Never add anything to it, never say who is covering, and never name anyone other than the owner.
+
+Run the playbook named by {{caller_playbook}}. If it is empty or anything else, use the normal call script.
+
+- customer or prospect: the normal call script. For a customer: what is going on, the address of the job, the best number. Water coming in is urgent: use the emergency tool.
+- sub: "Is this about a job?" Take who is calling, which company, which job or address, what they need, and a callback number. Never agree to scheduling, pay or scope, and never give out any customer's name, address or details.
+- supplier: take the delivery or order message: company, the job or address if they volunteer it, what changed, when. Never agree to a delivery time or accept a change.
+- insurance: you are talking to an adjuster or carrier. Take the claim number, the adjuster's name, the carrier, the property address, a callback number and when they would like to inspect (as a request). Stay neutral: never say whether anything is covered, never describe what Jo does with a claim, and never confirm details about the customer.
+- referral: thank them warmly. Take who they sent (name, number). Never talk about any payment or credit.
+- personal: short and warm. "I'll let him know you called." Take a message if they want to leave one. No intake questions, no address, no name guessing.
+- recruiter: someone asking for work. Take name, number and trade. "Jo will reach out if there is an opening." Never discuss pay.
+- spam: say "Thanks, we're not interested. Goodbye." and use the hang-up tool. Do not collect anything and do not answer questions.
+
+If {{caller_handled}} is "true", Jo has asked you to take these calls fully. After the message ask: "Is there anything Jo needs to do, and by when?" and repeat it back so it can be written down. You still make no promises.
```

### 9c. Switch-on order (each step is reversible)

1. Merge + deploy the code (flags off: nothing changes).
2. Set `THURSDAY_LABEL_PLAYBOOKS_ENABLED=true` and deploy. The lookup response now carries four extra keys the *old* snippet ignores, so calls are unchanged.
3. In the Bland builder: paste 9a into Initialization and save; append 9b to the agent node prompt; publish to **staging** (not production).
4. One test call from Jo's phone to a number he labeled sub, then one from a number labeled personal and one from a spam-labeled number. Read `pathway_logs` (`Tool Call Unmatched`, variable names) with the existing read-only scratch analyzers.
5. `node scripts/thursday-agent-lookup.js --promote --yes`. Rollback: `--rollback=<previous semver> --yes`.
6. Set `feature_flags/_default.thursdayLabelPlaybooks=true` to show the Today / Call Center surfaces, then do the standing **phone-scale pass** on the installed iPhone app (Today recap row, the Label-sheet toggle, the Block list) before relying on it.
7. Hand over one number first (his own test line) and watch a day of recaps.

Rollback is the reverse: client flag off (surfaces vanish), prompt back to the previous version, then the env flag.

## 10. As built (stage 2)

- `functions/integrations/thursday-playbooks.js` - pure resolver + the text above.
- `functions/integrations/thursday.js` - `thursdayCallerLookup` reads the flag, widens the response. Nothing in `processCall` changed.
- `docs/pro/js/thursday-handled-logic.js` (pure tiers, uncertainty, block list), `thursday-handled.js` (data + Today / sheet / Call Center), `css/thursday-handled.css`. Loaded lazily by `contact-labels.js` only when the client flag is on, so `script-loader.js` grows by **zero bytes** (cache-busters bumped in place, same length).
- Hooks (guarded, three lines each): `today-home.js`, `call-center-view.js` (two flagged filters + a panel + `setFilter`), `contact-labels.js` (sheet row + the lazy loader).
- `firestore.rules` - `thursday_handled`.
- Tests: `thursday-playbooks-2026-10-12.test.js` (139 checks, incl. a vm run of the DOM file with hostile caller names), `thursday-label-playbooks.integration.test.js` (42, real handler on the emulator, incl. a 6 s label read that must not cost the greeting), `firestore-rules.thursday-handled.test.js` (47).

## 11. Decisions for Jo

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | **Block = a spam label with hide**, not a fourth policy value (section 5) | Yes - the only way it suppresses everywhere today |
| 2 | Which kinds may be handed to Thursday? Built: **everything except spam**, with the sheet line about forwarding | Keep. Consider excluding `insurance` and `customer` at first (adjusters and customers with open jobs are where a wrong answer costs most) |
| 3 | Hidden numbers: an unreviewed Thursday call from a **personal** or hide-labeled number is **ledger only** (counted, not a row) unless urgent. That is the one place "never without a Today item" yields to your own hide | Confirm, or say hidden personal calls should always show |
| 4 | Handled number + a callback request (not urgent): **own row** (promise wins) rather than a recap line | Yes |
| 5 | Recap window **3 days** for unreviewed calls; top **3** least-sure on top | Confirm the numbers |
| 6 | The label cannot change her **opening line** (it plays before the lookup). Personal and spam callers hear the greeting and the recording notice first | Accept; the alternative is a different number per label |
| 7 | **Insurance playbook** wording (section 9b): neutral, claim number / adjuster / carrier / address / callback / inspection request | Read it once |
| 8 | **Sub playbook** opens "Is this about a job?" and gives out no customer details | Read it once |
| 9 | Away wording to personal numbers (no name) but never to spam | Confirm |
| 10 | Client flag in `feature_flags/_default` (platform admin) - or per-tenant later | Fine for now (NBD is the only Thursday tenant) |
| 11 | Switch-on order (section 9c): flag, staging test calls from your phone, promote, then show the UI | Confirm; I will not touch Bland without your explicit go |

## Update 2026-10-12 (evening) - security review of the build

The nbd-security-reviewer pass on the stage-2 diff found no blockers. What changed because of it (all in PR #2393):

| Finding | Outcome |
| --- | --- |
| S1 the 1.2 s playbook read ran *after* the lead queries and could have used the caller's 2.5 s greeting window | The four reads start beside the lead queries; budget cut to 900 ms; an integration test stubs a 6 s label read and requires the greeting ("Lee") and < 2 s |
| S2 the backup-name scrub was case-sensitive on name parts (McDonald / SAM slipped) | Parts match whole-word in any case. A name part that is also an everyday word the approved wording uses (`will`, `may`, `mark`) is skipped for the part check only (the whole name and the email are still caught), so "Jo will call you back" survives a backup called Will. Known limit: a backup called "Mark" is caught only by full name / email |
| S3 a failed read answers the pre-playbook way, so a personal number on a lead could be greeted by name | Accepted: it is exactly today's behaviour, and the failure is now logged (`over budget` / `context unavailable`) |
| N1 the click handler trusted any `data-th-act` | Number-keyed actions (toggle, reclaim, unblock) act only on a real 10-digit number |
| N3 a stale tab re-creating an existing handled doc was denied (createdAtMs is frozen) with a misleading toast | The existing doc's createdAtMs is read and kept |
| N4 a newline in the approved away text reached the prompt variable | Collapsed to one line |
| N2 "Mark all reviewed" fires one callable per call | Left: bounded by the 3-day window and 40 calls |

Also: the client loader re-checks the `thursdayLabelPlaybooks` flag up to six times (2.5 s apart) because the flags read needs the signed-in user and can land after `contact-labels.js`; `NBDFlags` caches the read, so a flag that is simply off costs nothing.

## 12. Not in this change

Suggestion chips (2b), the `personal` stops-transcription slice (2c, its own PR), any Bland write, SMS to callers, carrier forwarding, per-tenant Thursday (the lookup serves the NBD company only, as today).
