# Overnight 2026-11-06: /pro/login desktop layout restored

At 1440 px the CRM sign-in page rendered as one stacked column (brand hero on top, a 1,330 px-wide form below, page
1,385 px tall) instead of the designed split (brand panel left, 500 px form panel right). Cause: #2727 wrapped both
panels in `<main id="main">`, so the `body { display: grid; grid-template-columns: 1fr 500px }` rule saw one child, and
`nbd-mobile.css` (`body { display: flex; flex-direction: column }`, linked later) overrode the body grid anyway.
Fix in `docs/pro/login.html`: the grid moves to `#main` (an id selector beats the body rule), with a
`#main { grid-template-columns: 1fr }` override inside the existing `max-width: 900px` query. Measured with Playwright:
1440 px grid `940px 500px`, page height 900 px (fits one screen), no horizontal overflow at 1440, 1024, 901, 899 and 390 px;
phone layout unchanged (single column, 1,119 px). Markup, auth script and copy are untouched. Back to [INDEX](../INDEX.md).
