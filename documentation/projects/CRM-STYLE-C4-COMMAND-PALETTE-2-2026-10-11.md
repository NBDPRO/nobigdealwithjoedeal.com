# CRM style integration C4 — Command palette 2.0 (2026-10-11)

Slice C4 of the CRM style integration (Grok idea #07, Jo-approved 2026-10-11;
roadmap: the C-track in `CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md`). Lane
"habits".

## What shipped

The Cmd+K palette (`command-palette.js`, W133) keeps working unchanged; a second
layer (`command-palette-scopes.js`, `window.NBDCommandX`) is injected the first
time the palette opens, so there is **no new boot script** and the boot budget
is untouched. If it fails to load, the palette is exactly what it was.

| You type | You get |
| --- | --- |
| `@maya` | people: customers by name / phone / email / address |
| `#` or `#4106` | jobs: customers whose job is in a job stage |
| `>` | actions, the ones you use most first; a pinned lead's actions on top |
| `t:` / `t:gold` / `theme: paper` | themes (`ThemeEngine.getAll()`), current first, locked ones marked with what unlocks them; **highlighting a row previews it live**, Enter applies, Esc drops the preview |
| `= 32.4 sq x $485` | `$15,714`; Enter copies it |
| anything else | the classic mixed list, plus a math answer when the text is clearly a calculation (a `$`, `x`/`*`, or a unit; never a phone number) and up to 3 theme matches |

- **Actions for a lead:** Tab on a lead row pins it (a chip appears; Backspace
  on an empty box or tapping the chip un-pins). The customer page pins its own
  lead on open. Built-in lead actions reuse the CRM's own openers (View details,
  Edit lead, Add task, Call, Copy phone / address, Open in Maps, Copy / Text /
  Email portal link). **Draft-only:** "Text" and "Email" open the rep's own
  message / mail app; nothing sends from the palette. Other modules add their
  own with `NBDCommand.registerLeadAction({id, label, icon, keywords, when(lead),
  run(lead)})`. Every action's `run` now receives the pinned lead (or
  `undefined`), so the existing `registerAction` actions are unaffected.
- **Usage ranking:** per-device counts in `localStorage` (`nbd_cmd_usage_v1`,
  capped at 150 ids); 3 points per use up to +20 on a match, and a "Most used"
  group on an empty box after Recent.
- **Math is a parser, not `eval`:** a hand-written tokenizer + recursive descent
  over numbers, `$`, units (`sq`, `sqft`/`sf`, `lf`/`ft`), `+ - * / x × ÷ ^ ( ) %`,
  `k` (15k), `per`, and `in` / `to` conversions (`2400 sqft in sq`). Money is held
  in cents and rounded once at the end ($19.99 x 3 = $59.97, $0.1 + $0.2 = $0.30).
  A bare `$` times an area reads as a rate (`32.4 sq x $485`). Input is capped
  (120 chars, 60 tokens, 16 bracket levels). A test asserts the file never calls
  `eval` / `Function`, and a break-test of the unit table found that a word like
  `constructor` resolved through `Object.prototype`: fixed with `hasOwnProperty`.
- **Trophy Case hook:** a locked theme row opens `NBDTrophyCase.open()` when C3
  has landed, else toasts the unlock condition.

## Where things live

| Piece | File |
| --- | --- |
| Scopes, math, themes, lead actions, usage | `docs/pro/js/command-palette-scopes.js` |
| Rows, chips, hints (tokens only; injected as a `<link>`) | `docs/pro/css/command-palette-scopes.css` |
| Hooks (10 small edits) | `docs/pro/js/command-palette.js` |
| Test | `tests/command-palette-scopes-2026-10-11.test.js` |

## Not done

- A "selected lead" tie to the pipeline board's selected card (the pin comes from
  Tab in the palette or the open customer page).
- Moving a card to the next stage from the palette (the stage-move rules,
  required fields and the Kentucky gates live behind the card's own flow).
- Re-skinning the palette's old inline-style markup into classes (the new layer
  adds none; the ratchet is unchanged).
