# Accessibility pass on the lead pages (WCAG 2.2 AA), 2026-11-27

*Lane 3 of the third site-improvement round. Companions: [INDEX](../INDEX.md),
[OVERNIGHT-A11Y-LANDMARKS-2026-11-06](OVERNIGHT-A11Y-LANDMARKS-2026-11-06.md),
[TWELVE-PASS-SWEEP-2026-11-07](TWELVE-PASS-SWEEP-2026-11-07.md),
[a11y-audit-2026-10-23](../qa/a11y-audit-2026-10-23.md) (Joe's VoiceOver checklist),
[VISUAL-BASELINE-REBLESS](../runbooks/VISUAL-BASELINE-REBLESS.md).*

**Pages:** the homepage (`docs/index.html`, with its short quick form), `/inspect`, `/estimate`,
`/roof-check`, one town page (`/areas/cincinnati-oh`) and one service page
(`/services/roof-replacement`). The shared pieces they load (quick form, scheduling block, hero
video, announcement bar, site-wide focus ring) were fixed at the source, so the same fixes reach
every page that loads them.

## Method

1. **axe-core 4 (`@axe-core/playwright`)**, tags `wcag2a/2aa/21a/21aa/22aa` + best-practice, at
   390 and 1280 px, served by `scripts/overnight-serve.mjs`. **Zero violations on all six pages at
   both widths, before and after.** axe left color contrast "needs review" only where text sits on a
   photo or video (hero), which the 2026-11 hero-video work had already measured frame by frame.
2. Because axe was clean, the real gaps are the ones it can't see. A Playwright probe tabbed
   through every page and measured, for each focus stop: the focus ring's contrast against what is
   behind it, the stop's size, and whether it was visible. A second script drove each form's error
   path, step changes and the motion controls by keyboard only.
3. Contrast pairs were computed by hand against the locked palette (`DESIGN.md` → Color), including
   alpha blends on the dark `/estimate` card.

## Findings and fixes

| # | WCAG | Where | Finding | Fix |
|---|---|---|---|---|
| 1 | 1.4.11, 2.4.7 | site-wide (`nbd-mobile.css`) | The focus ring is brand orange: 2.84:1 on navy `#1a3057`, 1:1 on the orange announcement bar (invisible), so focus vanished on the nav, credential chips, trust items and announcement links | A 2px white band fills the ring's offset gap (`:focus-visible{box-shadow:0 0 0 2px #fff}`). The ring now reads on navy, orange and photos; light pages look as before |
| 2 | 1.4.11 | homepage jobs strip | Its own ring was light orange `#dd875f` on off-white: 2.46:1 | `--orange-dark` `#a14a22`: 5.39:1 |
| 3 | 1.4.11 | quick form (homepage, town, service pages), `/inspect`, `/roof-check` | Field edges `#d7dbe0` / `#e8e5e0` on white: 1.2-1.4:1, so the fields were near-invisible boxes | `#858d99`: 3.35:1 |
| 4 | 1.4.11 | `/estimate` | Field edges white at 12% on the navy card: 1.45:1 | white at 40%: 3.55:1 |
| 5 | 1.4.11 | scheduling block selects (`intake-extras.css`) | Edge grey at 45%: about 1.9:1 | 90%: about 3.3:1 |
| 6 | 2.4.7 | `/inspect` | Focus was `outline:none` plus a 12%-opacity glow, and an invalid field's inset shadow replaced even that | A solid 3px orange outline (4.61:1 on white) that survives the invalid styling |
| 7 | 1.4.3 | `/estimate` | Error lines (0.7rem) in `#ef4444` on the navy card: 3.78:1 | `--error: #f87171`: 5.14:1 (the field border uses it too: still 3:1+) |
| 8 | 3.3.1, 4.1.2 | quick form, `/inspect`, `/roof-check` | On a failed Send the message was a `role=alert`, but only `/inspect`'s first bad field was tied to it; a screen-reader user tabbing back to a field heard "invalid" with no reason | Every marked field gets `aria-describedby` → the message, and it clears when the field is edited |
| 9 | 3.3.1, 2.4.3 | `/inspect` | A missing scheduling choice put the message at the far end of the form with focus left on Send (off screen on a phone) | The message goes right under the choices and focus moves to the first radio (the quick form already did this) |
| 10 | 3.3.1, 1.3.1 | `/roof-check` step 4 | Name/phone labels were `<span>`s (aria-label only, tapping the label did nothing); errors set no `aria-invalid`, focus stayed on Send; name and phone not exposed as required; the address hint was a silent div | Real `<label for>`, `required` on name and phone, `aria-invalid` + `aria-describedby` + focus on the first bad field (or the first scheduling radio); hint is `role=alert` and describes the address field |
| 11 | 3.3.2 | scheduling block | The radios carried no required state (only a red `*` in the legend) | `required` on the radios when the choice is required (every form that hosts it is `novalidate`, so no browser bubble appears) |
| 12 | 2.4.3 | `/inspect` confirmation | Focus went to the whole card | Focus goes to its heading, like `/estimate` and `/roof-check` step changes, so a screen reader announces "Pick your time, heading level 3" and reading on gives the next step |
| 13 | 2.2.2 | hero loop (homepage, 45 town pages, service heroes) | A muted loop longer than 5 s next to the page's words, with no way to stop it (reduced motion already showed the still) | `hero-video.js` adds a 44 px Pause/Play button (`aria-pressed`, label flips) in the hero's top-right corner once the clip plays; a pause holds for the visit (sessionStorage) on every page. On homepage phones the "crew I bring in" caption wraps short of it while the loop plays |
| 14 | 2.2.2, 2.4.3 | announcement bar | Rotated every 4 s with no pause. The homepage copy ignored reduced motion. ~190 town, service and blog pages ran **two** timers (an inline copy beside `ann-bar.js`, out of step). Hidden slides stayed in the Tab order, so focus could land on an invisible link | One rotation, in `ann-bar.js`: off under reduced motion and at phone width (where `nbd-nav.css` hides the bar or pins the seasonal slide), holds while hovered or focused, a "Pause announcements" button that appears when a keyboard reaches it, and `aria-hidden` + `inert` on the slides not showing, kept in step with whichever slide has `.active`. The six inline rotation copies are retired; the homepage now loads `ann-bar.js` |

Cache-busts that ride along, per `tests/asset-version-consistency-2026-11-14.test.js`: hero-video
`ASSET_VERSION` 2 → 3 (121 pages restamped, two lines each), `intake-extras.js` → `v=6` on every
reference (its `KNOWN_DRIFT` entry removed, as that suite asks), `intake-extras.css` v=3,
`roof-check.js` v=3, `inspect-form.js` v=14.

## Checked and fine (no change)

- **Headings:** one `h1` per page, no skipped levels on any of the six (computed from the live DOM).
- **Images:** every `<img>` has an `alt`; the hero loops are `aria-hidden`; the Thursday video has
  English captions (`<track kind="captions">`).
- **Language, titles, landmarks:** `lang="en"`, unique titles; landmarks per the 2026-11-06 pass.
- **Step focus:** `/estimate` and `/roof-check` already move focus to the new step's heading
  (`_focusStepHeading`, `focusEl`); confirmed by keyboard (`/estimate` Continue → "What Kind of
  Project?" `h2` focused; tiles are `role=button` with `aria-pressed`, Space/Enter work).
- **Touch targets (2.5.8, 24 px):** everything under 24 px is an inline link inside a sentence (the
  consent text's Privacy/Terms, source links) or a radio/checkbox inside a clickable label, which
  the 2.5.8 inline and enlarged-target exceptions cover. Buttons are 44 px or more.
- **Turnstile:** `public-lead-submit.js` renders it `size:'invisible'`, `execution:'execute'`, at
  submit time. No widget, checkbox or challenge is ever shown, so there is nothing to focus, label
  or trap; a failed or slow challenge resolves to an empty token after 6 s and the lead still goes
  through. Nothing to fix.
- **GA4 form-step events (#3286):** no element, id or class they read was renamed; `form_error`
  still fires with the same `fields` values on every path touched here.

## Brand pairings: what passes, what never can

| Pair | Ratio | Use |
|---|---|---|
| White on `#bd5728` (orange buttons) | 4.61 | OK for button text |
| `#bd5728` on white | 4.61 | OK for text and rings |
| `#bd5728` on off-white `#f5f3ef` | 4.16 | Large text and rings only; small text uses `#a14a22` (5.39) |
| `#bd5728` on navy `#1a3057` | **2.84** | **Fails even large text.** On navy use `#dd875f` (4.80). Rings get the white band (fix 1) |
| `#bd5728` on navy-dark `#12223d` | 3.45 | Large text and rings only |
| `#dd875f` on white / off-white | **2.73 / 2.46** | **Never on light backgrounds** |
| `#a14a22` on navy `#1a3057` | **2.19** | **Never on navy** |
| Navy-dark on `#bd5728` | 3.45 | Large text only |

These are properties of the locked palette, not bugs to fix: the fix is always picking the right
member of the palette for the background, which every page in scope now does.

## Keyboard-only and screen-reader sanity check

Run in Chromium (Playwright) against the local server, 390 and 1280 px. **No real screen reader was
run**: there is none in this sandbox. The screen-reader half is the browser's accessibility tree
(`ariaSnapshot`) plus the computed name, state and description of the focused element, which is
what VoiceOver and NVDA read. A VoiceOver pass on Joe's iPhone is still worth doing (leftover 1).

**Keyboard only:**
- Homepage, town and service pages at desktop width: first Tab is "Skip to content", then "Pause
  announcements" (a white pill with a navy ring), then the showing slide's link; hidden slides are
  skipped. At phone width, and on `/inspect`, `/estimate` and `/roof-check` (no rotating bar), there
  is no Pause stop. No focus stop on the six pages was invisible: each ring either measured 3:1 or
  more against what is behind it, or now has the white band between it and a dark or orange
  background (checked by screenshot on the chips, the jobs cards, the town-page CTA and the bar).
- Homepage hero: the Pause button is reachable, Enter pauses the loop (`video.paused === true`,
  label "Play background video", `aria-pressed=true`) and Enter again resumes.
- Quick form (homepage), Send with nothing filled: focus lands on First name; all three fields are
  `aria-invalid` and described by "Please add your first name, a 10-digit phone number, and your
  street address."; typing clears the field's state. Filled but no scheduling choice: focus goes to
  "Pick a date & time now" and the alert says "Choose how you'd like to schedule…".
- `/inspect`: same, with the scheduling message rendered right after the fieldset.
- `/roof-check` step 4: Send empty → First name focused, invalid, described by "Please add your name
  and a 10-digit phone."; clicking the "Mobile phone" label now focuses the field.
- `/estimate`: Continue empty → Home Address focused, invalid, described by "Please enter a valid
  address"; a valid step 1 → focus on the step 3 heading.

**Screen reader (accessibility tree):** each form exposes a named form or group, every textbox has
its visible label as its name with `[invalid]` after a failed Send, the scheduling block is a group
named "How should we schedule? *" with two named radios, the error is an `alert`, and the consent
checkbox carries the full consent text as its name.

## Visual baselines

`Visual regression (public pro pages)` covers `/` at 375/768/1280. Changes there that are intended:
the quick form's darker field edges (in the 375/768/1280 full-page shots). The hero Pause button and
the caption wrap appear only while the loop plays, and the spec stops the loop and removes
`is-playing` before capturing, so they are not in the baselines. The announcement Pause button is
off screen until focused. Re-bless only the `landing--*` sizes that fail, from this PR's CI run.

## Leftovers

1. **A real VoiceOver pass on an iPhone** (Joe's checklist in
   [a11y-audit-2026-10-23](../qa/a11y-audit-2026-10-23.md)): the tree check above stands in for it.
2. **Required marker on the quick form** is a bare `*` with no "* required" key. The fields are
   `required` (screen readers say so) and the asterisk is a common convention, but a key line would
   change the homepage form's height; left for a copy pass.
3. **`/estimate` address lookup offline:** when the lookup fails, focus stays on Continue while a
   "use my address as typed" option appears; whether that offer is announced was not checked (the
   lookup is an external call that was blocked locally).
4. **`/estimate` text-code boxes** keep 12% edges; the code check is switched off
   (`CONFIG.OTP_ENABLED`), so they never show. Fix it with the feature if it comes back.
5. **`/inspect`'s honeypot wrapper** still uses an inline `style` attribute (legacy; the inline-style
   ratchet only lets the count go down, so it was left alone, not added to).
