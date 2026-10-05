# Oaks Roofing & Construction — website

A complete, self-contained static website. No build step, no framework, no
server code. Every file you need is in this folder.

Built 2026-08-19 as a rebuild of the previous oaksroofingandconstruction.com,
reconstructed from archived copies of the old pages.

---

## What's here

```
index.html              Home
about.html              Who We Are
service-areas.html      Service Areas
gallery.html            Our Work
contact.html            Contact Us
privacy.html            Privacy Policy
404.html                shown for a bad/typo'd address
services/
  roof-replacement.html
  roof-repair.html
  siding-replacement.html
  siding-repair.html
  gutter-replacement.html
assets/
  css/site.css          all styling (one file)
  js/site.js            menu, gallery lightbox, form (one file)
  img/                  logo + every photo, as .webp with .jpg/.png fallbacks
logo-orange.svg         logo mark, vector
```

## How to put it online

Upload the **contents of this folder** to your host's web root (often called
`public_html`, `www`, or just the site root). That's it — `index.html` becomes
your home page.

It works on essentially anything: cPanel/shared hosting, Netlify, Cloudflare
Pages, GitHub Pages, Vercel, S3, or a plain Apache/nginx box. Nothing needs to
be installed or configured.

Every link inside the site is **relative**, so the folder works at a domain
root or inside a subfolder without editing anything. The one exception is the
quote form's lead intake (see below): it is served by the No Big Deal site, so
on any other host the form falls back to opening the visitor's mail app.

---

## Two things to do before launch

### The quote form — already connected (updated 2026-10-04)

The form appears on Home, About, Service Areas and Contact. When someone
presses *Send Message*, the request goes straight into the **Oaks company's own
CRM pipeline** as a new lead, and the new-lead alert goes to the inbox and phone
set in Oaks' company settings in the CRM. It uses the same lead intake as every
No Big Deal form: the page loads `/assets/js/public-lead-submit.js`, and
`siteKey: 'oaks'` in **`assets/js/site.js`** tells the server which company the
lead belongs to. The server checks that key against the companies registry, so
the lead is filed under Oaks and not under No Big Deal. Spam protection matches
the NBD forms: an invisible Cloudflare Turnstile check, a hidden honeypot field,
and a per-visitor rate limit on the server.

**Last-resort fallback.** If the request fails, the visitor's own mail app opens
with every field filled in and addressed to
**scott@oaksroofingandconstruction.com** (`formEmail` in `site.js`), and the
form shows the phone number. The same thing happens if this folder is hosted
somewhere that does not serve `/assets/js/public-lead-submit.js`. The intake
only accepts requests from the No Big Deal site's own web addresses, so a copy
uploaded to another domain will always use the mail-app fallback.

### 1. Turn on search engines

Every page currently carries this line in its `<head>`, which tells Google to
**stay away**:

```html
<meta name="robots" content="noindex, nofollow">
```

That is deliberate — it stops this copy competing with your real site while it
is staged. **Delete that line from all 11 pages when you go live.**

While you're in each `<head>`, uncomment the two lines below it and swap
`https://example.com` for your real domain:

```html
<link rel="canonical" href="https://example.com/...">
<meta property="og:url" content="https://example.com/...">
```

Those control which URL Google treats as official, and what shows up when
someone shares a link on Facebook or in a text message.

### 2. Check the Privacy Policy

`privacy.html` is an honest, plain-English description of what this site
actually does (a form, no trackers, no cookies beyond one that remembers you
closed the top banner) and how the form delivers. Have someone you trust read it
before launch.

It points people at the phone number for a deletion request rather than at your
email address, so the address is not sitting on a page for spam bots to scrape.
Say the word if you'd rather it were listed there and on the Contact page.

---

## Editing content

Everything is plain HTML — open a page in any text editor and the words are
right there. Some notes:

- **Phone number** appears in several places per page. It's written twice each
  time: once as visible text `(513) 827-5297`, once as a link
  `tel:+15138275297`. Change both.
- **Colors and fonts** are all at the top of `assets/css/site.css` under
  `:root`. The brand orange is `#fa6404`, taken from your logo.
- **Photos** live in `assets/img/`. Most are saved twice — a `.webp` (smaller,
  modern browsers) and a `.jpg` (fallback). If you replace a photo, replace both,
  or delete the `<source>` line and keep only the `.jpg`.
- **`logo-white.png`** is not used by any page. It's the all-white version of your
  logo, recovered alongside the orange one — keep it for dark photos, shirts,
  vehicle wraps, or anywhere the orange wordmark won't read.
- **The header, footer and top banner** are copied into every page rather than
  shared from one file. That's what makes the site work anywhere with no build
  step — the trade-off is that a change to the menu must be made in all 11
  pages. Search-and-replace across files handles it.
- **The service-area map** (`assets/img/service-area-map.jpg`) is an image, not
  a live map. Replace it if your coverage changes.
- **`404.html`** is what visitors see if they mistype an address or follow a dead
  link. Netlify, Cloudflare Pages, GitHub Pages, Vercel and most cPanel/Apache
  setups pick it up automatically — nothing to configure. It is deliberately
  self-contained (its styling and logo are inside the file) because a 404 gets
  served in place of *any* missing address, at any depth, so it cannot rely on
  the shared stylesheet the way the other pages do. It offers the phone number
  rather than a "back to homepage" link, for the same reason.

## Adding gallery photos

In `gallery.html`, copy one `<button>` block and point it at your new image.
Each tile needs a full-size file and a cropped thumbnail:

```html
<button type="button" data-full="assets/img/NEW.jpg" data-alt="What the photo shows">
  <picture>
    <source srcset="assets/img/NEW-thumb.webp" type="image/webp">
    <img src="assets/img/NEW-thumb.jpg" alt="What the photo shows" width="760" height="570" loading="lazy">
  </picture>
</button>
```

Thumbnails are 760×570. The lightbox picks up new tiles automatically.

---

## Notes

- The site needs no JavaScript to be readable. JS only powers the mobile menu,
  the gallery lightbox, the "Load More" areas button, and the form.
- All content and photography came from your previous site. No claims, prices,
  warranties, or credentials were invented — the only figures used are the ones
  the old site published (5-year labor warranty, 30-year shingle warranty,
  50-year siding warranty, 5.0/5.0 from 13 customers).
- Tested at desktop, tablet and phone widths, in light and dark system themes.

Questions: Jo Deal — No Big Deal Home Solutions.
