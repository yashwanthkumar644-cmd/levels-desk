"use strict";
/* Levels Desk analysis engine: levels, decision, backtest, summary. */
const LOOKBACK = 150, SW = 3, HOLD = 20, FILL_BARS = 3, MIN_BARS = 60;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const inr = (x, d = 2) => isFinite(x) ? "₹" + x.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
const fmtN = (x) => isFinite(x) ? Math.round(x).toLocaleString("en-IN") : "–";

let state = { stocks: [], active: -1, errors: [] };
const setState = (patch) => { state = { ...state, ...patch }; render(); };

/* ---------- parsing ---------- */
function parseCSV(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = { ",": (first.match(/,/g) || []).length, "\t": (first.match(/\t/g) || []).length, ";": (first.match(/;/g) || []).length };
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
const num = (x) => { const s = String(x ?? "").replace(/[₹,\s"]/g, ""); return s === "" || s === "-" ? NaN : parseFloat(s); };
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const yr = (y) => { const n = +y; return n < 100 ? 2000 + n : n; };
function parseDate(raw) {
  const s = String(raw).trim(); let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) return Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if ((m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ,]+(\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2}))?/)) && MON[m[2].toLowerCase()] !== undefined) return Date.UTC(yr(m[3]), MON[m[2].toLowerCase()], +m[1], +(m[4] || 0), +(m[5] || 0));
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2}))?/))) return Date.UTC(yr(m[3]), m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  if (/^\d{10}$/.test(s)) return +s * 1000;
  const t = Date.parse(s); return isNaN(t) ? NaN : t;
}
function findCol(h, include, exclude) {
  for (const re of include) { const i = h.findIndex((c) => re.test(c) && !(exclude && exclude.test(c))); if (i >= 0) return i; }
  return -1;
}
function parseBars(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => /high/i.test(c)) && r.some((c) => /close|ltp|last/i.test(c)));
  if (hi < 0) throw new Error("No header row with High and Close columns was found.");
  const h = rows[hi].map((c) => c.trim().toLowerCase());
  const col = {
    d: findCol(h, [/^date/, /date/, /time/]),
    o: findCol(h, [/^open$/, /open/], /interest/),
    h: findCol(h, [/^high$/, /high/], /52/),
    l: findCol(h, [/^low$/, /low/], /52/),
    c: findCol(h, [/^close$/, /close/, /ltp/, /last/], /prev|adj/),
    v: findCol(h, [/^volume$/, /volume/, /traded quantity|qty|quantity/], /value|turnover/),
    sym: findCol(h, [/^symbol$/]),
  };
  const missing = ["d", "o", "h", "l", "c"].filter((k) => col[k] < 0);
  if (missing.length) throw new Error("Missing column(s): " + missing.map((k) => ({ d: "Date", o: "Open", h: "High", l: "Low", c: "Close" }[k])).join(", ") + ".");
  let skipped = 0; const map = new Map();
  for (const r of rows.slice(hi + 1)) {
    const t = parseDate(r[col.d]), o = num(r[col.o]), H = num(r[col.h]), L = num(r[col.l]), C = num(r[col.c]);
    const v = col.v >= 0 ? num(r[col.v]) : 0;
    if (![t, o, H, L, C].every(isFinite) || H < L || C <= 0) { skipped++; continue; }
    map.set(t, { t, o, h: Math.max(H, o, C), l: Math.min(L, o, C), c: C, v: isFinite(v) ? v : 0 });
  }
  const bars = [...map.values()].sort((a, b) => a.t - b.t);
  if (bars.length < MIN_BARS) throw new Error(`Only ${bars.length} valid rows; at least ${MIN_BARS} are needed.`);
  const symbol = col.sym >= 0 ? String(rows[hi + 1][col.sym] || "").trim() : "";
  return { bars, skipped, symbol };
}
function parseOC(text) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => /strike/i.test(c)));
  if (hi < 0) throw new Error("No Strike column found in the option chain file.");
  const h = rows[hi].map((c) => c.trim().toUpperCase());
  const toks = (c) => c.split(/[^A-Z]+/).filter(Boolean);
  const si = h.findIndex((c) => /STRIKE/.test(c));
  const isOI = (c) => toks(c).includes("OI") || /OPEN INTEREST/.test(c);
  const isChg = (c) => toks(c).some((t) => ["CHNG", "CHG", "CHANGE"].includes(t));
  const isCall = (c) => toks(c).some((t) => ["CE", "CALL", "CALLS"].includes(t));
  const isPut = (c) => toks(c).some((t) => ["PE", "PUT", "PUTS"].includes(t));
  let ce = h.findIndex((c) => isOI(c) && !isChg(c) && isCall(c)), pe = h.findIndex((c) => isOI(c) && !isChg(c) && isPut(c));
  let cec = h.findIndex((c) => isOI(c) && isChg(c) && isCall(c)), pec = h.findIndex((c) => isOI(c) && isChg(c) && isPut(c));
  if (ce < 0 || pe < 0) { // NSE layout: calls left of STRIKE, puts right
    const oi = h.map((c, i) => (isOI(c) && !isChg(c) ? i : -1)).filter((i) => i >= 0);
    const ch = h.map((c, i) => (isOI(c) && isChg(c) ? i : -1)).filter((i) => i >= 0);
    ce = oi.filter((i) => i < si)[0] ?? -1; pe = oi.filter((i) => i > si).pop() ?? -1;
    cec = ch.filter((i) => i < si)[0] ?? -1; pec = ch.filter((i) => i > si).pop() ?? -1;
  }
  if (ce < 0 || pe < 0) throw new Error("Could not find call OI and put OI columns.");
  const out = rows.slice(hi + 1).map((r) => ({ strike: num(r[si]), ce: num(r[ce]) || 0, pe: num(r[pe]) || 0, cec: cec >= 0 ? num(r[cec]) || 0 : 0, pec: pec >= 0 ? num(r[pec]) || 0 : 0 }))
    .filter((r) => isFinite(r.strike) && r.strike > 0).sort((a, b) => a.strike - b.strike);
  if (out.length < 3) throw new Error("Fewer than 3 strikes found in the option chain.");
  return summarizeOC(out);
}
function summarizeOC(rows) {
  const tCE = rows.reduce((s, r) => s + r.ce, 0), tPE = rows.reduce((s, r) => s + r.pe, 0);
  let best = Infinity, maxPain = rows[0].strike;
  for (const k of rows) {
    const pain = rows.reduce((s, r) => s + r.ce * Math.max(0, k.strike - r.strike) + r.pe * Math.max(0, r.strike - k.strike), 0);
    if (pain < best) { best = pain; maxPain = k.strike; }
  }
  const top = (key) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, 2);
  return { rows, pcr: tCE > 0 ? tPE / tCE : NaN, maxPain, callWalls: top("ce"), putWalls: top("pe"), tCE, tPE };
}

