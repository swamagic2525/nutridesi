# WhatsApp Cloud API Migration — Verification & Setup Checklist

Goal: move NutriDesi off the Twilio Sandbox onto a permanent WhatsApp number via
Meta Cloud API (direct — no BSP, no per-message platform fee). Target: live
before the next reel push. Swapnil does Parts A–B (Meta's side, requires his
identity/accounts); the code migration (Part C) is done in-repo.

---

## Part A — Meta Business verification (start FIRST — it's the long pole)

Do these in one sitting (~30 min), then wait 1–3 days for Meta's review.

- [ ] **A1. Facebook Business Manager**: go to business.facebook.com → Create
  account. Business name: "NutriDesi" (or your legal/individual name — solo
  builders can verify as sole proprietor). Use swa.magic2525@gmail.com or a
  dedicated email you'll keep.
- [ ] **A2. Business details**: address, phone, website. For website, the GitHub
  repo page or an Instagram profile URL works at this stage; a landing page is
  better if you have an hour (even a one-page Carrd/Notion site).
- [ ] **A3. Start Business Verification**: Business Settings → Security Centre →
  Start Verification. Documents that work for a sole proprietor in India:
  PAN + bank statement, or GST/Udyam registration if you have one. The name on
  the document must match the business name you entered.
- [ ] **A4. Confirm contact**: Meta calls/emails to verify the business phone.
  Answer it — silent rejections are usually a missed verification call.

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

- [ ] C1. New webhook: `GET /meta-whatsapp` verify-token handshake +
  `POST /meta-whatsapp` parsing Meta's JSON payload (replaces Twilio's
  form-encoded body).
- [ ] C2. Replies via Graph API `POST /v21.0/{phone_number_id}/messages`
  (replaces inline TwiML). Same parser/DB/reply pipeline, transport only.
- [ ] C3. Healthcheck alert ported to Graph API send.
- [ ] C4. Webhook signature validation (`X-Hub-Signature-256` with the app
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

## Cost reality check (300 DAU target)

- Core loop (user-initiated + replies within 24h window): **free, unlimited**
- Utility templates outside the window (future daily summaries to lapsed
  users): ₹0.145/msg, volume-tiered
- Hosting: ~$5–10/mo · LLM parsing: the dominant cost, ~₹4–8K/mo at 300 DAU
- What this avoids: Twilio's $0.005/msg × ~72K msgs ≈ ₹30K/mo platform fee
