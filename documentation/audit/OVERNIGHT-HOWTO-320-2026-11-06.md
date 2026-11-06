# Overnight 2026-11-06: /pro/how-to at 320 px

A 320 and 360 px overflow/clipping sweep of the public Pro pages found one: `/pro/how-to` scrolled sideways by 29 px at 320 px. The sticky top bar
(back link, brand, Tour, CRM) measured 324 px, so the CRM button ran off the edge and the brand wrapped to "HOW / TO"; two long `<code>` paths ran past the
margin, and a "workmanship/material" token overflowed its pill by 7 px. One `max-width: 360px` block in the page's own CSS: tighter top-bar padding and gaps, a one-line brand,
and `overflow-wrap: anywhere` on the code spans and pill text. Measured at 320 and 360 px: no horizontal overflow, no clipped text on any public Pro page
(`/pro/`, register, pricing, how-to, terms, login, understand, refer, sandbox); the top bar now ends at 308 px. Layout above 360 px is unchanged.
Back to [INDEX](../INDEX.md).
