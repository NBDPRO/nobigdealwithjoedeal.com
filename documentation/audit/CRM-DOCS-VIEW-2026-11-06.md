# Docs view and CSV import — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06. The harness and the findings index ship in
[NBDPRO/nobigdealwithjoedeal.com#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938).
Test: `tests/docs-view-2026-11-06.test.js`. It passes 16/16 on this branch. Against main's
code, 13 checks fail; the 3 that pass are the positive controls.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| VW-F50 | `dashboard-ui.js` | The Template Library says "Use the **Blank** button to print an empty copy", but no Blank button ever existed. Two reasons: the injector ran once at script load, while the rows were still inside the un-hydrated `tpl-view-docs` template, and it matched an `onclick="fillAndGenerate('x')"` the rows no longer carry (they are `data-action="docgen" data-target="x"`). So `NBDDocGen.generateBlank` was unreachable (QA d5-docs-034). | `_injectBlankButtons()` is now a named, idempotent function. It reads `data-target`, and `goTo('docs')` calls it after hydration. |
| VW-F53 | `dashboard-actions.js`, `dashboard-api.js` | Uploaded Documents loaded only after an upload in the same session. Nothing called `loadDocs()` when the view opened, so existing uploads always showed "No uploaded documents yet". A failed read logged to the console only. | `goTo('docs')` calls `loadDocs()`. A failed read now says so in the panel. |
| VW-F155 | `data-import.js` | Closing the import modal mid-run set `modalEl` to null while the run went on. `renderDoneStep` then threw, so the user never saw the counts, and a modal reopened meanwhile got the old run's result. | The run remembers its own modal. It paints the result only into that modal if it is still open; otherwise the counts arrive as a toast. The import itself still runs to the end (rows already written can't be un-written). |

Not done here: a `limit()` on the Uploaded Documents query (VW-F53's third suggestion).
It needs a sort order, and an `orderBy` on a field some old docs may lack would hide them.
Left as a proposal.
