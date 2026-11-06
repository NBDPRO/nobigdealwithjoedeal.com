# Overnight 2026-11-06: three hero gradients no longer wash out to grey-peach

On a 1440 px full-page screenshot of `/free-roof` the hero faded from navy into a grey-pink corner. The gradient's last
stop is `rgba(189,87,40,.15)` (orange at 15 percent) with nothing under it, so it blended with the white page behind
the hero instead of with navy. `/book`, `/free-roof` and `/free-tools` share that exact rule; each now has a navy
base colour under the gradient, so the corner is the intended deep navy with a faint warm tint. Same
rule on the city-page heroes is untouched: those sit over a photo.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
