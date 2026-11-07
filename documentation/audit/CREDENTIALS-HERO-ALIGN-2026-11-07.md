# /credentials: hero text sat 50px right of the content below it (2026-11-07)

Found in a 1440 px desktop screenshot. `.cred-hero-inner` was `max-width: 900px`
and `.cred-section-inner` was `max-width: 1000px`; both are centered, so the
hero title and paragraphs started 50 px to the right of the cards and group
headings (x=270 vs x=220 at 1440).

Fix: `.cred-hero-inner` is `max-width: 1000px` in
`docs/assets/css/credentials.css`. Paragraph measure is unchanged (`70ch`
cap). Left edges now match at 1440, 1024 and 390 (220/51/16 px for both), no
horizontal overflow. Pre-push gates and `tests/credentials-2026-10-13.test.js`
pass.
