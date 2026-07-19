# WhatsApp Cloud API Migration — Verification & Setup Checklist

Goal: move NutriDesi off the Twilio Sandbox onto a permanent WhatsApp number via
Meta Cloud API (direct — no BSP, no per-message platform fee). Target: live
before the next reel push. Swapnil does Parts A–B (Meta's side, requires his
identity/accounts); the code migration (Part C) is done in-repo.

---

## Part A — Meta Business verification (start FIRST — it's the long pole)

Do these in one sitting (~30 min), then wait 1–3 days for Meta's review.

- [x] **A1. Facebook Business Manager**: done — sole proprietor, legal name
  Swapnil Sukhadev Gore.
- [x] **A2. Business details**: done — website is https://nutridesi.co
  (Instagram URL and netlify.app subdomain were both rejected as shared
  domains; bought nutridesi.co on Namecheap 2026-07-18, hosted on Netlify).
- [x] **A3. Start Business Verification**: submitted 2026-07-18 with documents
  (name/address + phone). Meta quoted ~2 days for review.
- [ ] **A4. Confirm contact**: Meta may call/email to verify the business
  phone during review. Answer it — silent rejections are usually a missed
  verification call.

**Gotchas:** mismatched name spelling between A1 and A3 is the #1 rejection
reason. If rejected, fix the mismatch and resubmit — appeals are fast.

---

## Part B — WhatsApp app + number (can start in parallel with A's review)

- [ ] **B1. Get the number**: a new SIM or virtual number that (a) is NOT
  already registered on WhatsApp/WhatsApp Business app, and (b) can receive one
  SMS/voice OTP. This number is NutriDesi's permanent identity — pick one you
  will keep for years. If it was ever on WhatsApp, delete that account first
  (WhatsApp app → Settings → Account → Delete) and wait ~3 hours.
- [ ] **B2. Developer app**: developers.facebook.com → My Apps → Create App →
  type "Business" → link it to the Business Manager from A1. Add the
  **WhatsApp** product to the app.
- [ ] **B3. Register the number**: WhatsApp → API Setup → Add phone number →
  enter B1's number → receive OTP → verify. Set display name **"NutriDesi"**
  (display-name review is automatic; avoid emojis/ALL-CAPS — plain brand name
  passes).
- [ ] **B4. Permanent access token**: Business Settings → Users → System Users →
  create system user (name: "nutridesi-server", role: Admin) → Assign the app
  as an asset → Generate token with `whatsapp_business_messaging` +
  `whatsapp_business_management` permissions, expiry **Never**. Copy it once —
  this goes into `.env` as `META_WA_TOKEN`. Never paste it in chat/commits.
- [ ] **B5. Collect the IDs** (shown on the API Setup page) for `.env`:
  `META_WA_PHONE_NUMBER_ID`, `META_WA_BUSINESS_ACCOUNT_ID`.
- [ ] **B6. Test send**: use the API Setup page's built-in "Send test message"
  to your own phone to confirm the number is live.

**Gotchas:** the temporary token on the API Setup page expires in 24h — do NOT
put it in `.env`; only the system-user token from B4 is permanent. Business-
initiated messaging is capped at 250/day until A's verification clears — fine,
the core loop (users text first) is unlimited from day one.

---

## Part C — Code migration (done for you, in-repo)

- [x] C1. New webhook: `GET /meta-whatsapp` verify-token handshake +
  `POST /meta-whatsapp` parsing Meta's JSON payload (replaces Twilio's
  form-encoded body).
- [x] C2. Replies via Graph API `POST /v23.0/{phone_number_id}/messages`
  (replaces inline TwiML). Same parser/DB/reply pipeline, transport only.
- [x] C3. Healthcheck alert ported to Graph API send.
- [x] C4. Webhook signature validation (`X-Hub-Signature-256` with the app
  secret) — closes backlog #0 item 1 properly.
- [ ] C5. Cloud deploy (Railway/Render) with `.env` in host secrets; Mac Mini
  + ngrok retire. Webhook URL pasted into the app's WhatsApp → Configuration.

---

## Part D — Migration week

- [ ] D1. Footer line appended to every bot reply on the OLD number:
  "📢 New permanent number: +91XXXXXXXXXX — save it, this test line retires
  <date>." (actives see it inside their session windows; no broadcast needed)
- [ ] D2. IG story + pinned-comment update + DM-template update: "no join code
  anymore — just message the new number."
- [ ] D3. Sandbox stays up 2 weeks as a pure redirect autoresponder, then dies.
- [ ] D4. Update memory/docs: deployment-setup notes, README, PRD infra section.

---

## Cost & time per move

| Move | Your time | Wait | Cash |
|---|---|---|---|
| A. Meta Business verification | ~30 min | 1–3 days review | ₹0 |
| B1. Permanent number (new SIM) | ~1 hr | — | ₹100–300 one-time |
| B2–B6. App, number reg, token | ~1–2 hrs | display name: hours | ₹0 |
| C1–C4. Code migration (Claude) | review only | ~1 day of work | ₹0 |
| C5. Cloud deploy (Railway) | ~1 hr | — | ~$5/mo (~₹450) |
| D. Migration week comms | ~2 hrs spread | 2-week overlap | ₹0 |
| **Total** | **~1 working day** | **~1 week elapsed** | **~₹300 + ₹450/mo** |

## Monthly run-rate at scale (LLM included)

WhatsApp itself: ~₹0 (service messages free; utility templates ₹0.145 only
outside the 24h window). Hosting ~₹450/mo. The dominant cost is LLM parsing:

| Volume | Claude Haiku (w/ caching) | Gemini 2.5 Flash-Lite (paid) |
|---|---|---|
| Today (~70 users, ~6K parses/mo) | ~₹500–1,500/mo | ~₹200–400/mo |
| 300 DAU (~36K parses/mo) | ~₹5,000–12,000/mo* | ~₹2,000–3,500/mo |

*Range depends on prompt-cache hit rate (5-min TTL — bursty dinner traffic
hits cache, sparse daytime traffic misses). The ~8K-token system prompt
(food directory) is the whole cost; output is trivial.

**Plan:** stay on Claude Haiku now (quality + current credits), move primary
to Gemini paid tier at ~150 DAU when the bill crosses ~₹3K/mo, keep Claude
as fallback. Total run-rate at 300 DAU: **₹3–13K/mo** vs ₹30K+ platform fee
alone on Twilio.

## Marketing plan — IG page strategy

**Distribution stays on the personal fitness page. NutriDesi gets a business
page as home base, not as the growth engine.**

Why: 100% of current traction came from the personal page — warm audience,
coach credibility, the algorithm already knows the reels perform. A new page
starts from zero reach; moving distribution there would kill the funnel.

- **Personal page (unchanged):** reels, stories, daily build-in-public,
  DM funnel. This is where growth happens for the next 3–6 months.
- **NutriDesi business page (create during migration — same Meta Business
  Manager):**
  - Pinned how-to guide (Kshitij's ask: "I can't recall all its features")
  - Testimonial/screenshot highlights, changelog-style update posts
  - Bio = wa.me link to the permanent number (one tap, no join code)
  - Unlocks later: click-to-WhatsApp ads, IG DM automation, a handle to
    put on the LinkedIn post and reel watermarks
- **Wiring:** every personal reel tags @nutridesi + link in story;
  business page reposts. Personal drives reach, business converts and
  retains the knowledge base.
- **Effort:** ~2 hrs to set up, ~30 min/week to maintain.
