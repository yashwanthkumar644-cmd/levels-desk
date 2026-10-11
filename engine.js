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

/* ---------- decision ---------- */
function makePlan(ctx, i, levels, oc) {
  const b = ctx.bars, c = b[i].c, atr = Math.max(ctx.atr[i], c * 0.002);
  const e20 = ctx.e20[i], e50 = ctx.e50[i], r = ctx.rsi[i];
  const { sup, res } = splitLevels(levels, c);
  const key = (list) => list.find((l) => l.score >= 2.5 && Math.abs(l.price - c) >= 0.25 * atr) || list.find((l) => l.score >= 1.5 && Math.abs(l.price - c) >= 0.25 * atr) || null;
  const S = key(sup), R = key(res);
  const sP = S ? S.price : c - 2 * atr, rP = R ? R.price : c + 2 * atr;
  const dS = (c - sP) / atr, dR = (rP - c) / atr;
  const trend = c > e20 && e20 > e50 ? "up" : c < e20 && e20 < e50 ? "down" : "sideways";
  let prevHi = -Infinity, prevLo = Infinity;
  for (let j = Math.max(0, i - 20); j < i; j++) { prevHi = Math.max(prevHi, b[j].h); prevLo = Math.min(prevLo, b[j].l); }
  const volx = ctx.hasVol && ctx.vol20[i - 1] > 0 ? b[i].v / ctx.vol20[i - 1] : 1;
  const breakout = i >= 21 && c > prevHi && volx >= 1.3, breakdown = i >= 21 && c < prevLo && volx >= 1.3;
  const why = []; let score = 0;
  if (trend === "up") { score += 30; why.push("Trend is up: close is above the 20 EMA, and the 20 EMA is above the 50 EMA."); }
  else if (trend === "down") { score -= 30; why.push("Trend is down: close is below the 20 EMA, and the 20 EMA is below the 50 EMA."); }
  else why.push("Trend is mixed: the averages do not line up in one direction.");
  const rAdj = clamp((r - 50) * 0.8, -15, 15); score += rAdj;
  why.push(`RSI(14) is ${r.toFixed(0)}${r >= 70 ? ", overbought" : r <= 30 ? ", oversold" : ""}.`);
  if (oc && isFinite(oc.pcr)) {
    if (oc.pcr >= 1.2) { score += 10; why.push(`Put-call ratio ${oc.pcr.toFixed(2)} shows heavy put writing, which usually supports price.`); }
    else if (oc.pcr <= 0.8) { score -= 10; why.push(`Put-call ratio ${oc.pcr.toFixed(2)} shows heavy call writing, which usually caps price.`); }
    else why.push(`Put-call ratio ${oc.pcr.toFixed(2)} is neutral.`);
  }
  if (S && dS <= 0.8) { score += 12; why.push(`Price is sitting on support (${dS.toFixed(1)} ATR above it).`); }
  if (R && dR <= 0.8) { score -= 12; why.push(`Price is pressing into resistance (${dR.toFixed(1)} ATR below it).`); }
  if (breakout) { score += 25; why.push(`Closed above the prior 20-${ctx.unit} high on ${volx.toFixed(1)}× average volume: breakout.`); }
  if (breakdown) { score -= 25; why.push(`Closed below the prior 20-${ctx.unit} low on ${volx.toFixed(1)}× average volume: breakdown.`); }
  score = Math.round(clamp(score, -100, 100));

  let side = "WAIT", type = "", entry = NaN, stop = NaN, target = NaN, setup = "";
  if (breakout && trend !== "down") {
    side = "BUY"; type = "market"; entry = c; stop = Math.min(prevHi - 0.5 * atr, c - 0.8 * atr);
    target = R && dR >= 1 ? rP - 0.1 * atr : c + 2.5 * atr; setup = "Breakout buy";
  } else if (breakdown && trend !== "up") {
    side = "SELL"; type = "market"; entry = c; stop = Math.max(prevLo + 0.5 * atr, c + 0.8 * atr);
    target = S && dS >= 1 ? sP + 0.1 * atr : c - 2.5 * atr; setup = "Breakdown sell";
  } else if (score >= 25) {
    side = "BUY"; type = dS <= 1 ? "market" : "limit"; entry = type === "market" ? c : sP + 0.15 * atr;
    stop = sP - 0.5 * atr; target = rP - 0.1 * atr; setup = type === "market" ? "Buy at support" : "Buy on dip to support";
  } else if (score <= -25) {
    side = "SELL"; type = dR <= 1 ? "market" : "limit"; entry = type === "market" ? c : rP - 0.15 * atr;
    stop = rP + 0.5 * atr; target = sP + 0.1 * atr; setup = type === "market" ? "Sell at resistance" : "Sell on rise to resistance";
  }
  let rr = NaN, waitReason = "";
  if (side !== "WAIT") {
    const risk = Math.abs(entry - stop), reward = side === "BUY" ? target - entry : entry - target;
    rr = risk > 0 ? reward / risk : NaN;
    if (!(rr >= 1.5)) {
      waitReason = `The bias is ${side === "BUY" ? "bullish" : "bearish"}, but the next level is too close: reward-to-risk is ${isFinite(rr) ? rr.toFixed(1) : "under 1"} : 1, below the 1.5 : 1 minimum.`;
      side = "WAIT"; setup = "";
    }
  } else waitReason = score > 0 ? "Mildly bullish, but not enough agreement between trend, momentum and levels." : score < 0 ? "Mildly bearish, but not enough agreement between trend, momentum and levels." : "No edge: signals cancel out.";
  if (side === "WAIT") { entry = stop = target = rr = NaN; type = ""; }
  return { side, type, entry, stop, target, rr, score, trend, S, R, sP, rP, dS, dR, breakout, breakdown, why, waitReason, setup, sup, res, atr, rsi: r, e20, e50 };
}

