// Meta Cloud API (WhatsApp Business) transport layer.
// Graph API v23.0 — replaces Twilio for sending/receiving WhatsApp messages.

const crypto = require("crypto");

const GRAPH_URL = "https://graph.facebook.com/v23.0";

function validateSignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return false;
  const expected = "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractMessages(webhookBody) {
  const out = [];
  if (webhookBody?.object !== "whatsapp_business_account") return out;
  for (const entry of webhookBody.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      for (const msg of change.value?.messages || []) {
        if (msg.type !== "text") continue;
        out.push({
          from: "+" + msg.from,
          text: msg.text?.body || "",
          msgId: msg.id,
        });
      }
    }
  }
  return out;
}

async function sendMessage(to, text) {
  const phoneId = process.env.META_WA_PHONE_NUMBER_ID;
  const token = process.env.META_WA_TOKEN;
  if (!phoneId || !token) throw new Error("META_WA_PHONE_NUMBER_ID or META_WA_TOKEN not set");
  const resp = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace("+", ""),
      text: { body: text },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph API ${resp.status}: ${err}`);
  }
  return resp.json();
}

async function markRead(msgId) {
  const phoneId = process.env.META_WA_PHONE_NUMBER_ID;
  const token = process.env.META_WA_TOKEN;
  if (!phoneId || !token) return;
  fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: msgId,
    }),
  }).catch(() => {});
}

module.exports = { validateSignature, extractMessages, sendMessage, markRead };
