# Umami: cookie-free page analytics (prepared 2026-10-16, OFF)

Umami counts page views and clicks without cookies or personal data. It is
wired up but switched off. Nothing loads until Jo creates a website in Umami
and runs one command in a PR. It only ever runs on the public homeowner site:
never /pro, /admin, /dev or /sites, never on previews or localhost, and never
for a visitor whose browser sends Global Privacy Control or Do Not Track.

## What is in the repo

| Piece | What it does |
|---|---|
| `docs/assets/js/umami-loader.js` | Inert while `WEBSITE_ID` is empty. When set, adds Umami's `script.js` with the guards above. |
| `scripts/umami.mjs` | `--status`, `--enable <website-id> [--host https://...]`, `--disable`. |
| `tests/umami-2026-10-16.test.js` | Checks that it is off today, that the guards work, and that enable then disable round-trips byte for byte on a copy. |

`--enable` does three things and `--disable` undoes all three:

1. It fills `WEBSITE_ID` and the script URL in the loader.
2. It adds the loader tag right after the Clarity loader tag on every public page (218 today).
3. It adds the Umami host to `script-src`, `script-src-elem` and `connect-src` of the public CSP policies in `firebase.json` only. The /pro, /admin, /dev and /sites policies never get it.

## Option 1: Umami Cloud (recommended)

1. Jo signs up at umami.is and adds the website `nobigdealwithjoedeal.com`.
   The Hobby plan is reported free up to 100,000 events a month; check the
   current limits on umami.is before relying on that.
2. Copy the website ID (a UUID) from Settings > Websites.
3. In a branch: `node scripts/umami.mjs --enable <website-id>`, then commit
   and open a PR. The CSP gains `https://cloud.umami.is`.

Nothing to run, patch or back up, and it works whether or not any machine at
home is on.

## Option 2: self-host on the MSI Ubuntu server

Only worth it if the server is truly always on **and** reachable from the
public internet. Homeowners' phones send the page views, so a tailnet-only
or LAN-only address cannot work.

What it needs:

- **Umami v3 + PostgreSQL** (v3 dropped MySQL). Docker Compose from the
  Umami docs is the simplest setup. Back up the Postgres volume.
- **A public HTTPS name**, for example `stats.nobigdealwithjoedeal.com`, with
  either:
  - a **Cloudflare Tunnel** (`cloudflared`): no open router ports and a free
    TLS certificate. This is the safer choice, or
  - port forwarding 443 to the server with Caddy or nginx and Let's Encrypt.
    That exposes the home IP and router, so harden it.
- Then: `node scripts/umami.mjs --enable <website-id> --host https://stats.nobigdealwithjoedeal.com`.

Trade-offs: if the server sleeps, reboots or loses power, visits during that
time are simply not counted. Patching Umami, Postgres and the OS is on Jo.
The tunnel or open port is a new public surface on the home network.

**Recommendation:** use Umami Cloud unless Jo sets up a Cloudflare Tunnel and
wants to run Postgres himself.

## Turning it off

`node scripts/umami.mjs --disable` in a PR. It removes the tag from every page,
the host from the CSP and the ID from the loader.

## Not done here

No account was created and no website ID exists. GA4 and Clarity are
unchanged. Keep GA4 if Google Ads conversions depend on it.
