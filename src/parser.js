// Parses a meal message into structured JSON using an LLM.
// LLM_PROVIDER env picks the primary ("groq", "gemini", or "claude"); the other
// providers with keys in .env form a fallback chain, tried in order on failure.
// Free-tier daily quotas die mid-day (Groq ~33 msgs, Gemini per-model caps) —
// the chain is what keeps real users off the 300 kcal placeholder.

const { SYSTEM_PROMPT } = require("./systemPrompt.js");

const PROVIDER = (process.env.LLM_PROVIDER || "groq").toLowerCase();
const KEY_ENV = { groq: "GROQ_API_KEY", gemini: "GEMINI_API_KEY", claude: "ANTHROPIC_API_KEY" };
const CHAIN = [PROVIDER, ...["gemini", "groq", "claude"].filter(p => p !== PROVIDER)]
  .filter(p => KEY_ENV[p] && process.env[KEY_ENV[p]]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip WhatsApp markdown (*, _, ~, >) but keep emojis (contextual anchors).
function preprocess(text) {
  return String(text || "")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pull the first {...} JSON object out of a model reply (handles fences / stray text).
function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Shared fetch, lean retries: the provider chain is the real retry mechanism.
// 429 (quota) fails over to the next provider instantly; 5xx gets one quick retry.
// Budget: 3 providers must fit inside Twilio's 15s webhook window.
async function fetchWithRetry(url, opts) {
  const RETRYABLE = new Set([500, 502, 503, 504]);
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, opts);
    if (res.ok) return res;
    lastErr = `${res.status}: ${await res.text()}`;
    if (RETRYABLE.has(res.status) && attempt < 1) { await sleep(1000); continue; }
    throw new Error(lastErr);
  }
  throw new Error(lastErr);
}

// ---- Groq (OpenAI-compatible, free tier) ----
async function callGroq(userText) {
  const key = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const res = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4096, // big meal lists (9+ items) truncate at the default -> invalid JSON
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "{}";
}

// ---- Gemini (Google AI Studio) ----
async function callGemini(userText) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 4096 },
    }),
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

// ---- Claude (Anthropic) ----
async function callClaude(userText) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
  const resp = await client.messages.create({
    model, max_tokens: 4096,
    // Cache the static system prompt (~3-4k tokens). Reused across calls within
    // ~5 min -> cheaper + faster, especially under bursty reel traffic.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  });
  return resp.content?.[0]?.text || "{}";
}

const CALLERS = { groq: callGroq, gemini: callGemini, claude: callClaude };

async function parseMeal(rawMessage, recentLogContext = "") {
  const cleaned = preprocess(rawMessage);
  if (!cleaned) return { items: [], meal_time_inferred: "snack", parse_notes: "empty" };
  const contextualMessage = recentLogContext
    ? `${recentLogContext}\n\nCURRENT USER MESSAGE:\n${cleaned}`
    : cleaned;

  for (const name of CHAIN) {
    try {
      const raw = await CALLERS[name](contextualMessage);
      const parsed = extractJson(raw);
      if (name !== CHAIN[0]) console.warn(`parser: ${CHAIN[0]} down, served by ${name}`);
      return parsed;
    } catch (e) {
      console.error(`LLM ${name} failed:`, String(e.message).slice(0, 300));
    }
  }
  return { items: [], meal_time_inferred: "snack", parse_notes: "llm_error" };
}

module.exports = { parseMeal, preprocess, PROVIDER, CHAIN };
