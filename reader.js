/* Levels Desk chart reader: turns a chart screenshot into candles, entirely on the device.
 * Text recognition (price scale, symbol) uses Tesseract.js; candles are found by colour.
 * Exposes window.ChartReader = { read(file, knownSymbols, onProgress), warmUp(onProgress), configure({ base }) }.
 */
(() => {
  "use strict";
  const MIN_AXIS_LABELS = 4;
  const MAX_SIDE = 2400; // larger screenshots are scaled down first
  const OCR_SCALE = 2; // small axis text reads far better when enlarged
  let base = "";

  class ReadError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; }
  }

  // ---------- text recognition ----------
  let workerPromise = null;
  function makeWorker(onProgress) {
    return Tesseract.createWorker("eng", 1, {
        workerPath: base + "vendor/worker.min.js",
        corePath: base + "vendor/core",
        langPath: base + "vendor/lang",
        workerBlobURL: false,
        logger: (m) => onProgress && onProgress(m),
      }).then(async (w) => {
        await w.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" }); // sparse text
        return w;
      });
  }
  function getWorker(onProgress) {
    if (!workerPromise) {
      // The engine is a large download; one retry covers a slow or interrupted first load.
      workerPromise = makeWorker(onProgress)
        .catch(() => makeWorker(onProgress))
        .catch((e) => { workerPromise = null; throw new ReadError("ocr_unavailable", String(e && e.message || e)); });
    }
    return workerPromise;
  }

  async function ocrWords(canvas, scale, offsetX, onProgress, keepColour = false) {
    const worker = await getWorker(onProgress);
    const { data } = await worker.recognize(prepareForOcr(canvas, scale, keepColour));
    const words = [];
    for (const line of data.lines || []) {
      const merged = [];
      for (const w of line.words || []) {
        const b = w.bbox;
        const cur = { text: w.text, conf: w.confidence, x: b.x0 / scale + offsetX, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale };
        const prev = merged[merged.length - 1];
        // Recognition sometimes splits '1,900.0' into '1' and ',900.0'; rejoin pieces that touch.
        if (prev && cur.x - (prev.x + prev.w) <= 0.45 * Math.max(prev.h, cur.h) && isNumericPiece(prev.text) && isNumericPiece(cur.text)) {
          const top = Math.min(prev.y, cur.y), bottom = Math.max(prev.y + prev.h, cur.y + cur.h);
          merged[merged.length - 1] = { text: prev.text + cur.text, conf: Math.min(prev.conf, cur.conf), x: prev.x, y: top, w: cur.x + cur.w - prev.x, h: bottom - top };
        } else merged.push(cur);
      }
      words.push(...merged);
    }
    return words;
  }
  const isNumericPiece = (t) => /^[\dOo,._]+$/.test(t);

  /** Scaled greyscale copy with dark text on a light background, which the text engine reads best. */
  function prepareForOcr(canvas, scale, keepColour = false) {
    const out = document.createElement("canvas");
    out.width = Math.round(canvas.width * scale); out.height = Math.round(canvas.height * scale);
    const g = out.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, 0, 0, out.width, out.height);
    const img = g.getImageData(0, 0, out.width, out.height), d = img.data;
    const lum = new Float32Array(d.length / 4);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    // The background is the most common brightness. Each pixel becomes darker the more it differs
    // from it, so light-on-dark and dark-on-light text (and coloured tags) all end up dark on white.
    const hist = new Uint32Array(256);
    for (let i = 0; i < lum.length; i += 7) hist[lum[i] | 0]++;
    const bg = hist.indexOf(Math.max(...hist));
    const W = out.width, H = out.height;
    // Scale labels and titles are grey, white or black; strongly coloured pixels are candles,
    // moving-average lines and coloured tags, which only confuse the text engine.
    const coloured = new Uint8Array(lum.length);
    for (let i = 0; i < lum.length; i++) {
      const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2], mx = Math.max(r, gg, b);
      // Coloured text (legends, OHLC values) must be readable on the full-chart pass so it can be masked.
      coloured[i] = !keepColour && mx >= 60 && (mx - Math.min(r, gg, b)) / mx >= 0.3 ? 1 : 0;
    }
    const ink = new Uint8Array(lum.length);
    for (let i = 0; i < lum.length; i++) ink[i] = !coloured[i] && Math.abs(lum[i] - bg) > 24 ? 1 : 0;
    // Grid lines touching the price labels make the engine skip the labels entirely, and candle
    // wicks and bodies are not text either: erase long horizontal and vertical strokes.
    const erase = new Uint8Array(lum.length);
    const hMin = Math.max(30, Math.round(W * 0.12)), vMin = Math.max(30, Math.round(48 * scale));
    for (let y = 0; y < H; y++) {
      let s = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && ink[y * W + x];
        if (on && s < 0) s = x;
        if (!on && s >= 0) { if (x - s >= hMin) for (let k = s; k < x; k++) erase[y * W + k] = 1; s = -1; }
      }
    }
    for (let x = 0; x < W; x++) {
      let s = -1;
      for (let y = 0; y <= H; y++) {
        const on = y < H && ink[y * W + x];
        if (on && s < 0) s = y;
        if (!on && s >= 0) { if (y - s >= vMin) for (let k = s; k < y; k++) erase[k * W + x] = 1; s = -1; }
      }
    }
    for (let i = 0; i < lum.length; i++) {
      // Faint grid lines (barely different from the background) become pure background too.
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = erase[i] || coloured[i] || !ink[i] ? 255 : Math.max(0, 255 - Math.abs(lum[i] - bg) * 2.2);
    }
    g.putImageData(img, 0, 0);
    return out;
  }

  /** Candidate values for an axis label; a label that lost its decimal point also offers /10 and /100. */
  function parseNumber(text) {
    let t = text.trim().replace(/[Oo]/g, "0").replace(/\s/g, "").replace(/_/g, ".").replace(/%$/, "");
    if (/^[\d,]+,\d{1,2}$/.test(t)) { const i = t.lastIndexOf(","); t = t.slice(0, i) + "." + t.slice(i + 1); }
    if (!/^[\d,]*\.?\d+$/.test(t)) return [];
    const v = parseFloat(t.replace(/,/g, ""));
    if (!(v > 0)) return [];
    return t.includes(".") ? [v] : [v, v / 10, v / 100];
  }

  // ---------- price axis ----------
  function fit(points) {
    const n = points.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [y, p] of points) { sx += y; sy += p; sxx += y * y; sxy += y * p; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return [slope, (sy - slope * sx) / n];
  }

  function ransacInliers(points) {
    let best = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const [y1, p1, a] = points[i], [y2, p2, b] = points[j];
        if (a === b || Math.abs(y2 - y1) < 5) continue;
        const slope = (p2 - p1) / (y2 - y1);
        if (slope >= 0) continue;
        const tol = Math.abs(slope) * 3; // within about 3 px
        const chosen = new Map();
        for (const pt of points) {
          const err = Math.abs(p1 + slope * (pt[0] - y1) - pt[1]);
          const prev = chosen.get(pt[2]);
          if (err <= tol && (!prev || err < prev.err)) chosen.set(pt[2], { pt, err });
        }
        const cand = [...chosen.values()].map((c) => c.pt);
        const exact = (list) => list.reduce((a, p) => a + p[3], 0);
        if (cand.length > best.length || (cand.length === best.length && exact(cand) > exact(best))) best = cand;
      }
    }
    return best;
  }

  function findAxis(words, width) {
    const nums = words.map((w) => [w, parseNumber(w.text)]).filter(([w, v]) => v.length && w.x > width * 0.5);
    let best = null;
    for (const [anchor] of nums) {
      const column = nums.filter(([w]) => w.x <= anchor.x + anchor.w + 6 && w.x + w.w >= anchor.x - 6);
      if (column.length < MIN_AXIS_LABELS) continue;
      const points = [];
      column.forEach(([w, vals], k) => vals.forEach((v, n) => points.push([w.y + w.h / 2, v, k, n === 0 ? 1 : 0])));
      const inliers = ransacInliers(points);
      if (inliers.length < MIN_AXIS_LABELS) continue;
      // More labels first; then readings that use the numbers exactly as written; then the right-most column.
      const score = [inliers.length, inliers.reduce((a, p) => a + p[3], 0), anchor.x / width];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
        best = { score, cols: inliers.map(([y, p, k]) => [column[k][0], p]) };
      }
    }
    if (!best) throw new ReadError("no_axis");
    const pts = best.cols.map(([w, v]) => [w.y + w.h / 2, v]);
    const [slope, intercept] = fit(pts);
    const ys = pts.map((p) => p[0]).sort((a, b) => a - b);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 3);
    return {
      slope, intercept,
      labelGap: gaps.length ? median(gaps) : 40, // pixels between neighbouring price labels
      xLeft: Math.min(...best.cols.map(([w]) => w.x)),
      yTop: Math.min(...best.cols.map(([w]) => w.y)),
      yBottom: Math.max(...best.cols.map(([w]) => w.y + w.h)),
      price: (y) => intercept + slope * y,
      // How far the worst price label sits off the straight scale, in pixels (a real axis is ~0-2 px).
      errPx: Math.max(...pts.map(([y, p]) => Math.abs(p - (intercept + slope * y)) / Math.abs(slope))),
    };
  }

  // ---------- candles ----------
  function colourMasks(img) {
    const { data, width, height } = img, n = width * height;
    const green = new Uint8Array(n), red = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      // Real candles are strong, bright colours; see-through volume bars and anti-aliased edges are paler or darker.
      if (mx < 140 || (mx - mn) / mx < 0.45) continue;
      // Candle greens/teals have blue no higher than green (cyan lines do); candle reds have little
      // green or blue (orange, pink and purple lines don't count).
      if (g >= r + 40 && b <= g + 4) green[i] = 1;
      else if (r >= g + 60 && r >= b + 40 && g <= r * 0.45 && b <= r * 0.6) red[i] = 1;
    }
    return [green, red];
  }

  /** Vertical runs [top, bottom] of set pixels in column x between rows y0 and y1. */
  function colRuns(mask, w, x, y0, y1) {
    const out = [];
    let start = -1;
    for (let y = y0; y < y1; y++) {
      if (mask[y * w + x]) { if (start < 0) start = y; }
      else if (start >= 0) { out.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) out.push([start, y1 - 1]);
    return out;
  }

  function removeLongHorizontal(mask, w, y0, y1, x1, minLen) {
    const out = new Uint8Array(mask.length);
    for (let y = y0; y < y1; y++) {
      let start = -1;
      for (let x = 0; x <= x1; x++) {
        const on = x < x1 && mask[y * w + x];
        if (on && start < 0) start = x;
        if (!on && start >= 0) {
          if (x - start >= minLen) for (let k = start; k < x; k++) out[y * w + k] = 1;
          start = -1;
        }
      }
    }
    return out;
  }

  function closeVertical(mask, w, y0, y1, x1, gap) {
    const out = mask.slice();
    for (let x = 0; x < x1; x++) {
      const runs = colRuns(mask, w, x, y0, y1);
      for (let k = 1; k < runs.length; k++) {
        if (runs[k][0] - runs[k - 1][1] - 1 <= gap) for (let y = runs[k - 1][1] + 1; y < runs[k][0]; y++) out[y * w + x] = 1;
      }
    }
    return out;
  }

  function phaseOf(profile, period) {
    let re = 0, im = 0;
    for (let x = 0; x < profile.length; x++) { const a = (-2 * Math.PI * x) / period; re += profile[x] * Math.cos(a); im += profile[x] * Math.sin(a); }
    return (((-Math.atan2(im, re) / (2 * Math.PI)) * period) % period + period) % period;
  }

  /** How well a grid fits: share of candle pixels near slot centres x share of slots holding candles. */
  function gridScore(weights, period, phase) {
    let total = 0, captured = 0, xmin = Infinity, xmax = -1;
    for (let x = 0; x < weights.length; x++) {
      if (!weights[x]) continue;
      total += weights[x]; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      const d = ((((x - phase + period / 2) % period) + period) % period) - period / 2;
      if (Math.abs(d) <= 0.3 * period) captured += weights[x];
    }
    if (!total) return 0;
    let slots = 0, filled = 0;
    for (let c = phase; c <= xmax; c += period) {
      if (c < xmin - period / 2) continue;
      slots++;
      for (let x = Math.max(0, Math.ceil(c - 0.3 * period)); x <= Math.min(weights.length - 1, Math.floor(c + 0.3 * period)); x++) {
        if (weights[x]) { filled++; break; }
      }
    }
    return (captured / total) * (slots ? filled / slots : 0);
  }

  /** Bar spacing and phase: try each strong Fourier peak as a grid and keep the best-fitting one. */
  function candleSpacing(mask, w, y0, y1, x1) {
    const weights = new Float64Array(x1);
    for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) weights[x] += mask[y * w + x];
    const mean = weights.reduce((a, b) => a + b, 0) / x1;
    const profile = Array.from(weights, (v) => v - mean);
    const periods = [], power = [];
    for (let p = 2; p < 80; p += 0.02) {
      let re = 0, im = 0;
      for (let x = 0; x < x1; x++) { const a = (-2 * Math.PI * x) / p; re += profile[x] * Math.cos(a); im += profile[x] * Math.sin(a); }
      periods.push(p); power.push(Math.hypot(re, im));
    }
    const maxP = Math.max(...power);
    let peaks = [];
    for (let k = 1; k < power.length - 1; k++) if (power[k] >= power[k - 1] && power[k] >= power[k + 1] && power[k] >= 0.3 * maxP) peaks.push(k);
    peaks = peaks.sort((a, b) => power[b] - power[a]).slice(0, 8);
    if (!peaks.length) peaks = [power.indexOf(maxP)];
    let best = null;
    for (const k of peaks) {
      const ph = phaseOf(profile, periods[k]), s = gridScore(weights, periods[k], ph);
      if (!best || s > best.s) best = { s, period: periods[k], phase: ph };
    }
    return [best.period, best.phase];
  }

  function slotRuns(both, w, y0, y1, x1, period, phase) {
    const half = Math.max(period * 0.45, 0.6), slots = [];
    for (let k = 0; k < Math.floor((x1 - phase) / period) + 2; k++) {
      const c = phase + k * period;
      let s = Math.ceil(c - half), e = Math.floor(c + half);
      if (e < 0 || s >= x1) continue;
      s = Math.max(s, 0); e = Math.min(e, x1 - 1);
      const runs = [];
      for (let x = s; x <= e; x++) for (const [a, b] of colRuns(both, w, x, y0, y1)) if (b > a) runs.push([a, b, x]); // 1-px runs are dotted lines
      if (runs.length) slots.push([k, runs]);
    }
    return slots;
  }

  function linFit(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    const slope = num / den;
    return [slope, my - slope * mx];
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function extractCandles(img, axis, words, reachUp = 1.1, reachDown = 1.1) {
    const { width: w, height: h } = img;
    let [green, red] = colourMasks(img);
    // Candles can sit a little beyond the outermost price labels; the caller widens this when candles
    // are found cut off at the edge (an unread top or bottom label).
    const y0 = Math.max(0, Math.floor(axis.yTop - axis.labelGap * reachUp)), y1 = Math.min(h, Math.ceil(axis.yBottom + axis.labelGap * reachDown));
    const x1 = Math.max(1, Math.floor(axis.xLeft - 14)); // coloured axis tags start a little left of the label text
    const keep = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = 0; x < x1; x++) keep[y * w + x] = 1;
    for (const t of words) { // legend text and labels inside the plot are not candles
      for (let y = Math.max(0, Math.floor(t.y - 3)); y < Math.min(h, Math.ceil(t.y + t.h + 3)); y++)
        for (let x = Math.max(0, Math.floor(t.x - 3)); x < Math.min(w, Math.ceil(t.x + t.w + 3)); x++) keep[y * w + x] = 0;
    }
    let count = 0;
    for (let i = 0; i < keep.length; i++) { green[i] &= keep[i]; red[i] &= keep[i]; count += green[i] | red[i]; }
    if (count < 50) return [];
    let both = green.map((g, i) => g | red[i]);
    let [period] = candleSpacing(both, w, y0, y1, x1);
    // Candle bodies are narrower than the bar spacing; longer horizontal runs are price tags,
    // buttons or flat moving-average lines. Remove them, then re-close tiny vertical gaps.
    const longH = removeLongHorizontal(both, w, y0, y1, x1, Math.floor(period * 1.5) + 3);
    for (let i = 0; i < both.length; i++) if (longH[i]) { green[i] = 0; red[i] = 0; }
    both = closeVertical(green.map((g, i) => g | red[i]), w, y0, y1, x1, 3);
    const greenClosed = closeVertical(green, w, y0, y1, x1, 3);
    for (let i = 0; i < both.length; i++) if (both[i] && !red[i] && greenClosed[i]) green[i] = 1;
    let phase;
    [period, phase] = candleSpacing(both, w, y0, y1, x1);
    let slots = slotRuns(both, w, y0, y1, x1, period, phase);
    // Fine-tune the grid from the wicks found: a small spacing error adds up across a wide chart.
    const found = slots.map(([k, runs]) => [k, runs.reduce((a, r) => (r[1] - r[0] > a[1] - a[0] ? r : a))[2]]);
    if (found.length >= 10) {
      let ks = found.map((f) => f[0]), wx = found.map((f) => f[1]);
      let [fp, fc] = linFit(ks, wx);
      const resid = wx.map((x, i) => Math.abs(x - (fc + fp * ks[i])));
      const lim = Math.max(median(resid) * 3, 1.5), idx = resid.map((r, i) => (r <= lim ? i : -1)).filter((i) => i >= 0);
      if (idx.length >= 10) [fp, fc] = linFit(idx.map((i) => ks[i]), idx.map((i) => wx[i]));
      if (fp >= 0.8 * period && fp <= 1.2 * period) {
        period = fp; phase = ((fc % fp) + fp) % fp;
        slots = slotRuns(both, w, y0, y1, x1, period, phase);
      }
    }
    if (!slots.length) return [];
    const half = Math.max(period * 0.45, 0.6);
    // Join the runs in a slot that touch vertically into shapes. A hollow candle's upper wick, outline
    // and lower wick are separate runs that meet end to end; joined, they are one candle.
    const bodyWidth = (sh) => {
      let best = 0;
      const xa = Math.max(0, sh.minX - Math.ceil(half)), xb = Math.min(x1 - 1, sh.maxX + Math.ceil(half));
      for (let y = sh.top; y <= sh.bottom; y++) {
        let run = 0;
        for (let x = xa; x <= xb; x++) { run = both[y * w + x] ? run + 1 : 0; if (run > best) best = run; }
      }
      return best;
    };
    const shapesOf = (runs) => {
      let shapes = [...runs].sort((a, b) => a[0] - b[0]).map((r) => ({ top: r[0], bottom: r[1], minX: r[2], maxX: r[2] }));
      for (let merged = true; merged;) {
        merged = false;
        const out = [];
        for (const s of shapes) {
          const t = out.find((o) => s.top <= o.bottom + 2 && s.bottom >= o.top - 2);
          if (t) { t.top = Math.min(t.top, s.top); t.bottom = Math.max(t.bottom, s.bottom); t.minX = Math.min(t.minX, s.minX); t.maxX = Math.max(t.maxX, s.maxX); merged = true; }
          else out.push({ ...s });
        }
        shapes = out;
      }
      // A candle has a body: some row is several pixels wide. A moving-average line crossing the slot is
      // only 1-2 pixels wide in every row, however long it is.
      return shapes.map((s) => ({ ...s, body: bodyWidth(s) >= 3, mid: (s.top + s.bottom) / 2, len: s.bottom - s.top }));
    };
    const better = (a, b) => (a.body !== b.body ? (a.body ? a : b) : a.len >= b.len ? a : b);
    const slotShapes = slots.map(([, runs]) => shapesOf(runs));
    // Pass 1: in each slot the most candle-like shape (has a body, then tallest) marks where prices trade.
    const first = slotShapes.map((sh) => sh.reduce(better));
    const mids = first.map((s) => s.mid);
    const typical = Math.max(median(first.map((s) => s.len)), 4);
    const candles = [];
    slotShapes.forEach((shapes, k) => {
      // Pass 2: other coloured things in the same columns sit away from where the neighbours trade.
      const nb = [...mids.slice(Math.max(0, k - 4), k), ...mids.slice(k + 1, k + 5)];
      const expected = nb.length ? median(nb) : mids[k];
      const far = (s) => Math.abs(s.mid - expected) > 6 * typical;
      const pick = shapes.reduce((a, s) => (far(a) !== far(s) ? (far(a) ? s : a) : better(a, s)));
      if (Math.abs(pick.mid - expected) > 8 * typical) return;
      const top = pick.top, bottom = pick.bottom;
      const wickX = Math.round((pick.minX + pick.maxX) / 2);
      const s = Math.max(0, Math.round(wickX - half)), e = Math.min(x1 - 1, Math.round(wickX + half));
      const rowWidth = [];
      let gCount = 0, rCount = 0;
      for (let y = top; y <= bottom; y++) {
        let n = 0;
        for (let x = s; x <= e; x++) { const i = y * w + x; n += both[i]; gCount += green[i]; rCount += red[i]; }
        rowWidth.push(n);
      }
      const width = Math.max(...rowWidth), bull = gCount >= rCount;
      let bTop = top, bBot = bottom;
      if (width >= 3) { // thin candles (zoomed far out): the body can't be told from the wick
        const body = rowWidth.map((v, i) => (v >= Math.max(2, width * 0.6) ? i : -1)).filter((i) => i >= 0);
        bTop = top + body[0]; bBot = top + body[body.length - 1];
      }
      const [o, c] = bull ? [axis.price(bBot), axis.price(bTop)] : [axis.price(bTop), axis.price(bBot)];
      candles.push({ x: wickX, o, h: axis.price(top), l: axis.price(bottom), c, bull, bw: width, wick: top < bTop - 1 || bottom > bBot + 1, sp: period, cutTop: top <= y0 + 1 && y0 > 0, cutBottom: bottom >= y1 - 2 && y1 < h });
    });
    return dropIsolated(candles, period);
  }

  /** Keep the main unbroken row of candles; small clusters cut off by empty space are tags or buttons. */
  function dropIsolated(candles, period) {
    if (!candles.length) return candles;
    const clusters = [[candles[0]]];
    for (const c of candles.slice(1)) {
      if (c.x - clusters[clusters.length - 1].slice(-1)[0].x > 4 * period) clusters.push([]);
      clusters[clusters.length - 1].push(c);
    }
    const main = clusters.reduce((a, b) => (b.length > a.length ? b : a));
    return clusters.filter((cl) => cl === main || cl.length >= Math.max(15, main.length >> 2)).flat();
  }

  // ---------- symbol ----------
  function findSymbol(words, known) {
    const ordered = [...words].sort((a, b) => Math.round(a.y / 20) - Math.round(b.y / 20) || a.x - b.x);
    const tokens = ordered.flatMap((w) => w.text.toUpperCase().split(/[^A-Z0-9&-]+/)).map((t) => t.replace(/^[-&]+|[-&]+$/g, "")).filter(Boolean);
    const joined = tokens.join(" ");
    if (/BANK ?NIFTY|NIFTY ?BANK/.test(joined)) return "BANKNIFTY";
    for (const tok of tokens) {
      for (const cand of [tok, tok.replace(/\d*!?$/, ""), tok.replace(/(FUT|\d{2}[A-Z]{3}FUT)$/, "")]) if (known.has(cand)) return cand;
    }
    return /NIFTY/.test(joined) ? "NIFTY" : "";
  }

  // ---------- public ----------
  async function toCanvas(file) {
    let src;
    try { src = await createImageBitmap(file); }
    catch {
      src = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new ReadError("image_rejected"));
        im.src = URL.createObjectURL(file);
      });
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
    const c = document.createElement("canvas");
    c.width = Math.round(src.width * scale); c.height = Math.round(src.height * scale);
    c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function crop(canvas, x, w) {
    const c = document.createElement("canvas");
    c.width = w; c.height = canvas.height;
    c.getContext("2d").drawImage(canvas, x, 0, w, canvas.height, 0, 0, w, canvas.height);
    return c;
  }

  /** Close-up read of the price-scale column, where small decimal points come through. */
  async function readAxisColumn(canvas, roughWords, onProgress) {
    const { width } = canvas;
    // Locate the label column from a rough read: the right-side column with the most numbers.
    let x0 = Math.floor(width * 0.6);
    let probe = roughWords.filter((w) => w.x > x0 && parseNumber(w.text).length);
    if (probe.length < MIN_AXIS_LABELS) probe = (await ocrWords(crop(canvas, x0, width - x0), 1, x0, onProgress)).filter((w) => parseNumber(w.text).length);
    let left = Math.floor(width * 0.82), right = width;
    let bestCount = 0;
    for (const a of probe) {
      const col = probe.filter((w) => w.x <= a.x + a.w + 6 && w.x + w.w >= a.x - 6);
      if (col.length > bestCount) {
        bestCount = col.length;
        left = Math.max(0, Math.floor(Math.min(...col.map((w) => w.x)) - 14));
        right = Math.min(width, Math.ceil(Math.max(...col.map((w) => w.x + w.w)) + 14));
      }
    }
    const words = await ocrWords(crop(canvas, left, right - left), 3, left, onProgress);
    return words.length >= MIN_AXIS_LABELS ? words : [...words, ...(await ocrWords(crop(canvas, x0, width - x0), OCR_SCALE, x0, onProgress))];
  }

  /** Checks that what was read looks like a real candlestick chart, so an unclear image can't produce a decision. */
  function assessQuality(candles, axis) {
    const n = candles.length, period = candles[0].sp;
    const medRange = median(candles.map((c) => c.h - c.l)) || 1e-9;
    let jumps = 0;
    for (let i = 1; i < n; i++) if (Math.abs(candles[i].o - candles[i - 1].c) > 1.5 * medRange) jumps++;
    const q = {
      bodyPct: candles.filter((c) => c.bw >= 3).length / n,
      wickPct: candles.filter((c) => c.wick).length / n,
      greenPct: candles.filter((c) => c.bull).length / n,
      jumpPct: jumps / (n - 1),
      axisErrPx: axis.errPx,
      spacing: period,
    };
    const issues = [], warnings = [];
    if (period < 5) warnings.push("crowded");
    if (q.axisErrPx > 3) issues.push("axis");
    if (period >= 5 && q.bodyPct < 0.6) issues.push("no_bodies");
    if (q.wickPct < 0.3) issues.push("no_wicks");
    if (q.greenPct < 0.15 || q.greenPct > 0.85) issues.push("one_colour");
    if (q.jumpPct > 0.25) issues.push("jumpy");
    return { ...q, issues, warnings, ok: issues.length === 0 };
  }

  async function read(file, knownSymbols, onProgress) {
    if (!file || !/^image\//.test(file.type || "image/")) throw new ReadError("image_rejected");
    const canvas = await toCanvas(file).catch((e) => { throw e instanceof ReadError ? e : new ReadError("image_rejected"); });
    const { width, height } = canvas;
    onProgress && onProgress({ status: "reading chart text" });
    const allWords = await ocrWords(canvas, 1, 0, onProgress, true);
    onProgress && onProgress({ status: "reading price scale" });
    const axisWords = await readAxisColumn(canvas, allWords, onProgress);
    let axis;
    try { axis = findAxis(axisWords, width); } catch { axis = findAxis([...allWords, ...axisWords], width); }
    onProgress && onProgress({ status: "finding candles" });
    const img = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
    // Mask confident, text-like words only: the engine also "reads" short junk off candles, and masking
    // that would delete real candles.
    // Real chart labels are numbers (prices, dates) or capitalised names (symbol, exchange); junk read off
    // candles is short lowercase ("nll", "fin") or thin strokes ("IIl1").
    const isLabel = (t) => {
      const core = t.replace(/[^A-Za-z0-9&]/g, "");
      if (core.length < 3 || /^[Il1|!i]+$/.test(core)) return false;
      return (core.match(/\d/g) || []).length >= 2 || /^[A-Z0-9&]+$/.test(core);
    };
    const textLike = allWords.filter((wd) => wd.conf >= 60 && isLabel(wd.text));
    // Start just beyond the outermost labels and look further only where real candles are cut off at the
    // edge, so text above the chart (like the coloured O/H/L/C line) is not mistaken for candles.
    const masks = [...textLike, ...axisWords];
    let up = 1.1, down = 1.1, candles = extractCandles(img, axis, masks, up, down);
    for (let step = 0; step < 4; step++) {
      const moreUp = candles.filter((c) => c.cutTop).length >= 2, moreDown = candles.filter((c) => c.cutBottom).length >= 2;
      if (!moreUp && !moreDown) break;
      if (moreUp) up += 1;
      if (moreDown) down += 1;
      candles = extractCandles(img, axis, masks, up, down);
    }
    if (candles.length < 30) throw new ReadError("too_few_candles", `found ${candles.length} candles`);
    const round = (v) => Math.round(v * 100) / 100;
    return {
      quality: assessQuality(candles, axis),
      symbol: findSymbol(allWords, new Set(knownSymbols || [])),
      candles: candles.map((c) => ({ x: c.x, o: round(c.o), h: round(c.h), l: round(c.l), c: round(c.c), bull: c.bull })),
      size: [width, height],
    };
  }

  window.ChartReader = {
    read,
    warmUp: (onProgress) => getWorker(onProgress).then(() => true),
    configure: (opts) => { base = opts.base || ""; },
    ReadError,
  };
})();