/* ---------- backtest ---------- */
function backtest(ctx) {
  const b = ctx.bars, n = b.length, cache = [];
  const lv = (i) => cache[i] || (cache[i] = computeLevels(ctx, i, null));
  const start = Math.max(60, SW * 2 + 21), trades = [];
  let i = start;
  while (i < n - 1) {
    const p = makePlan(ctx, i, lv(i), null);
    if (p.side === "WAIT") { i++; continue; }
    const long = p.side === "BUY";
    let fill = -1;
    if (p.type === "market") fill = i;
    else for (let k = i + 1; k <= Math.min(n - 1, i + FILL_BARS); k++) if (long ? b[k].l <= p.entry : b[k].h >= p.entry) { fill = k; break; }
    if (fill < 0) { i++; continue; }
    let outcome = "open", exit = -1, exitPx = NaN;
    for (let k = p.type === "market" ? fill + 1 : fill; k <= Math.min(n - 1, fill + HOLD); k++) {
      const hitStop = long ? b[k].l <= p.stop : b[k].h >= p.stop, hitTgt = long ? b[k].h >= p.target : b[k].l <= p.target;
      if (hitStop) { outcome = "loss"; exit = k; exitPx = p.stop; break; }
      if (hitTgt && !(k === fill && p.type === "limit")) { outcome = "win"; exit = k; exitPx = p.target; break; }
    }
    if (outcome === "open") {
      if (fill + HOLD <= n - 1) { outcome = "timeout"; exit = fill + HOLD; exitPx = b[exit].c; }
      else { exit = n - 1; exitPx = b[n - 1].c; }
    }
    const risk = Math.abs(p.entry - p.stop);
    const rMult = risk > 0 ? (long ? exitPx - p.entry : p.entry - exitPx) / risk : 0;
    trades.push({ t: b[i].t, side: p.side, setup: p.setup, entry: p.entry, stop: p.stop, target: p.target, outcome, exitT: b[exit].t, exitPx, r: rMult });
    if (outcome === "open") break;
    i = exit + 1;
  }
  const closed = trades.filter((t) => t.outcome !== "open");
  const wins = closed.filter((t) => t.outcome === "win").length, losses = closed.filter((t) => t.outcome === "loss").length;
  const avgR = closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : NaN;
  // level hold test
  const hold = { sT: 0, sH: 0, rT: 0, rH: 0 };
  for (let j = start; j < n - 3; j += 3) {
    const c = b[j].c, atr = Math.max(ctx.atr[j], c * 0.002), { sup, res } = splitLevels(lv(j), c);
    const S = pick(sup, 2.5), R = pick(res, 2.5);
    if (S) for (let k = j + 1; k <= Math.min(n - 3, j + 10); k++) if (b[k].l <= S.price + 0.1 * atr) {
      hold.sT++; if ([k, k + 1, k + 2].every((x) => b[x].c >= S.price - 0.25 * atr)) hold.sH++; break;
    }
    if (R) for (let k = j + 1; k <= Math.min(n - 3, j + 10); k++) if (b[k].h >= R.price - 0.1 * atr) {
      hold.rT++; if ([k, k + 1, k + 2].every((x) => b[x].c <= R.price + 0.25 * atr)) hold.rH++; break;
    }
  }
  return { trades, wins, losses, timeouts: closed.filter((t) => t.outcome === "timeout").length, winRate: wins + losses ? wins / (wins + losses) : NaN, avgR, hold, bars: n - start };
}