/* ---------- indicators ---------- */
function ema(a, p) { const k = 2 / (p + 1); let e = a[0]; return a.map((x, i) => (e = i === 0 ? x : x * k + e * (1 - k))); }
function rsiS(c, p = 14) {
  let g = 0, l = 0; return c.map((x, i) => {
    if (i === 0) return 50; const d = x - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) { g += up / p; l += dn / p; } else { g = (g * (p - 1) + up) / p; l = (l * (p - 1) + dn) / p; }
    return i < p ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  });
}
function atrS(b, p = 14) {
  let a = 0; return b.map((x, i) => {
    const tr = i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c));
    a = i === 0 ? tr : i < p ? (a * i + tr) / (i + 1) : (a * (p - 1) + tr) / p; return a;
  });
}
function smaS(a, p) { let s = 0; return a.map((x, i) => { s += x; if (i >= p) s -= a[i - p]; return s / Math.min(i + 1, p); }); }
function buildCtx(bars) {
  const c = bars.map((b) => b.c);
  const gaps = bars.slice(1, 30).map((b, i) => b.t - bars[i].t);
  const intraday = gaps.length > 0 && Math.min(...gaps) < 20 * 3600e3;
  return { bars, c, e20: ema(c, 20), e50: ema(c, 50), rsi: rsiS(c), atr: atrS(bars), vol20: smaS(bars.map((b) => b.v), 20), unit: intraday ? "bar" : "day", hasVol: bars.some((b) => b.v > 0) };
}
const roundStep = (c) => c < 100 ? 5 : c < 500 ? 10 : c < 2000 ? 50 : c < 10000 ? 100 : 500;

