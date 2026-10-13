# Phone quick wins, part 2 (2026-10-13)

Second half of stale PR #2316 ("CRM phone quick wins", branch
`fix/crm-phone-quick-wins`), ported onto main after #2368 and the layouts work.
Part 1 (Record payment one tap from Home, the solid `.modal` card on the
customer page, the keyboard-aware sheet) is the other slice, PR #2403. These
are the four items Jo approved as a second PR. Source: the 2026-10-07 CRM
iPhone audit.

Each item was re-checked against main first. All four were still absent; the
surrounding code had moved in one place that mattered (item 3, below).

## 1. All is the default CRM view (audit #10)

- `docs/pro/js/dashboard-bootstrap.module.js`: one `DEFAULT_KANBAN_VIEW =
  'simple'` constant replaces five scattered `|| 'insurance'` fallbacks (and
  an unknown saved key now falls back to `VIEW_SIMPLE`, not `VIEW_INSURANCE`).
- `docs/pro/js/crm.js` eager board build tries `[saved, current, 'simple',
  'insurance']`.
- `docs/pro/dashboard.html`: the static switcher marks All active, not Ins.
- A saved choice (`nbd_kanban_view`, kept across sign-out, synced by
  `prefs-sync.js`) still wins everywhere.

**Reach, said plainly:** `buildKanbanColumns` writes `nbd_kanban_view` on every
build, so a device that has already opened the CRM once has "Insurance" saved
and keeps it. The default only changes what a device with NO saved value
(fresh install, new login on a new phone, cleared storage) opens on. Jo's own
phone will not flip on its own; one tap on All saves it.

## 2. Presentation button is a screen, not a mic (audit #4)

`customer.html` static markup and `customer-presentation-theme.js` (which
rewrites the button on first sync, so BOTH had to change) now use the screen
icon. The mic read as voice notes, which live in Quick Capture.
`customer-presentation-theme.js?v=3` was deliberately not bumped: the line is
adjacent to #2403's insertions in `customer.html`, and `/pro/**/*.js` is
served `max-age=0, must-revalidate` so the ETag already delivers the new file.

## 3. Quick Capture: "Save to <customer>" (audit #4)

On a customer page the result screen leads with a full-width **Save to
Dana Whitfield** button (one tap, `_saveCapture(here.id)`); "Make N tasks"
reads "for Dana Whitfield" and writes straight to that lead; the picker lists
the current customer first, marked "This customer". Names go through
`escHtml` (lead names are public-form input).

**Changed from the #2316 version, because main moved:** #2316 decided "am I on
a customer?" from `window._customerId`. On main the dashboard's
`_stageWindowStateForLead` (document preflight) also sets `_customerId` and
`_leadDoc` and never clears them, so the dashboard's Quick Capture would have
offered "Save to <whichever lead you last opened a document for>". The gate is
now the page itself (`/pro/customer` or `/pro/customer.html`); the globals only
supply WHO once the page is the customer page. Test:
"dashboard with a stale staged _customerId has NO current customer".

Not changed: on the customer page `window._leads` is `[lead]`, so "Link to
another lead" can only list that one lead plus a search over it. That is
pre-existing and out of scope.

## 4. Schedule 44px targets (audit #8)

`google-calendar.css` (`?v=8`): under 768px every Schedule control is >= 44px —
"Back to CRM" (`.sched-back`), "Open lead" in both the outcomes list and the
appointment card (`.sc-lead-open`, `.sc-outcome-open`), the Cal.com sign-up
link, `.btn` / Save / Clear, the planner search + date inputs, "Show all open
leads" (toggle row 44px, checkbox 22px), and the lead-name links. Inline
styles on those three elements moved to classes (the inline-style ratchet
count drops by 1 in js, 2 in dashboard.html; the CEILING lines are left alone
on purpose, they are a hot line every PR edits).

## Tests

- `tests/phone-quick-wins-part2-2026-10-13.test.js` (34 assertions, in the CI
  manifest). Break-tested: each mutation reddened the assertion named for it —
  default constant, crm.js tries list, static `active` class, both icon sites,
  the page gate, picker ordering, the here-button handler, escaping, the
  sp-toggle height, and the two class hooks.
- `tests/e2e/phone-quick-wins-part2.spec.js` (authed list): fresh device opens
  on All and a saved `cash` still wins; Presentation is not a mic; every
  Schedule target >= 44px at 390 with standalone rules forced.

## Decisions Jo may want to revisit

- All is the default for every role. It shows every stage of the leads the
  user can already see; no data scope changes.
- "Save to <customer>" only exists on the customer page. The dashboard lead
  drawer is not treated as standing on a lead.
