const { createClient } = require("@supabase/supabase-js");

const IST = "Asia/Kolkata";
const DAY_MS = 24 * 60 * 60 * 1000;

// First day NutriDesi was shared outside Swapnil's own testing. Drives the
// "Day N" milestone card.
const LAUNCH_DATE = "2026-07-11";

function istDate(value = new Date()) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: IST });
}

function addDays(date, amount) {
  const base = new Date(`${date}T00:00:00.000Z`);
  return new Date(base.getTime() + amount * DAY_MS).toISOString().slice(0, 10);
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function isTestPhone(phone) {
  return String(phone || "").startsWith("+000");
}

function normalizeFoodName(name) {
  return String(name || "unknown food")
    .replace(/^\s*\d+(?:\.\d+)?\s*g\s+/i, "")
    .trim()
    .toLowerCase();
}

function lastNDates(today, days) {
  return Array.from({ length: days }, (_v, i) => addDays(today, i - (days - 1)));
}

function makeDateSets(logs) {
  const usersByDate = new Map();
  for (const row of logs) {
    if (!row.date) continue;
    if (!usersByDate.has(row.date)) usersByDate.set(row.date, new Set());
    usersByDate.get(row.date).add(row.phone_number);
  }
  return usersByDate;
}

function buildMetrics(rawUsers, rawLogs, now = new Date(), goalFieldAvailable = true, extras = {}) {
  const today = istDate(now);
  const users = (rawUsers || []).filter(u => !isTestPhone(u.phone_number));
  const userPhones = new Set(users.map(u => u.phone_number));
  const logs = (rawLogs || []).filter(l => userPhones.has(l.phone_number));
  const activeByDate = makeDateSets(logs);
  const last30 = lastNDates(today, 30);

  const dau = last30.map(date => ({ date, value: (activeByDate.get(date) || new Set()).size }));
  const newUsers = last30.map(date => ({
    date,
    value: users.filter(u => istDate(u.created_at) === date).length,
  }));

  const cohortsByDate = new Map();
  for (const user of users) {
    const date = istDate(user.created_at);
    if (!cohortsByDate.has(date)) cohortsByDate.set(date, []);
    cohortsByDate.get(date).push(user.phone_number);
  }
  const cohorts = [...cohortsByDate.entries()]
    .filter(([date]) => date >= last30[0] && date <= today)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, phones]) => {
      const retention = (days) => {
        const target = addDays(date, days);
        if (target > today) return null;
        const active = activeByDate.get(target) || new Set();
        return percent(phones.filter(phone => active.has(phone)).length, phones.length);
      };
      return { date, size: phones.length, d1: retention(1), d3: retention(3), d7: retention(7) };
    });

  const eligibleD7 = users.filter(u => addDays(istDate(u.created_at), 7) <= today);
  const d7Returned = eligibleD7.filter(u => {
    const active = activeByDate.get(addDays(istDate(u.created_at), 7)) || new Set();
    return active.has(u.phone_number);
  }).length;

  const nextDayReturn = last30.slice(0, -1).map(date => {
    const source = activeByDate.get(date) || new Set();
    const next = activeByDate.get(addDays(date, 1)) || new Set();
    return { date, rate: percent([...source].filter(phone => next.has(phone)).length, source.size) };
  });
  const engagement = last30.map(date => {
    const active = (activeByDate.get(date) || new Set()).size;
    const rows = logs.filter(l => l.date === date).length;
    return { date, value: active ? Math.round((rows / active) * 100) / 100 : null };
  });

  const qualityFor = (rows) => ({
    estimateRate: percent(rows.filter(r => r.is_estimate === true).length, rows.length),
    uncuratedRate: percent(rows.filter(r => r.matched_db_id == null).length, rows.length),
  });
  const dailyQuality = last30.map(date => ({ date, ...qualityFor(logs.filter(l => l.date === date)) }));
  const weekAgo = addDays(today, -6);
  const uncurated = new Map();
  for (const row of logs.filter(l => l.date >= weekAgo && l.matched_db_id == null)) {
    const foodName = normalizeFoodName(row.food_name);
    uncurated.set(foodName, (uncurated.get(foodName) || 0) + 1);
  }
  const topUncurated = [...uncurated.entries()]
    .map(([foodName, count]) => ({ foodName, count }))
    .sort((a, b) => b.count - a.count || a.foodName.localeCompare(b.foodName))
    .slice(0, 10);

  const overallQuality = qualityFor(logs);
  // Milestone cards: cumulative, share-friendly, and independent of the
  // operational health metrics below them.
  const milestone = {
    dayNumber: Math.max(1, Math.round((new Date(`${today}T00:00:00.000Z`)
      - new Date(`${LAUNCH_DATE}T00:00:00.000Z`)) / DAY_MS) + 1),
    launchDate: LAUNCH_DATE,
    foodsLogged: logs.length,
    directMatchRate: percent(logs.filter(r => r.matched_db_id != null).length, logs.length),
    foundingMembers: extras.foundingMembers ?? null,
    corrections: extras.corrections ?? null,
  };
  return {
    asOf: new Date(now).toISOString(),
    today,
    milestone,
    totalUsers: users.length,
    activeToday: (activeByDate.get(today) || new Set()).size,
    d7: { rate: percent(d7Returned, eligibleD7.length), eligibleUsers: eligibleD7.length },
    growth: { dau, newUsers },
    cohorts,
    nextDayReturn,
    engagement,
    estimate: {
      overallRate: overallQuality.estimateRate,
      uncuratedOverallRate: overallQuality.uncuratedRate,
      daily: dailyQuality,
    },
    topUncurated,
    goalAdoption: {
      available: goalFieldAvailable,
      rate: goalFieldAvailable ? percent(users.filter(u => u.goal_protein != null).length, users.length) : 0,
    },
  };
}