/* ---------- levels ---------- */
function computeLevels(ctx, i, oc) {
  const b = ctx.bars, c = b[i].c, atr = Math.max(ctx.atr[i], c * 0.002);
  const start = Math.max(0, i - LOOKBACK), span = Math.max(1, i - start);
  const cands = [];
  const add = (p, w, src) => { if (isFinite(p) && p > 0) cands.push({ p, w, src }); };
  for (let j = start + SW; j <= i - SW; j++) {
    let isH = true, isL = true;
    for (let k = j - SW; k <= j + SW && (isH || isL); k++) {
      if (k === j) continue;
      if (b[k].h > b[j].h || (k > j && b[k].h === b[j].h)) isH = false;
      if (b[k].l < b[j].l || (k > j && b[k].l === b[j].l)) isL = false;
    }
    const rw = 1 + 0.6 * (j - start) / span;
    if (isH) add(b[j].h, rw, "swing high");
    if (isL) add(b[j].l, rw, "swing low");
  }
  let lo = Infinity, hi = -Infinity;
  for (let j = start; j <= i; j++) { lo = Math.min(lo, b[j].l); hi = Math.max(hi, b[j].h); }
  if (hi > lo) {
    const N = 40, w = (hi - lo) / N, bins = new Float64Array(N);
    for (let j = start; j <= i; j++) {
      const v = ctx.hasVol ? b[j].v : 1, a = clamp(Math.floor((b[j].l - lo) / w), 0, N - 1), z = clamp(Math.floor((b[j].h - lo) / w), 0, N - 1);
      for (let k = a; k <= z; k++) bins[k] += v / (z - a + 1);
    }
    const peaks = [];
    for (let k = 0; k < N; k++) if ((k === 0 || bins[k] >= bins[k - 1]) && (k === N - 1 || bins[k] >= bins[k + 1])) peaks.push(k);
    peaks.sort((x, y) => bins[y] - bins[x]).slice(0, 3).forEach((k, n) => add(lo + (k + 0.5) * w, n === 0 ? 2 : 1.2, n === 0 ? "volume POC" : "volume node"));
  }
  const H = b[i].h, L = b[i].l, P = (H + L + c) / 3;
  add(P, 0.6, "pivot P"); add(2 * P - L, 0.7, "pivot R1"); add(2 * P - H, 0.7, "pivot S1"); add(P + (H - L), 0.5, "pivot R2"); add(P - (H - L), 0.5, "pivot S2");
  let h20 = -Infinity, l20 = Infinity;
  for (let j = Math.max(0, i - 19); j <= i; j++) { h20 = Math.max(h20, b[j].h); l20 = Math.min(l20, b[j].l); }
  add(h20, 1, `20-${ctx.unit} high`); add(l20, 1, `20-${ctx.unit} low`);
  if (i >= 200 && ctx.unit === "day") {
    let h52 = -Infinity, l52 = Infinity;
    for (let j = Math.max(0, i - 249); j <= i; j++) { h52 = Math.max(h52, b[j].h); l52 = Math.min(l52, b[j].l); }
    add(h52, 1.2, "52-week high"); add(l52, 1.2, "52-week low");
  }
  const st = roundStep(c), f = Math.floor(c / st) * st;
  add(f, 0.5, "round number"); add(f + st, 0.5, "round number");
  if (oc) {
    oc.callWalls.forEach((r, n) => add(r.strike, n ? 1.5 : 2.2, "call OI wall"));
    oc.putWalls.forEach((r, n) => add(r.strike, n ? 1.5 : 2.2, "put OI wall"));
    add(oc.maxPain, 0.8, "max pain");
  }
  cands.sort((a, b2) => a.p - b2.p);
  const tol = Math.max(atr * 0.35, c * 0.003), groups = [];
  for (const x of cands) {
    const g = groups[groups.length - 1];
    if (g && x.p - g.mean <= tol) { g.items.push(x); g.sw += x.w; g.spw += x.p * x.w; g.mean = g.spw / g.sw; }
    else groups.push({ items: [x], sw: x.w, spw: x.p * x.w, mean: x.p });
  }
  return groups.map((g) => {
    const counts = {}; g.items.forEach((x) => (counts[x.src] = (counts[x.src] || 0) + 1));
    return { price: g.mean, score: g.sw, sources: counts };
  });
}
const stars = (s) => s >= 5 ? 5 : s >= 3.5 ? 4 : s >= 2.5 ? 3 : s >= 1.5 ? 2 : 1;
function splitLevels(levels, c) {
  return { sup: levels.filter((l) => l.price < c).sort((a, b) => b.price - a.price), res: levels.filter((l) => l.price >= c).sort((a, b) => a.price - b.price) };
}
const pick = (list, min = 1.5) => list.find((l) => l.score >= min) || null;
function sourcesText(l) {
  return Object.entries(l.sources).map(([k, n]) => (n > 1 ? `${n} ${k}s` : k)).join(", ");
}