/* ---------- analysis + summary ---------- */
function analyse(stock) {
  const ctx = buildCtx(stock.bars), i = stock.bars.length - 1;
  const levels = computeLevels(ctx, i, stock.oc);
  const plan = makePlan(ctx, i, levels, stock.oc);
  const bt = stock.bt || backtest(ctx);
  return { ...stock, ctx, levels, plan, bt, summary: summarize(stock, ctx, plan, bt) };
}
const fmtDate = (t, intraday) => new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC", ...(intraday ? { hour: "2-digit", minute: "2-digit" } : {}) });
function summarize(stock, ctx, p, bt) {
  const b = ctx.bars, last = b[b.length - 1], s = [];
  s.push(`${stock.symbol} closed at ${inr(last.c)} on ${fmtDate(last.t, ctx.unit === "bar")}.`);
  s.push(p.trend === "up" ? `It trades above its 20 EMA (${inr(p.e20)}) and 50 EMA (${inr(p.e50)}), so the trend is up.`
    : p.trend === "down" ? `It trades below its 20 EMA (${inr(p.e20)}) and 50 EMA (${inr(p.e50)}), so the trend is down.`
    : `The 20 EMA (${inr(p.e20)}) and 50 EMA (${inr(p.e50)}) disagree, so the trend is sideways.`);
  s.push(p.S ? `Key support is ${inr(p.S.price)}, ${p.dS.toFixed(1)} ATR below, where ${sourcesText(p.S)} line up.` : "There is no strong support below; price is at fresh lows.");
  s.push(p.R ? `Key resistance is ${inr(p.R.price)}, ${p.dR.toFixed(1)} ATR above, from ${sourcesText(p.R)}.` : "There is no resistance overhead; price is at fresh highs.");
  if (stock.oc) s.push(`Option chain: PCR ${stock.oc.pcr.toFixed(2)}, biggest put wall ${inr(stock.oc.putWalls[0].strike, 0)}, biggest call wall ${inr(stock.oc.callWalls[0].strike, 0)}, max pain ${inr(stock.oc.maxPain, 0)}.`);
  if (p.side === "BUY") s.push(`Decision: ${p.setup.toLowerCase()}${p.type === "limit" ? ` with a limit near ${inr(p.entry)}` : ` at ${inr(p.entry)}`}, stop ${inr(p.stop)}, target ${inr(p.target)} (${p.rr.toFixed(1)} : 1). A daily close below ${inr(p.stop)} cancels the idea.`);
  else if (p.side === "SELL") s.push(`Decision: ${p.setup.toLowerCase()}${p.type === "limit" ? ` with a limit near ${inr(p.entry)}` : ` at ${inr(p.entry)}`}, stop ${inr(p.stop)}, target ${inr(p.target)} (${p.rr.toFixed(1)} : 1). A daily close above ${inr(p.stop)} cancels the idea.`);
  else s.push(`Decision: wait. ${p.waitReason}${p.S && p.R ? ` Treat ${inr(p.sP)} to ${inr(p.rP)} as the range until one side breaks on volume.` : ""}`);
  const closed = bt.wins + bt.losses;
  s.push(closed >= 10 ? `On your ${b.length} bars, this same rule hit target before stop in ${(bt.winRate * 100).toFixed(0)}% of ${closed} trades, averaging ${bt.avgR >= 0 ? "+" : ""}${bt.avgR.toFixed(2)}R per trade.`
    : `The rule fired only ${closed} time${closed === 1 ? "" : "s"} on this history, too few to judge reliability. Upload a longer file.`);
  return s;
}