async function fetchAll(client, table, columns) {
  const pageSize = 1000;
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) return all;
  }
}

async function loadMetrics() {
  const url = process.env.SUPABASE_URL;
  // The dashboard route is protected by HTTP Basic Auth and runs only on the
  // backend. Use the existing server key here so RLS can stay strict: the
  // public anon/publishable role must never gain SELECT access to phone rows.
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Metrics dashboard is missing server Supabase configuration.");
  const client = createClient(url, key);
  const users = await fetchAll(client, "users", "phone_number,created_at");
  let goalFieldAvailable = true;
  let goals = [];
  try {
    goals = await fetchAll(client, "users", "phone_number,goal_protein");
  } catch (error) {
    goalFieldAvailable = false;
    console.warn("metrics: goal_protein unavailable until the additive migration runs:", error.message);
  }
  const goalByPhone = new Map(goals.map(row => [row.phone_number, row.goal_protein]));
  const logs = await fetchAll(client, "user_logs", "phone_number,food_name,matched_db_id,is_estimate,date");
  // Milestone extras — both fail soft: a missing table or log file just leaves
  // that card blank rather than breaking the dashboard.
  let foundingMembers = null;
  try {
    const { count } = await client.from("founding_members").select("*", { count: "exact", head: true });
    foundingMembers = count ?? null;
  } catch (error) { console.warn("metrics: founding_members unavailable:", error.message); }
  let corrections = null;
  try {
    const lines = require("fs").readFileSync(`${__dirname}/../evals/correction-log.jsonl`, "utf8")
      .trim().split("\n").filter(Boolean);
    corrections = lines.filter(l => /"outcome":"(corrected|removed|removed_all)"/.test(l)).length;
  } catch { /* no correction log yet */ }
  return buildMetrics(users.map(user => ({ ...user, goal_protein: goalByPhone.get(user.phone_number) })), logs, new Date(), goalFieldAvailable, { foundingMembers, corrections });
}

module.exports = { buildMetrics, loadMetrics, normalizeFoodName, istDate };
