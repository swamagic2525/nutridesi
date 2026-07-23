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
async function callGroq(userText, system = SYSTEM_PROMPT) {
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
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "{}";
}

// ---- Gemini (Google AI Studio) ----
async function callGemini(userText, system = SYSTEM_PROMPT) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 4096 },
    }),
  });
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

// ---- Claude (Anthropic) ----
async function callClaude(userText, system = SYSTEM_PROMPT) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
  const resp = await client.messages.create({
    model, max_tokens: 4096,
    // Cache the static system prompt (~3-4k tokens). Reused across calls within
    // ~5 min -> cheaper + faster, especially under bursty reel traffic.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  });
  return resp.content?.[0]?.text || "{}";
}

const CALLERS = { groq: callGroq, gemini: callGemini, claude: callClaude };

// Generic single-shot LLM call over the same provider fallback chain, with a
// caller-supplied system prompt. Returns raw text ("{}" on total failure).
// Used by the reference reranker (src/rerank.js) — a different, tiny prompt.
async function askLLM(userText, system) {
  for (const name of CHAIN) {
    try {
      return await CALLERS[name](userText, system);
    } catch (e) {
      console.error(`askLLM ${name} failed:`, String(e.message).slice(0, 200));
    }
  }
  return "{}";
}

// Deterministic pizza normalization. Two ambiguities the LLM resolves
// inconsistently, both introduced by adding whole-pizza + slice SKUs:
//   1. "2 slices pizza" could log 2 WHOLE pizzas (307-312) — a 2x overcount.
//      When "slice" sits next to "pizza" we force the per-slice entry (95).
//   2. Bare "pizza" swings between regular (307) and medium (312) — ~1.8x.
//      With no size word we pin the generic medium (312) down to regular (307).
// The slice adjacency check keeps "1 pizza and 2 slices of cake" from misfiring.
const WHOLE_PIZZA_IDS = new Set([307, 308, 309, 310, 311, 312]);
const PIZZA_SLICE_RE = /\b(?:pizza\s+slices?|slices?\s+(?:of\s+)?pizza)\b/i;
const PIZZA_SIZE_RE = /\b(medium|large)\b/i;
function pinPizzaSlices(rawMessage, parsed) {
  const raw = String(rawMessage || "");
  const sliceContext = PIZZA_SLICE_RE.test(raw);
  const sizeGiven = PIZZA_SIZE_RE.test(raw);
  for (const it of parsed.items || []) {
    const id = Number(it.matched_db_id);
    const isPizza = WHOLE_PIZZA_IDS.has(id) || /pizza/i.test(String(it.food_name || ""));
    if (sliceContext && isPizza) {
      it.matched_db_id = 95;
      // Force the slice alias as the name too, or db.js contextGuard re-matches
      // "pizza" back to a whole pizza and undoes this.
      it.food_name = "pizza slice";
    } else if (id === 312 && !sizeGiven) {
      it.matched_db_id = 307; // "1 pizza" defaults to a regular, not a medium
    }
  }
  return parsed;
}

const RECENT_BEGIN = "BEGIN APP-PROVIDED RECENT CONVERSATION";
const RECENT_END = "END APP-PROVIDED RECENT CONVERSATION";
const LATEST_BEGIN = "BEGIN APP-PROVIDED LATEST LOG";
const LATEST_END = "END APP-PROVIDED LATEST LOG";
const CURRENT_BEGIN = "BEGIN CURRENT USER MESSAGE";
const CURRENT_END = "END CURRENT USER MESSAGE";
const MAX_CONTEXT_RECORDS = 20;
const RESERVED_MARKER = /BEGIN CURRENT USER MESSAGE|END CURRENT USER MESSAGE|CURRENT USER MESSAGE:|BEGIN APP-PROVIDED (?:RECENT CONVERSATION|LATEST LOG)|END APP-PROVIDED (?:RECENT CONVERSATION|LATEST LOG)/i;

function recognisedContextBlock(value) {
  if (typeof value !== "string") return "";
  const lines = value.trim().split("\n");
  const isRecent = lines[0] === RECENT_BEGIN && lines.at(-1) === RECENT_END;
  const isLatest = lines[0] === LATEST_BEGIN && lines.at(-1) === LATEST_END;
  if ((!isRecent && !isLatest) || lines.length < 3 || lines.length - 2 > MAX_CONTEXT_RECORDS) return "";
  try {
    const records = lines.slice(1, -1).map(line => JSON.parse(line));
    const valid = isRecent
      ? records.every(record => Object.keys(record).sort().join(",") === "role,text"
          && ["user", "assistant"].includes(record.role) && typeof record.text === "string"
          && !RESERVED_MARKER.test(record.role) && !RESERVED_MARKER.test(record.text))
      : records.every(record => Object.keys(record).sort().join(",") === "food_name,is_estimate,kcal,protein,quantity,role"
          && record.role === "latest_log_item" && typeof record.food_name === "string"
          && [record.quantity, record.kcal, record.protein].every(Number.isFinite) && typeof record.is_estimate === "boolean"
          && !RESERVED_MARKER.test(record.role) && !RESERVED_MARKER.test(record.food_name));
    if (!valid) return "";
    const canonicalRecords = isRecent
      ? records.map(record => JSON.stringify({ role: record.role, text: record.text }))
      : records.map(record => JSON.stringify({
        role: record.role, food_name: record.food_name, quantity: record.quantity,
        kcal: record.kcal, protein: record.protein, is_estimate: record.is_estimate,
      }));
    if (canonicalRecords.some(record => record.length > 540)) return "";
    return { type: isRecent ? "recent" : "latest", text: [isRecent ? RECENT_BEGIN : LATEST_BEGIN, ...canonicalRecords, isRecent ? RECENT_END : LATEST_END].join("\n") };
  } catch (_) { return ""; }
}

function quotedCurrentText(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
    .replace(/BEGIN CURRENT USER MESSAGE|END CURRENT USER MESSAGE|CURRENT USER MESSAGE:/gi, "[quoted current boundary text]")
    .replace(/BEGIN APP-PROVIDED (?:RECENT CONVERSATION|LATEST LOG)|END APP-PROVIDED (?:RECENT CONVERSATION|LATEST LOG)/gi, "[quoted historical boundary text]");
}

function currentRecord(value) {
  let text = quotedCurrentText(value);
  let encoded = JSON.stringify({ role: "current_user", text });
  while (encoded.length > 540 && text.length) {
    text = text.slice(0, -1);
    encoded = JSON.stringify({ role: "current_user", text });
  }
  return encoded;
}

function buildContextualMessage(cleaned, trustedContext) {
  const candidates = Array.isArray(trustedContext) ? trustedContext : [trustedContext];
  const parsedBlocks = candidates.map(recognisedContextBlock).filter(Boolean);
  const counts = parsedBlocks.reduce((all, block) => ({ ...all, [block.type]: (all[block.type] || 0) + 1 }), {});
  const blocks = parsedBlocks.filter(block => counts[block.type] === 1).map(block => block.text);
  return [...blocks, CURRENT_BEGIN, currentRecord(cleaned), CURRENT_END].join("\n");
}

async function parseMeal(rawMessage, recentLogContext = "") {
  const cleaned = preprocess(rawMessage);
  if (!cleaned) return { items: [], meal_time_inferred: "snack", parse_notes: "empty" };
  const contextualMessage = buildContextualMessage(cleaned, recentLogContext);

  for (const name of CHAIN) {
    try {
      const raw = await CALLERS[name](contextualMessage);
      const parsed = extractJson(raw);
      if (name !== CHAIN[0]) console.warn(`parser: ${CHAIN[0]} down, served by ${name}`);
      return pinPizzaSlices(rawMessage, parsed);
    } catch (e) {
      console.error(`LLM ${name} failed:`, String(e.message).slice(0, 300));
    }
  }
  return { items: [], meal_time_inferred: "snack", parse_notes: "llm_error" };
}

module.exports = { parseMeal, preprocess, pinPizzaSlices, buildContextualMessage, askLLM, PROVIDER, CHAIN };