/* ---------- decision: the pullback-buy rule ----------
 * Tested on 5 years of real NSE data (72 F&O stocks). Settings were chosen on 2021-24 only and then
 * checked on 2025-26, which the tuning never saw. BUY only when all three conditions hold:
 *   1. the stock is in an uptrend: close above its 50-day average, and the 20-day average above the 50-day
 *   2. it has just dipped sharply: RSI(2) below 10
 *   3. the market is in an uptrend: Nifty above its 50-day average (set by the user or a Nifty screenshot)
 * Buy at the next open, sell when RSI(2) closes above 70, with a safety stop 3 ATR below the entry
 * and a 15-day time limit.
 * SELL means "exit if you hold it" (the rule's own exit, RSI(2) above 70). It never means short-selling:
 * 120 short-selling rules were tested on the same data and none made money in both periods.
 */
const RULE = { name: "Pullback buy", rsiMax: 10, exitRsi: 70, stopAtr: 3, maxHold: 15, minBars: 50 };
/** How long the 1,012 real trades lasted, in trading days counting the entry day. */
const HOLD_DAYS = { p25: 2, median: 4, p75: 6, p90: 9, byDay5: 0.67 };
let NIFTY_UP = null; // true / false / null (unknown); set from the page
const setNiftyTrend = (v) => { NIFTY_UP = v; };

function smaN(a, n) { let s = 0; return a.map((x, i) => { s += x; if (i >= n) s -= a[i - n]; return i >= n - 1 ? s / n : NaN; }); }
/** Wilder RSI(2), plus the smoothed average gain and loss (needed to work out the exit price). */
function rsi2Parts(c) {
  const au = new Array(c.length), ad = new Array(c.length), r = new Array(c.length);
  au[0] = 0; ad[0] = 0; r[0] = 50;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    au[i] = (au[i - 1] + Math.max(d, 0)) / 2;
    ad[i] = (ad[i - 1] + Math.max(-d, 0)) / 2;
    r[i] = 100 - 100 / (1 + au[i] / Math.max(ad[i], 1e-12));
  }
  return { au, ad, r };
}
/** The close that would lift RSI(2) to the exit level tomorrow (the rule's planned exit). */
function exitPrice(c, au, ad) {
  // Tomorrow's averages after a rise of d: au' = (au + d) / 2, ad' = ad / 2, so RS = (au + d) / ad.
  const need = (RULE.exitRsi / (100 - RULE.exitRsi)) * ad - au;
  return c + Math.max(0, need);
}
/** Average daily range as used in the research: exponential average of the true range (14 days). */
function atrRule(bars) {
  const tr = bars.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - bars[i - 1].c), Math.abs(x.l - bars[i - 1].c))));
  return ema(tr, 14);
}
function ruleIndicators(bars) {
  const c = bars.map((b) => b.c);
  return { c, sma20: smaN(c, 20), sma50: smaN(c, 50), atr: atrRule(bars), ...rsi2Parts(c) };
}
function ruleConditions(ind, i, niftyUp) {
  const c = ind.c[i], s20 = ind.sma20[i], s50 = ind.sma50[i], r = ind.r[i];
  const enough = i + 1 >= RULE.minBars;
  return [
    { key: "trend", ok: enough && c > s50 && s20 > s50,
      text: !enough ? `Needs at least ${RULE.minBars} candles to judge the trend (this chart has ${i + 1}).`
        : c > s50 && s20 > s50 ? `Stock in an uptrend: price ${inr(c)} is above its 50-day average ${inr(s50)}, and the 20-day average is above the 50-day.`
        : `Stock not in an uptrend: price ${inr(c)}, 20-day average ${inr(s20)}, 50-day average ${inr(s50)}.` },
    { key: "dip", ok: r < RULE.rsiMax,
      text: r < RULE.rsiMax ? `Sharp dip: RSI(2) is ${r.toFixed(1)}, below ${RULE.rsiMax}.` : `No sharp dip: RSI(2) is ${r.toFixed(1)}; it needs to fall below ${RULE.rsiMax}.` },
    { key: "nifty", ok: niftyUp === true,
      text: niftyUp === true ? "Market in an uptrend: Nifty is above its 50-day average."
        : niftyUp === false ? "Market not in an uptrend: Nifty is below its 50-day average. In tests, buying dips then did not work."
        : "Nifty trend not set. Set it at the top, or upload a Nifty chart screenshot." },
  ];
}

