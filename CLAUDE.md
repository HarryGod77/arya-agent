# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Arya Agent ("Harry's Control Room") — a single-process Node.js automation server for a mentalism/magic
class business: schedules classes with auto-generated Google Meet links, sends WhatsApp/email
reminders, delivers recordings from Google Drive, and auto-posts videos to Facebook/Instagram/YouTube
with Gemini-generated captions. Built for one operator (Harry Rajput, managing Arya's classes), not
multi-tenant. Comments/docs in the repo mix English and Hindi (Hinglish) — this is intentional, not
a translation gap.

## Commands

```bash
npm install
cp .env.example .env   # fill in credentials — see README.md section-by-section walkthrough
npm start               # runs node server.js, listens on PORT (default 3000)
npm run chat:test       # terminal chat simulator for the lead responder — no WhatsApp needed, see below
```

There is no build step, linter, or test suite configured in this repo — `npm start` is the only
server script. Verify changes by running the server and exercising the affected route/job manually
(see "Manually triggering jobs" below), or for anything touching lead replies, `npm run chat:test`.

The admin panel is at `http://localhost:3000`, gated by `ADMIN_PASSWORD` from `.env`. First run
needs a WhatsApp QR scan at `http://localhost:3000/qr` (also printed to terminal).

## Architecture

**Single Express server (`server.js`) + a handful of `src/` integration modules, no framework, no
build tooling.** Everything is ESM (`"type": "module"`). Persistence is a flat JSON file
(`data/db.json`) via `src/store.js` — no database. Reads/writes are synchronous and whole-file;
`update(fn)` reads, mutates, writes back. `sentLog` in the store is a dedupe map so scheduled jobs
never resend the same reminder/recording twice (`alreadySent`/`markSent`, keyed like `rem:<classId>:<windowMinutes>`).

**Data model** (`data/db.json`): `batches[]` (a batch = a group of students with emails +
optional WhatsApp group JID + Drive folder), each batch has `classes[]` (topic, start time, Meet
link, calendar event id, recording link, status). `config` holds cron/social toggles.

**`server.js`** wires up all REST routes under `/api/*`, all gated by the `auth` middleware which
checks the `x-admin-pass` header against `ADMIN_PASSWORD` (except `/api/login` and `/qr`). It also
duplicates some Hinglish message-formatting logic (`classAddedMessage`, `classCancelledMessage`,
`recordingMessage`) that also exists in `src/scheduler.js` — these are two independent code paths
(one triggered by API calls, one by cron), not shared helpers. If you change wording in one, check
whether the other needs the same change.

**`src/scheduler.js`** is the automation core, driven by `node-cron`:
- `checkClassReminders` — every minute; walks all batches/classes and fires WhatsApp+email at
  fixed lead-time windows (24h, 3h, 1h, 10min, 2min before start), skipping windows that had
  already passed when the class was created.
- `checkRecordings` — every 15 min; matches files in the Drive "inbox" folder to finished classes
  by filename-contains-topic + creation-time window, then moves the file into the batch's Drive
  folder and notifies.
- `runSocialPost` — daily at 10:00 IST; pulls from a Drive "post queue" folder, generates a
  caption via `src/gemini.js`, posts to enabled platforms via `src/social.js` (Facebook/Instagram)
  and YouTube upload (intended to live in `src/google.js`), then moves the file to a "posted"
  folder.
- `jobs` is exported so `server.js` can trigger any of the three manually via
  `POST /api/run/:job` (used by the admin panel's "Run & Tools" tab).

  **Known gap:** `runSocialPost` calls `G.listPostQueue`, `G.downloadStream`, and `G.uploadYouTube`,
  none of which are currently defined in `src/google.js`. Social posting to YouTube via the
  scheduler will throw until these are added.

**`src/google.js`** wraps all Google APIs (Calendar+Meet, Drive, Gmail, YouTube search) behind a
single OAuth2 client built from `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` —
one refresh token covers every Google service. `createClassEvent` is what generates the Meet link
(via Calendar API `conferenceData`). Folder organization by naming convention lives here too
(`ensureFolder`, `classify`-driven paths from `server.js`).

**`src/whatsapp.js`** uses Baileys (unofficial WhatsApp Web protocol) against the operator's own
number — session persisted to `data/wa-auth/` (gitignored, contains live session keys — never
commit or expose this directory). `sendMessage` has a safety toggle: `directToGroup` false (default)
sends to the operator's own Note-to-Self chat instead of the real group, to avoid accidentally
spamming/banning during testing; `config.whatsappDirectToGroup` in the DB controls this globally.
Group send failures fall back to self-send rather than silently failing. Beyond batch notifications,
this file is also the transport layer for the lead responder (see below) — it deliberately has zero
knowledge of leads/Gemini/business rules, only exposing primitives (`isSavedContact`,
`isContactCacheReady`, `sendWithTypingDelay`, `sendToOperatorAlert`, `setInboundMessageHandler`,
chat-cache reads) that `src/leadResponder.js` and `src/backlogScan.js` build policy on top of.

**`src/social.js`** posts directly to the Meta Graph API via raw `fetch` (no SDK). Instagram/FB
Reels require a **publicly reachable** video URL — the code builds this from a Drive direct-download
link, which Meta sometimes rejects for large files (documented gotcha in README).

**`src/gemini.js`** calls the Gemini REST API directly (no SDK) to generate a JSON caption/hashtags/
description blob for a given filename+platform; falls back to a canned caption if `GEMINI_API_KEY`
is unset or the call fails — social posting should never hard-fail just because captioning did.

**`public/`** is a static, framework-free admin panel (`index.html` + `app.js` + `styles.css`)
served directly by Express from `public/`. It's a single-page tab UI (Batches / Leads / Settings /
Actions) that calls the `/api/*` routes with the passphrase in the `x-admin-pass` header, stored
only in a JS variable (re-entered each page load).

## Lead Responder — AI auto-responder for inbound WhatsApp DMs

A second automation subsystem layered on top of the batch/class one above: when an unknown number
messages the connected WhatsApp account, this classifies whether it's a genuine course inquiry and
(subject to heavy safety gating) drafts or sends a reply, tracks the lead through a state machine,
follows up if they go quiet, and can rediscover old unanswered chats. It spans several files that
only make sense together — start with `src/leadResponder.js#handleInboundMessage`, which is the
one function that calls into everything else in order.

**Files, by role:**
- `src/leadStore.js` — data layer for `data/leads.json` (lead records + backlog queue) and the
  append-only `data/lead-log.jsonl` audit log. Same read-modify-write pattern as `store.js`, but
  deliberately a *separate* file/store so high-churn chat data can never risk corrupting
  batch/class data on a bad write.
- `src/gemini.js` (the lead-responder half, below the caption-generation code) — `classifyIntent`
  and `generateReply`/`generateFollowUp`, using two **pinned, non-"-latest"** models
  (`GEMINI_CLASSIFY_MODEL`/`GEMINI_REPLY_MODEL` in `.env`) — pinned on purpose, because a floating
  alias silently rotating onto a new release with a starved free-tier quota is exactly what broke
  this once already. `GeminiQuotaExhaustedError` on an unrecoverable 429 turns into a graceful
  "skip and flag" result everywhere, never a crash.
- `src/leadResponder.js` — the orchestrator; owns the config (`config.leadResponder` in
  `data/db.json`: `mode`, `dailyCap`, `silentHours`, `paymentAutoSend`) and the full gate chain
  (next section).
- `src/backlogScan.js` — separately scans existing chats (not just new inbound messages) for old,
  unanswered, course-related ones and re-engages them, rate-limited.
- `src/scheduler.js` — gained lead-related cron jobs: hourly follow-up check, 10-min pending-send
  flush, weekly unanswered-questions digest, daily backlog scan, 15-min backlog send-tick.
- `server.js` — wires `setInboundMessageHandler(leadResponder.handleInboundMessage)` at boot (this
  is the one line that makes the whole subsystem live — easy to accidentally remove/miss when
  refactoring startup) and exposes `/api/leads/*` + `/api/backlog/*`.
- `data/course-knowledge.md` — **the single source of truth for facts, tone, and behavior rules.**
  Read fresh on every Gemini call, no caching, no restart needed. The design principle throughout:
  code only decides *which mode* to generate in (greeting vs. normal vs. payment-eligible); the
  actual wording, tone, pacing, and business rules live entirely in this file. When asked to change
  how the bot talks, edit this file, not a prompt string in `gemini.js`.

**The gate chain in `handleInboundMessage`, in order (each one can end processing early):**
1. `WA.isContactCacheReady()` — **fail-closed**: if Baileys' contact sync hasn't populated yet
   (fresh install, or `data/wa-contacts.json` missing), silently do nothing for *anyone*, not just
   unknown numbers. This existed because defaulting an unpopulated cache to "not a saved contact"
   would have sent real contacts' messages to Gemini — a deliberate correction, not the original
   design.
2. `WA.isSavedContact(jid)` — hard skip for anyone in the phone's saved contacts, before any Gemini
   call. Recoverable via the Leads tab's "treat as lead" button if a real lead gets misclassified.
3. Manual override (`lead.manualOverride === 'ignore'` or `state === 'converted'`).
4. Daily new-lead cap (`getDailyCount()` vs. `config.leadResponder.dailyCap`) — gates *new* leads
   only; an already-tracked lead's conversation always continues regardless of the cap.
5. Classify (`class_inquiry` / `greeting` / `not_related` / `unclear`) — `not_related` stays
   silent, `unclear` notifies the operator and stays silent, only the first two proceed.
6. Generate reply — `escalate`/`escalateType` (hard-stop vs. unanswered-question, feeds the weekly
   digest), `hotLead` (buying-signal alert to `OPERATOR_ALERT_NUMBER`, independent of escalate),
   and `paymentDetailsIncluded` (see Payment Details below) all come out of this same call.
7. Deliver — silent hours (`config.leadResponder.silentHours`, IST, computed via fixed UTC+5:30
   offset arithmetic, not `Intl`) defer to `lead.pendingSend` instead of sending; otherwise DRAFT
   mode notes the operator's own Note-to-Self, AUTO mode sends the lead directly with a randomized
   20–90s typing delay. **A failed delivery is never recorded as sent** — `appendMessage`/state
   only advance on confirmed success, everywhere in this subsystem, so a transient failure retries
   next tick instead of corrupting history or losing the message.
8. State transition (`new → informed → interested`, `→ silent` after a follow-up, `→ converted`
   only ever set manually via the panel — the bot can't detect payment/enrollment itself).

**Payment Details Auto-Send is guardrailed in code, not just prompted.** `data/course-knowledge.md`
has a `## PAYMENT_DETAILS` section that ships empty; `gemini.js` physically splits it out of the
knowledge base text sent on every normal call and only includes it in a prompt when
`leadResponder.js` has already confirmed in code that `config.leadResponder.paymentAutoSend` is on
**and** the lead has 3+ prior real replies — the model cannot leak what it was never given,
regardless of how a message is worded. `gemini.js` re-checks the section is non-empty independently
of that gate too. Defaults off.

**Fail-closed data files, all separate from `data/db.json`, all gitignored (third-party PII —
phone numbers, saved names, chat transcripts):** `data/leads.json` (lead records + backlog queue),
`data/lead-log.jsonl` (append-only audit log, one JSON line per decision — the diagnostic tool of
first resort when something didn't fire as expected), `data/wa-contacts.json` (persisted contact
cache, the fail-closed gate's memory across restarts), `data/wa-chat-cache.json` (last message per
1:1 chat, seeded from Baileys' `messaging-history.set` on connect, feeds `backlogScan.js`).

**Known limitations, not yet resolved:**
- Baileys' `messaging-history.set` event (backlog scan's data source) has never been exercised
  against a real, live WhatsApp connection in development — only its persistence/update logic was
  testable without one. Watch this specifically on first real deploy.
- The Leads tab (`public/`) was built and its API responses verified by hand, but never
  interactively tested in an actual browser — no browser automation was available when it was
  built. Click through it once before trusting it fully.
- `npm run chat:test` exercises `classifyIntent`/`generateReply` directly and is the fastest way to
  iterate on `course-knowledge.md` wording — it does not touch `data/leads.json` or WhatsApp at all.

## Payments / Invoicing

A small subsystem layered on the lead responder: when a lead sends a WhatsApp image (a
payment screenshot, almost always with no caption), the bot alerts the operator but
**never confirms payment or generates anything itself** — invoice generation only ever
runs from the operator's explicit "confirm payment" action in the Leads tab.

- `src/whatsapp.js` — `messages.upsert` now detects `m.message.imageMessage` (`hasImage`)
  and lets an inbound image through even with empty `extractText()` output, so a bare
  screenshot isn't silently dropped before it reaches the lead responder. Also adds
  `sendDocument()` (Baileys `{ document, mimetype, fileName, caption }`) for delivering
  the generated PDF — no typing delay, unlike `sendWithTypingDelay`, since this is an
  operator-triggered business document, not an auto-generated chat reply.
- `src/leadResponder.js#handleInboundMessage` — a `hasImage` branch runs after the same
  gates 1–3 as normal messages (fail-closed contact cache, saved-contact hard skip,
  manual-override/converted check), but before classification: it appends a placeholder
  message, flags the lead `payment_screenshot_received`, alerts the operator via
  `WA.sendToOperatorAlert`, and returns — no Gemini call, no reply, no state change beyond
  the flag.
- `src/paymentStore.js` — data layer for `data/payments.json` (gitignored, PII), same
  read-modify-write pattern as `leadStore.js`/`store.js`. Owns yearly-reset sequential
  invoice numbering (`INV-2026-0001`, resets to `0001` on IST year rollover) and CSV
  export. Generated PDFs live under `data/invoices/` (also gitignored), one file per
  invoice number.
- `src/invoicePdf.js` — builds the PDF via `pdfkit`. Deliberately prints amounts as
  `INR 25,000` rather than `₹25,000` — pdfkit's standard-14 fonts don't include the Rupee
  glyph without bundling a Unicode font, not worth the deploy weight for one symbol.
- `src/invoicing.js` — orchestrates `confirmPayment({ jid, amount })`: generates the
  invoice number + PDF, saves it locally, best-effort backs it up to Drive
  (`DRIVE_INVOICES_FOLDER_ID`, silently skipped if unset or Google isn't configured),
  **records the payment and marks the lead `converted` before attempting the WhatsApp
  send** — the operator already confirmed the money was received, so that fact shouldn't
  depend on delivery succeeding — then attempts `WA.sendDocument`. A failed send is
  logged and left `waSent:false` (never silently treated as delivered) so the panel can
  retry via `resendInvoice()`. Both are called only from `server.js`'s
  `POST /api/leads/:jid/confirm-payment` and `POST /api/payments/:invoiceNumber/resend`.
- Panel: the Leads tab shows an amount-entry mini-form on any lead flagged
  `payment_screenshot_received` that isn't yet converted; a separate Payments card lists
  every invoice (with a resend button when `waSent` is false) and an Export CSV button.

## Working in this codebase

- Every external integration degrades gracefully when its env vars are missing: check the
  `googleReady()` pattern (`!!process.env.GOOGLE_REFRESH_TOKEN`) before assuming Calendar/Drive/Gmail
  calls will succeed, and follow the existing pattern of returning early / logging rather than
  throwing when an integration isn't configured.
- Notification sends (WhatsApp, email) are consistently wrapped in try/catch and treated as
  best-effort — a failed reminder shouldn't crash a request or stop the cron loop for other
  classes/batches. Keep new notification code in this style.
- Timezone is hardcoded to `Asia/Kolkata` (`IST`) throughout — date formatting, cron schedule
  times, and the deployment note in the README all assume the server itself should also run with
  `TZ=Asia/Kolkata`.
- `google.js` supports both old and new env var names for a couple of settings (see the "Env
  fallbacks" comment at the top) — preserve that fallback pattern if you rename env vars rather
  than doing a hard rename.
- Every write in the lead-responder subsystem follows the same rule: never mark something as sent,
  delivered, or resolved until it's actually confirmed to have happened. A failed WhatsApp send, an
  exhausted Gemini quota, or a mid-flow crash should all leave state exactly as it was so the next
  cron tick or message retries cleanly — this bit real bugs during development (see
  `leadResponder.js`'s `flushPendingSend`) and is worth holding the line on in any new code there.
