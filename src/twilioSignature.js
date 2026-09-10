// Twilio webhook signature check. `From` is a plain form field, so without
// this anyone who finds the public URL can act as any user. The signature is
// computed over the exact public URL Twilio called, which the tunnel hides
// from the server — so it comes from PUBLIC_URL, not the request.
const twilio = require("twilio");

const MODES = ["off", "log", "enforce"];

// Unknown values fall back to "log": a typo must neither disable the check
// nor start rejecting real users.
function signatureMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return MODES.includes(mode) ? mode : "log";
}

function signatureStatus({ authToken, publicUrl, signature, params }) {
  if (!authToken || !publicUrl) return "missing_config";
  if (!signature) return "missing_signature";
  const url = `${String(publicUrl).replace(/\/+$/, "")}/whatsapp`;
  return twilio.validateRequest(authToken, signature, url, params || {}) ? "valid" : "invalid";
}

// "log" checks every request but never blocks — the rollout step that proves
// real traffic validates before "enforce" can reject anything.
function twilioSignatureDecision({ mode, authToken, publicUrl, signature, params }) {
  const m = signatureMode(mode);
  if (m === "off") return { allow: true, status: "off", mode: m };
  const status = signatureStatus({ authToken, publicUrl, signature, params });
  return { allow: m === "log" || status === "valid", status, mode: m };
}

module.exports = { signatureMode, twilioSignatureDecision };