/**
 * The close that would turn a WAIT into a BUY: low enough for RSI(2) to fall below the limit,
 * but not so low that the uptrend breaks. Returns { hi, lo } (buy zone for the close) or null.
 */
function buyTrigger(ind, i) {
  if (i + 1 < RULE.minBars || i < 49) return null;
  const c = ind.c[i], au = ind.au[i], ad = ind.ad[i], k = RULE.rsiMax / (100 - RULE.rsiMax);
  // Tomorrow after a fall of d: au' = au / 2, ad' = (ad + d) / 2, so RSI(2) < limit when au / (ad + d) < k.
  const hi = c - Math.max(0, au / k - ad) - c * 0.0005;
  // The trend must survive that close x: x above tomorrow's 50-day average, 20-day average above the 50-day.
  const c50 = ind.c[i - 49], c20 = ind.c[i - 19], s50 = ind.sma50[i], s20 = ind.sma20[i];
  const lo = Math.max((s50 - c50 / 50) * 50 / 49, (s50 - s20 + c20 / 20 - c50 / 50) / (1 / 20 - 1 / 50));
  return hi > lo && hi > 0 ? { hi, lo } : null;
}
/** Trading days (Mon-Fri; exchange holidays are not known) starting from the next session. */
function tradeTimeline(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000); // shift to Indian time, read with UTC getters
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const beforeOpen = ist.getUTCHours() * 60 + ist.getUTCMinutes() < 9 * 60 + 15;
  const isWeekday = (d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;
  const next = (d) => { const x = new Date(d.getTime() + 86400000); return isWeekday(x) ? x : next(x); };
  const entry = beforeOpen && isWeekday(day) ? day : next(day);
  const nth = (n) => { let d = entry; for (let k = 1; k < n; k++) d = next(d); return d; }; // n-th trading day, entry = 1
  return { entry, typicalFrom: nth(HOLD_DAYS.p25), typicalTo: nth(5), last: nth(RULE.maxHold) };
}
/**
 * A dip-buy signal earlier on this chart (Nifty is not known for past days, so it is not checked):
 * SELL when that trade's exit happens on the last candle, HOLD while it is still open, otherwise null.
 */
