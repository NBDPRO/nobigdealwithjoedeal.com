# Overnight 2026-11-06: the /blog/ sidebar was stuck at the bottom of the page

Found by reading a 1440 px full-page screenshot: the post list sat in a 680 px column with a
320 px blank column beside it. `.blog-main` is a two-column grid (posts | sidebar), but the markup
put the `<aside class="sidebar">` and the Google-reviews strip INSIDE `<main class="blog-grid">`,
so the grid's second column was empty and the "Got a Roof Question?" call-to-action and the
category and area links sat at the very bottom of a 10,000 px page (about 10146 px down at 1440).
Now: `</main>` closes right after the posts, the aside is the second child of `.blog-main`
(right column on desktop, as the CSS intended), `.blog-main` closes after the aside, and the reviews
strip follows full width. Only three tag moves outside the generated regions: the blog-index markers
and the reviews-strip partial are untouched, and `apply-partials --check` is clean.

Checked at 1440, 1024, 768 and 390 px: two columns at 1024 and up, stacked below that, no sideways
overflow, one `<main>`. On phones the sidebar still comes first (the page's own `order:-1`); that was
already true before and I left it.

Related: [UI sweep](UI-SWEEP-2026-10-24.md).
