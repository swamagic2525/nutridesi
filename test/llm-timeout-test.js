// LLM call timeouts. Twilio abandons a webhook after 15s and the user gets
// silence. Production max was 14.0s with no timeouts anywhere, and the
// Anthropic SDK defaults to a 10-minute timeout with 2 retries — so one hung
// provider could stall a reply far past Twilio's limit.
const assert = require("assert");

process.env.LLM_PROVIDER = "gemini";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.GROQ_API_KEY = "test-groq";
process.env.ANTHROPIC_API_KEY = "test-claude";

// Stub the Anthropic SDK so the fallback's request options can be inspected.
let claudeRequestOptions = null;
const sdkPath = require.resolve("@anthropic-ai/sdk");
require.cache[sdkPath] = {
  id: sdkPath, filename: sdkPath, loaded: true,
  exports: class {
    constructor() {
      this.messages = {
        create: async (_params, opts) => {
          claudeRequestOptions = opts;
          return { content: [{ text: '{"items":[],"parse_notes":"claude"}' }] };
        },
      };
    }
  },
};

// Every HTTP provider answers 429, so the chain has to fall through to Claude.
const fetchCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), signal: opts.signal });
  return { ok: false, status: 429, text: async () => "quota" };
};

const { runChain, parseMeal, askLLM } = require("../src/parser.js");
const never = () => new Promise(() => {});
const timed = async (fn) => { const t = Date.now(); const v = await fn(); return { v, ms: Date.now() - t }; };

(async () => {
  // --- a hung provider is abandoned at its per-call cap and the next serves ---
  let hungSignal = null;
  let r = await timed(() => runChain(["a", "b"], (name, signal) => {
    if (name === "a") { hungSignal = signal; return never(); }
    return Promise.resolve("ok");
  }, { budgetMs: 1000, perCallMs: 50, minAttemptMs: 10 }));
  assert.deepStrictEqual(r.v, { name: "b", value: "ok" });
  assert.ok(r.ms < 400, `the fallback serves promptly (${r.ms}ms)`);
  assert.strictEqual(hungSignal.aborted, true, "the hung request is aborted, not left running");

  // --- every provider hangs: the whole chain stops at its budget ---
  r = await timed(() => runChain(["a", "b", "c"], () => never(),
    { budgetMs: 150, perCallMs: 100, minAttemptMs: 30 }));
  assert.strictEqual(r.v, null);
  assert.ok(r.ms < 300, `bounded by the chain budget, not 3 x per-call (${r.ms}ms)`);

  // --- a fast failure (429) falls through without waiting for the timeout ---
  r = await timed(() => runChain(["a", "b"], (name) =>
    (name === "a" ? Promise.reject(new Error("429: quota")) : Promise.resolve("ok")),
  { budgetMs: 1000, perCallMs: 500, minAttemptMs: 10 }));
  assert.deepStrictEqual(r.v, { name: "b", value: "ok" });
  assert.ok(r.ms < 100, `a quota error falls through immediately (${r.ms}ms)`);

  // --- the first success wins; later providers are never called ---
  const tried = [];
  await runChain(["a", "b"], (name) => { tried.push(name); return Promise.resolve(name); },
    { budgetMs: 1000, perCallMs: 500 });
  assert.deepStrictEqual(tried, ["a"]);

  // --- wiring: every real provider call carries an abort signal ---
  fetchCalls.length = 0;
  const parsed = await parseMeal("2 roti");
  assert.strictEqual(parsed.parser_provider, "claude", "429s fall through to the last provider");
  assert.ok(fetchCalls.length >= 2, "Gemini and Groq were both tried");
  assert.ok(fetchCalls.every(c => c.signal instanceof AbortSignal), "Gemini/Groq fetches are abortable");
  assert.ok(claudeRequestOptions && claudeRequestOptions.signal instanceof AbortSignal,
    "the Claude call is abortable");
  assert.strictEqual(claudeRequestOptions.maxRetries, 0,
    "the SDK's own retries are off — the provider chain is the retry");

  fetchCalls.length = 0;
  await askLLM("x", "system");
  assert.ok(fetchCalls.length > 0 && fetchCalls.every(c => c.signal instanceof AbortSignal),
    "the reranker's calls are abortable too");

  console.log("llm-timeout-test: all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