function heldTrade(ctx, i, ind) {
  if (i !== ctx.bars.length - 1) return null;
  const all = backtest({ ...ctx, rule: ind }).trades, t = all[all.length - 1];
  if (!t) return null;
  const b = ctx.bars, n = b.length;
  const entryIdx = b.findIndex((x) => x.t === t.t) + 1;
  const daysIn = n - entryIdx; // trading days held including today
  if (t.outcome === "open") {
    return { state: "HOLD", entry: t.entry, stop: t.stop, sellAt: exitPrice(ind.c[i], ind.au[i], ind.ad[i]), daysIn, daysLeft: RULE.maxHold - daysIn };
  }
  if (t.exitT === b[n - 1].t) return { state: "SELL", entry: t.entry, stop: t.stop, why: t.outcome, exitPx: t.exitPx, daysIn, ret: t.ret };
  return null;
}
const fmtDay = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function makePlan(ctx, i, levels, oc) {
  const b = ctx.bars, c = b[i].c;
  const ind = ctx.rule || ruleIndicators(b), atr = Math.max(ind.atr[i], c * 0.002);
  const { sup, res } = splitLevels(levels, c);
  const key = (list) => list.find((l) => l.score >= 2.5 && Math.abs(l.price - c) >= 0.25 * atr) || list.find((l) => l.score >= 1.5 && Math.abs(l.price - c) >= 0.25 * atr) || null;
  const S = key(sup), R = key(res);
  const sP = S ? S.price : c - 2 * atr, rP = R ? R.price : c + 2 * atr;
  const conditions = ruleConditions(ind, i, NIFTY_UP);
  const met = conditions.filter((x) => x.ok).length;
  const buy = met === conditions.length;
  const entry = c, stop = c - RULE.stopAtr * atr, target = exitPrice(c, ind.au[i], ind.ad[i]);
  const rr = (target - entry) / (entry - stop);
  const held = buy ? null : heldTrade(ctx, i, ind);
  const side = buy ? "BUY" : held ? held.state : "WAIT";
  const trigger = !buy && conditions[0].ok && !conditions[1].ok ? buyTrigger(ind, i) : null;
  return {
    side, type: buy ? "market" : "", setup: buy ? RULE.name : held ? (held.state === "SELL" ? "Exit the dip buy" : "Dip buy still open") : "No trade",
    entry: buy ? entry : NaN, stop: buy ? stop : NaN, target: buy ? target : NaN, rr: buy ? rr : NaN,
    holdExit: target, trigger, held, timeline: buy ? tradeTimeline() : null,
    conditions, met, why: conditions.map((x) => x.text),
    waitReason: buy ? "" : conditions.filter((x) => !x.ok).map((x) => x.text).join(" "),
    trend: conditions[0].ok ? "up" : "not up", rsi2: ind.r[i], S, R, sP, rP, dS: (c - sP) / atr, dR: (rP - c) / atr, sup, res, atr,
    e20: ind.sma20[i], e50: ind.sma50[i],
  };
}

/* ---------- backtest of the rule on uploaded price data (no Nifty check: a CSV carries no Nifty data) ---------- */
function backtest(ctx) {
  const b = ctx.bars, n = b.length, ind = ctx.rule, trades = [];
  let i = RULE.minBars - 1;
  while (i < n - 1) {
    const cond = ruleConditions(ind, i, true);
    if (!(cond[0].ok && cond[1].ok)) { i++; continue; }
    const e = i + 1, entry = b[e].o, stop = entry - RULE.stopAtr * ind.atr[i];
    let exit = -1, px = NaN, outcome = "";
    for (let k = e; k < Math.min(n, e + RULE.maxHold); k++) {
      if (b[k].l <= stop) { exit = k; px = Math.min(stop, b[k].o); outcome = "stop"; break; }
      if (ind.r[k] > RULE.exitRsi) { exit = k; px = b[k].c; outcome = "bounce"; break; }
    }
    if (exit < 0) {
      if (e + RULE.maxHold - 1 >= n) { trades.push({ t: b[i].t, entry, stop, outcome: "open", exitT: b[n - 1].t, exitPx: b[n - 1].c, ret: (b[n - 1].c - entry) / entry - 0.001 }); break; }
      exit = e + RULE.maxHold - 1; px = b[exit].c; outcome = "time";
    }
    trades.push({ t: b[i].t, entry, stop, outcome, exitT: b[exit].t, exitPx: px, ret: (px - entry) / entry - 0.001 });
    i = exit + 1;
  }
  const closed = trades.filter((t) => t.outcome !== "open");
  const wins = closed.filter((t) => t.ret > 0).length;
  return { trades, closed: closed.length, wins, winRate: closed.length ? wins / closed.length : NaN,
    avgRet: closed.length ? (closed.reduce((s, t) => s + t.ret, 0) / closed.length) * 100 : NaN,
    worst: closed.length ? Math.min(...closed.map((t) => t.ret)) * 100 : NaN, bars: n };
}

