# NEXT_SESSION — 2026-10-01 part 4 (the 10-01 afternoon and evening, Jo answering live)

Follows [NEXT_SESSION-2026-10-01-part3](NEXT_SESSION-2026-10-01-part3.md).
Jo asked for three things:
- kanban boards that work, so "All" isn't the only usable board;
- a way to sort the 118 customers who have no job type;
- the **Call Center**: every phone call and text into the CRM, AI-sorted and
  AI-noted, with a twice-daily reminder of anything Jo promised on a call.

Everything below is merged and deployed.

## §0 Read first

- **Never type `git worktree remove` outside the unlink-first PowerShell
  loop.** It happened a fourth time today: `--force` followed the
  `node_modules` junctions and emptied the main checkout's `functions/` and
  `tests/` packages. See the worktree-path-length-limit memory note and
  `documentation/audit/GIT-PHANTOM-MODIFICATIONS-2026-09-05.md` for the EOL
  side.
  - **Recovery gotcha:** `npm ci` *inside the main checkout* installs that
    checkout's branch lockfile, which today was an old docs branch, so
    `qrcode` was missing. Rebuild from `origin/main`'s package files in a
    short temp dir instead, then swap the contents in place.
  - That reinstall bumped Playwright to 1.63. The browser download from
    cdn.playwright.dev times out on this machine, and **a failed
    `playwright install` still deletes the old browser builds**, so local
    browser E2E is down until a browser is fetched. Google's
    Chrome-for-Testing bucket answers, but ask Jo before downloading
    ~100 MB. CI runs every browser spec meanwhile.
- **Shared counters, again.** PRs that each add tests hit the same `FLOORS`
  line, the authed spec list and the `CRON_GATES` count pin. Identical bumps
  merge *clean but wrong*. After every merge of main:
  - run `node scripts/run-test-manifest.js --check`;
  - run `tests/cron-gate-drift.test.js`;
  - re-bump any `?v=` that both sides changed.
- **Cube ACR sidecars carry Jo's location.** Each recording has a `.json`
  next to it that includes `loc` (lat;lng) and `addr` (a street address).
  `parseSidecar` keeps **only** the duration, and a test proves `loc`/`addr`
  never reach Firestore. Keep it that way.
- **Short codes are never stored** (2FA codes, bank and delivery alerts).
  This is break-tested in `text-inbox-logic`.

## §1 What shipped

**Kanban board logic: #1971.** See
[KANBAN-BOARD-LOGIC-2026-10-01](../audit/KANBAN-BOARD-LOGIC-2026-10-01.md).
- Insurance, Cash and Finance boards gain Installing and Closed columns.
- All gains Contacted.
- `resolveColumn` stage families fold a stage a board lacks into that
  board's equivalent column, instead of dropping it into New.
- A visibility sweep found every card visible across 12 themes and 12
  shapes.

**Sort my customers: #1973.**
- `suggestJobType` places 107 of the 118 untyped customers. Most are
  Thumbtack repair requests, so Service.
- A banner over the board leads to a screen with the suggestions, their
  reasons, a per-row picker and bulk set. Saving writes only the rows with a
  type picked.
- New leads must now pick a job type.
- **Jo has not sorted yet.** That is Jo's tap.

**Call Center.** See
[CALL-CENTER-2026-10-01](../architecture/CALL-CENTER-2026-10-01.md) for the
whole design.

| PR | What |
|---|---|
| #1972 | `callCenterIngest`: Cube ACR recordings from Drive into `phone_calls` plus private Storage, every 30 min; customer-card playback |
| #1974 | `callCenterTranscribe`: Groq Whisper transcript, Claude Haiku notes (summary, You/They promises, follow-up, urgent), a timeline entry, and one create-only task |
| #1975 | The Call Center screen (`#/calls`), the `callCenterAction` callable, the `callCenterSweep` email, and sidecar call lengths (calls under 15 s are marked short) |
| #1978 | Ingest turned on; personal calls get their CRM audio copy deleted |
| #1979 | Transcripts and the sweep email turned on; **tasks only for calls from the last 14 days** |
| #1977 | `textInboxIngest`: texts from the SMS Backup & Restore Drive backup into `phone_texts`; a texts thread on the customer page. **Dry-run.** |

**Live state** at about 01:20 UTC on 10-02, counts only:
- 488 calls are copied; the 90-day backlog is done.
- 94 calls are transcribed, 5 of them personal.
- There were 0 errors.
- 44 calls contain promises Jo made.

Transcription hit its **6 h-a-day audio cap** (`DAY_AUDIO_SEC_CAP`), as
designed. It resumes at midnight ET, and about 320 calls remain, so 3–4
days. Groq's free tier allows 8 h/day if Jo wants it faster.

**One-call test** (Jo approved). A 63 s customer call produced a correct
summary and promises. It also made **one stale task dated Jul 14** on that
customer, which is why the 14-day rule exists. Jo was told to tick it off.

## §2 Jo's open items

- **Texts:**
  1. Install **SMS Backup & Restore**.
  2. Schedule a Messages backup to Google Drive.
  3. Share the **SMSBackupRestore** folder with
     `717435841570-compute@developer.gserviceaccount.com` as Viewer.
  4. Then read the dry-run counts on `integrations/textInbox` and flip
     `TEXT_INBOX_ENABLED`.
- **Sort my customers:** tap the banner on the board.
- **Clarity:** the project ID (from part 3).
- **Optional:** fetch the Playwright browser (§0) so local E2E works again.

## §3 Next lanes

- **Texts into the sweep:** the model reads each customer's day of texts
  for promises.
- **MMS photos:** EXIF-strip them before any copy.
- **Personal-call misjudgements:** an "it wasn't personal" action that
  re-runs the notes. The original is still in Jo's Drive.
- **Daily cap:** consider raising `DAY_AUDIO_SEC_CAP` to 7.5 h (Groq free
  tier is 8 h).
