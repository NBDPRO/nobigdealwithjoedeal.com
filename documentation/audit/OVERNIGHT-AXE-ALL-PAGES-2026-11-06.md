# Overnight 2026-11-06: axe on all 298 public pages (390 px)

Axe-core (every rule) over every public page found three issues: `region` on 296 pages (the sticky CTA strip, fixed by
the landmark-roles change), `heading-order` on `/blog/roof-financing-cincinnati-explained` and `image-redundant-alt` on `/review`.
The last two are fixed here. The blog "How It Works" fact-box title was an `<h4>` straight under an `<h2>`; a plain
`<h3>` would have picked up a `main h3 { font-size: ... !important }` rule and grown from 11.52 px to 16.8 px, so it is now
`<span class="fact-title">` with `display: block` and the same CSS (measured identical: 11.52 px, uppercase, 700, same colour).
On `/review` the footer logo `<img alt="No Big Deal Home Solutions">` sits next to the visible "NO BIG DEAL" text, so its alt is
now empty (decorative). Both pages measure axe-clean. Back to [INDEX](../INDEX.md).