/* ---------- analysis + summary ---------- */
function analyse(stock) {
  const ctx = { ...buildCtx(stock.bars), rule: ruleIndicators(stock.bars) }, i = stock.bars.length - 1;
  const levels = computeLevels(ctx, i, stock.oc);
  const plan = makePlan(ctx, i, levels, stock.oc);
  const bt = stock.bt || backtest(ctx);
  return { ...stock, ctx, levels, plan, bt, summary: summarize(stock, ctx, plan, bt) };
}
const fmtDate = (t, intraday) => new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC", ...(intraday ? { hour: "2-digit", minute: "2-digit" } : {}) });
function summarize(stock, ctx, p, bt) {
  const b = ctx.bars, last = b[b.length - 1], s = [];
  s.push(`${stock.symbol} closed at ${inr(last.c)} on ${fmtDate(last.t, ctx.unit === "bar")}.`);
  if (p.side === "BUY") {
    s.push(`All conditions for a ${RULE.name.toLowerCase()} are met: the stock and the market are in uptrends, and the stock has just dipped sharply.`);
    const tl = p.timeline;
    s.push(`Plan: buy near ${inr(p.entry)} at the open on ${fmtDay(tl.entry)} (9:15 AM). Stop loss ${inr(p.stop)}. Sell on the bounce: when a day closes around ${inr(p.target)} or higher (RSI(2) above ${RULE.exitRsi}), sell at that close. In past trades half were closed within ${HOLD_DAYS.median} trading days and two in three by ${fmtDay(tl.typicalTo)}. If neither the target nor the stop is hit, sell by ${fmtDay(tl.last)} at the latest.`);
  } else if (p.side === "SELL") {
    const h = p.held, why = { bounce: `the bounce has come (RSI(2) closed above ${RULE.exitRsi})`, stop: `the stop loss ${inr(h.stop)} was hit`, time: `the ${RULE.maxHold}-day limit is reached` }[h.why];
    s.push(`Decision: SELL if you bought on the dip signal on this chart (entry about ${inr(h.entry)}, held ${h.daysIn} trading day${h.daysIn === 1 ? "" : "s"}): ${why}. Sell at today's close or the next open; that trade ${h.ret >= 0 ? "made" : "lost"} about ${Math.abs(h.ret * 100).toFixed(1)}%. If you don't hold it, do nothing: this is not a short-sell signal (short-selling lost money in tests).`);
  } else if (p.side === "HOLD") {
    const h = p.held;
    s.push(`Decision: HOLD if you bought on the dip signal on this chart (entry about ${inr(h.entry)}, held ${h.daysIn} trading day${h.daysIn === 1 ? "" : "s"} so far). Sell when the next close is ${inr(h.sellAt)} or higher (check again each day: this price moves), if the price falls to the stop loss ${inr(h.stop)}, or at the latest in ${h.daysLeft} trading day${h.daysLeft === 1 ? "" : "s"}. If you don't hold it, don't buy now: the dip entry has passed.`);
  } else {
    s.push(`Decision: wait. ${p.waitReason}`);
    if (p.trigger) s.push(`It becomes a BUY if a day closes between ${inr(p.trigger.lo)} and ${inr(p.trigger.hi)}${NIFTY_UP === true ? "" : " and Nifty is in an uptrend"}. Check again after that close.`);
  }
  s.push(p.S ? `Key support is ${inr(p.S.price)}, where ${sourcesText(p.S)} line up.` : "There is no strong support below; price is at fresh lows.");
  s.push(p.R ? `Key resistance is ${inr(p.R.price)}, from ${sourcesText(p.R)}.` : "There is no resistance overhead; price is at fresh highs.");
  if (stock.oc) s.push(`Option chain: PCR ${stock.oc.pcr.toFixed(2)}, biggest put wall ${inr(stock.oc.putWalls[0].strike, 0)}, biggest call wall ${inr(stock.oc.callWalls[0].strike, 0)}, max pain ${inr(stock.oc.maxPain, 0)}.`);
  return s;
}

