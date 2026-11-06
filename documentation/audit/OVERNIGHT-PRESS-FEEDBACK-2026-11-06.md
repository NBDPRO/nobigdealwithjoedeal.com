# Overnight 2026-11-06: press feedback is a small scale, not a 1 px nudge

Primary buttons, the form submit and the sticky phone strip (Book / Call / Text)
moved down 1 px on press, which is barely visible on a thumb. `docs/assets/css/nbd-mobile.css`
now scales them to 0.97 while pressed (the Book and Call strip buttons are new
to the list). Only the `:active` state changed, so hover, focus and layout are untouched.
The global reduced-motion rule still applies to any transition.

Source of the idea: a short-form video list of UI motion rules (press scale about 0.97, ease-out
entrances, no bounce in everyday UI). The numbers are rules of thumb, not standards; this
change is the one cheap item that fit a static marketing site.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
