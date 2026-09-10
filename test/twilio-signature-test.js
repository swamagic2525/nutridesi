// Twilio webhook signature gate. Without it anyone who finds the public URL
// can POST as any phone number — log, correct or undo a real user's meals —
// because `From` is just a form field.
const assert = require("assert");
const twilio = require("twilio");
const { signatureMode, twilioSignatureDecision } = require("../src/twilioSignature.js");

const TOKEN = "test_auth_token_not_real";
const PUBLIC_URL = "https://example-tunnel.test";
const params = { From: "whatsapp:+0000000001", Body: "2 roti", MessageSid: "SM123", NumMedia: "0" };
const sign = (p, url = PUBLIC_URL + "/whatsapp") => twilio.getExpectedTwilioSignature(TOKEN, url, p);
const decide = (over = {}) => twilioSignatureDecision({
  mode: "enforce", authToken: TOKEN, publicUrl: PUBLIC_URL, signature: sign(params), params, ...over,
});

// --- mode parsing: the rollout default is log, never enforce by accident ---
assert.strictEqual(signatureMode(undefined), "log");
assert.strictEqual(signatureMode(""), "log");
assert.strictEqual(signatureMode("ENFORCE"), "enforce");
assert.strictEqual(signatureMode("off"), "off");
assert.strictEqual(signatureMode("bogus"), "log", "a typo must neither disable nor enforce");

// --- a genuine Twilio request passes ---
assert.deepStrictEqual(decide(), { allow: true, status: "valid", mode: "enforce" });
assert.strictEqual(decide({ publicUrl: PUBLIC_URL + "/" }).status, "valid",
  "a trailing slash in PUBLIC_URL is tolerated");

// --- forged or altered requests fail ---
assert.deepStrictEqual(decide({ params: { ...params, From: "whatsapp:+0000000002" } }),
  { allow: false, status: "invalid", mode: "enforce" }, "a spoofed sender is rejected");
assert.strictEqual(decide({ params: { ...params, Body: "undo" } }).allow, false,
  "an altered body is rejected");
assert.strictEqual(decide({ signature: sign(params, "http://example-tunnel.test/whatsapp") }).allow, false,
  "a signature computed for a different URL is rejected");
assert.deepStrictEqual(decide({ signature: undefined }),
  { allow: false, status: "missing_signature", mode: "enforce" });

// --- enforce fails closed when it cannot check ---
assert.deepStrictEqual(decide({ authToken: "" }), { allow: false, status: "missing_config", mode: "enforce" });
assert.deepStrictEqual(decide({ publicUrl: undefined }), { allow: false, status: "missing_config", mode: "enforce" });

// --- log mode checks but never blocks: the safe rollout step ---
assert.deepStrictEqual(decide({ mode: "log", signature: "forged" }), { allow: true, status: "invalid", mode: "log" });
assert.deepStrictEqual(decide({ mode: undefined, signature: undefined }),
  { allow: true, status: "missing_signature", mode: "log" });

// --- off skips the check entirely ---
assert.deepStrictEqual(decide({ mode: "off", signature: undefined, authToken: "" }),
  { allow: true, status: "off", mode: "off" });

console.log("twilio-signature-test: all passed");
