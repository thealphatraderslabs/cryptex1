// ATL · Derivatives Confluence Scanner (Phase 5)
// 3-gate sequential funnel:
//   Gate 1 — SMC Pre-screen  (HTF structure + P/D + OB proximity)
//   Gate 2 — Funding Gate    (rate threshold + direction alignment)
//   Gate 3 — Deriv Gate      (calcDerivScore ≥ 60 long / ≤ 40 short)
//
// Architecture:
//   • fetchFundingInfo() called ONCE at scan start — cached for loop
//   • fetchInsuranceFund() called ONCE — market-wide signal
//   • Gate 1 uses only ticker + HTF klines (2 API calls per coin)
//   • Coins passing Gate 1 get basis + bookTicker (2 more calls)
//   • calcDerivScore() from signals.js used for Gate 3
//   • BATCH_SIZE / BATCH_DELAY tuned for 300+ coins

import {
  calcATR, calcEMAStack,
  detectSwings, detectStructure, detectOrderBlocks,
  calcPremiumDiscount,
  calcInsuranceTrend, calcDerivedMoneyFlow, calcBasisSlope,
} from './indicators.js';

import { calcDerivScore } from './signals.js';

// ── Constants ──────────────────────────────────────────────────
const BYBIT_BASE  = 'https://api.bybit.com/v5/market';
const FAPI_BASE   = 'https://fapi.binance.com/fapi/v1';

const BATCH_SIZE_G1  = 15;  // Gate 1: ticker + HTF klines — moderate
const BATCH_SIZE_G3  = 8;   // Gate 3: basis + bookTicker — heavier
const BATCH_DELAY_G1 = 150; // ms between G1 batches
const BATCH_DELAY_G3 = 200; // ms between G3 batches

// Gate thresholds
const FUNDING_THRESHOLD     = 0.0005;   // ±0.05% raw — must have meaningful imbalance
const DERIV_SCORE_LONG_MIN  = 58;       // derivScore ≥ 58 for long
const DERIV_SCORE_SHORT_MAX = 42;       // derivScore ≤ 42 for short

const TF_MAP = {
  '15m': { bybit: '15',  fapi: '15m', htfBybit: '60',  htfFapi: '1h'  },
  '1h':  { bybit: '60',  fapi: '1h',  htfBybit: '240', htfFapi: '4h'  },
  '4h':  { bybit: '240', fapi: '4h',  htfBybit: 'D',   htfFapi: '1d'  },
  '1d':  { bybit: 'D',   fapi: '1d',  htfBybit: 'W',   htfFapi: '1w'  },
};

// ── State ──────────────────────────────────────────────────────
let scanAborted = false;
let scanRunning = false;

// ── Utils ──────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ═══════════════════════════════════════════════════════════════
//  PAIR FETCHING
// ═══════════════════════════════════════════════════════════════
async function fetchBybitPairs() {
  const d = await fetchJSON(`${BYBIT_BASE}/instruments-info?category=linear&limit=1000`);
  if (d.retCode !== 0) throw new Error(d.retMsg);
  return d.result.list
    .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT' && s.contractType === 'LinearPerpetual')
    .map(s => s.symbol.replace('USDT', ''));
}

async function fetchBinancePairs() {
  const d = await fetchJSON(`${FAPI_BASE}/exchangeInfo`);
  return d.symbols
    .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
    .map(s => s.baseAsset);
}

// ═══════════════════════════════════════════════════════════════
//  LEAN DATA FETCHERS (per-coin, minimal calls)
// ═══════════════════════════════════════════════════════════════

// Ticker: price, funding, OI, 24h change — ONE call
async function fetchTickerLean(symbol, exchange) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    if (exchange === 'bybit') {
      const d = await fetchJSON(`${BYBIT_BASE}/tickers?category=linear&symbol=${sym}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      const t = d.result.list[0];
      return {
        price:        parseFloat(t.lastPrice),
        fundingRate:  parseFloat(t.fundingRate) * 100,
        openInterest: parseFloat(t.openInterest),
        price24h:     parseFloat(t.price24hPcnt) * 100,
        markPrice:    parseFloat(t.markPrice),
        indexPrice:   parseFloat(t.indexPrice),
        turnover24h:  parseFloat(t.turnover24h),
      };
    } else {
      const [prem, stat] = await Promise.all([
        fetchJSON(`${FAPI_BASE}/premiumIndex?symbol=${sym}`),
        fetchJSON(`${FAPI_BASE}/ticker/24hr?symbol=${sym}`),
      ]);
      return {
        price:        parseFloat(prem.markPrice),
        fundingRate:  parseFloat(prem.lastFundingRate) * 100,
        openInterest: null,
        price24h:     parseFloat(stat.priceChangePercent),
        markPrice:    parseFloat(prem.markPrice),
        indexPrice:   parseFloat(prem.indexPrice),
        turnover24h:  parseFloat(stat.quoteVolume),
      };
    }
  } catch { return null; }
}

// HTF klines — for SMC pre-screen
async function fetchHTFKlines(symbol, exchange, tfKey, limit = 120) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    if (exchange === 'bybit') {
      const d = await fetchJSON(`${BYBIT_BASE}/kline?symbol=${sym}&interval=${tf.htfBybit}&limit=${limit}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      return d.result.list.reverse().map(c => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low:  parseFloat(c[3]), close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } else {
      const d = await fetchJSON(`${FAPI_BASE}/klines?symbol=${sym}&interval=${tf.htfFapi}&limit=${limit}`);
      return d.map(c => ({
        time: Math.floor(c[0] / 1000),
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low:  parseFloat(c[3]), close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
  } catch { return []; }
}

// MTF klines — only for coins passing Gate 1
async function fetchMTFKlines(symbol, exchange, tfKey, limit = 200) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    if (exchange === 'bybit') {
      const d = await fetchJSON(`${BYBIT_BASE}/kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      return d.result.list.reverse().map(c => ({
        time: Math.floor(Number(c[0]) / 1000),
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low:  parseFloat(c[3]), close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } else {
      const d = await fetchJSON(`${FAPI_BASE}/klines?symbol=${sym}&interval=${tf.fapi}&limit=${limit}`);
      return d.map(c => ({
        time: Math.floor(c[0] / 1000),
        open: parseFloat(c[1]), high: parseFloat(c[2]),
        low:  parseFloat(c[3]), close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    }
  } catch { return []; }
}

// OI history — for money flow derivation (Gate 3)
async function fetchOILean(symbol, limit = 24) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(`${BYBIT_BASE}/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=${limit}`);
    if (d.retCode !== 0) return [];
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.timestamp) / 1000),
      oi:   parseFloat(r.openInterest),
    }));
  } catch { return []; }
}

// Basis history — mark vs index klines
async function fetchBasisLean(symbol, tfKey, limit = 48) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const [markRes, indexRes] = await Promise.all([
      fetchJSON(`${BYBIT_BASE}/mark-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
      fetchJSON(`${BYBIT_BASE}/index-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
    ]);
    if (markRes.retCode !== 0 || indexRes.retCode !== 0) return null;
    const markList  = (markRes.result?.list || []).reverse();
    const indexMap  = new Map((indexRes.result?.list || []).reverse().map(r => [r[0], parseFloat(r[4])]));
    const history   = markList.map(r => {
      const markClose  = parseFloat(r[4]);
      const indexClose = indexMap.get(r[0]);
      if (!indexClose) return null;
      return { time: Math.floor(Number(r[0]) / 1000), basis: ((markClose - indexClose) / indexClose) * 100, mark: markClose, index: indexClose };
    }).filter(Boolean);
    if (!history.length) return null;
    const vals    = history.map(b => b.basis);
    const last    = vals[vals.length - 1];
    const n       = Math.min(12, vals.length);
    const window  = vals.slice(-n);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) { sumX += i; sumY += window[i]; sumXY += i * window[i]; sumXX += i * i; }
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;
    const FLAT  = 0.0003;
    const direction = slope > FLAT ? 'expanding' : slope < -FLAT ? 'contracting' : 'flat';
    return { history, lastBasis: last, slope, direction };
  } catch { return null; }
}

// Book ticker — spread
async function fetchSpreadLean(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d    = await fetchJSON(`${FAPI_BASE}/ticker/bookTicker?symbol=${sym}`);
    const bid  = parseFloat(d.bidPrice);
    const ask  = parseFloat(d.askPrice);
    const mid  = (bid + ask) / 2;
    return { bestBid: bid, bestAsk: ask, spread: mid > 0 ? ((ask - bid) / mid) * 100 : 0 };
  } catch { return null; }
}

// Funding info (interval hours) — ONE call, cached
async function fetchFundingInfoCache() {
  try {
    const d   = await fetchJSON(`${FAPI_BASE}/fundingInfo`);
    const map = new Map();
    for (const item of (d || [])) {
      const base = item.symbol?.replace('USDT', '').toUpperCase() || '';
      map.set(base, parseFloat(item.fundingIntervalHours) || 8);
      map.set(item.symbol, parseFloat(item.fundingIntervalHours) || 8);
    }
    return map;
  } catch { return new Map(); }
}

// Insurance fund — ONE call, market-wide
async function fetchInsuranceLean() {
  try {
    const d = await fetchJSON(`${BYBIT_BASE}/insurance?coin=BTC`);
    if (d.retCode !== 0) return null;
    const raw     = (d.result?.list || []).slice(0, 50).reverse();
    const history = raw.map(r => ({
      time:  Math.floor(Number(r.updatedTime) / 1000),
      value: parseFloat(r.symbols?.[0]?.insuranceFund || r.insuranceFund || 0),
    }));
    if (!history.length) return null;
    const first = history[0].value;
    const last  = history[history.length - 1].value;
    const delta = last - first;
    const deltaPct = first > 0 ? (delta / first) * 100 : 0;
    let stressed = false, stressIdx = -1;
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1].value > 0 && (history[i - 1].value - history[i].value) / history[i - 1].value > 0.02) {
        stressed = true; stressIdx = i; break;
      }
    }
    return { coin: 'BTC', history, current: last, delta, deltaPct, trend: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat', stressed, stressIdx };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
//  GATE 1 — SMC PRE-SCREEN
//  Uses HTF klines only. Checks:
//    a) HTF trend is clear (bull or bear — not neutral)
//    b) Price is in correct P/D zone for the trend
//    c) At least one fresh OB exists in the right direction
//  Returns { pass, dir, reason, smcScore, pdZone, nearestOB }
// ═══════════════════════════════════════════════════════════════
function runGate1(htfCandles, ticker) {
  if (!htfCandles || htfCandles.length < 60 || !ticker) {
    return { pass: false, dir: 'neutral', reason: 'Insufficient HTF data', smcScore: 0 };
  }

  const price  = ticker.price;
  const atrs   = calcATR(htfCandles, 14);
  const { pivotHighs, pivotLows } = detectSwings(htfCandles, 5, 20);
  const structure = detectStructure(
    htfCandles,
    pivotHighs.map(p => ({ ...p })),
    pivotLows.map(p => ({ ...p }))
  );
  const orderBlocks = detectOrderBlocks(htfCandles, atrs, structure.events || [], 8);
  const premDisc    = calcPremiumDiscount(htfCandles, 100);

  const dir = structure?.trend || 'neutral';

  // a) Must have clear trend
  if (dir === 'neutral') {
    return { pass: false, dir, reason: 'HTF structure neutral — no directional bias', smcScore: 0 };
  }

  let smcScore = 1; // 1 for having clear trend
  let reasons  = [`HTF ${dir.toUpperCase()}`];

  // b) P/D zone check
  let pdPass = false;
  let pdZone = premDisc?.zone || 'unknown';
  if (premDisc) {
    const pos = premDisc.position;
    if (dir === 'bull' && pos < 0.45) { pdPass = true; reasons.push(`Discount ${(pos * 100).toFixed(0)}%`); }
    else if (dir === 'bear' && pos > 0.55) { pdPass = true; reasons.push(`Premium ${(pos * 100).toFixed(0)}%`); }
    else reasons.push(`Zone mismatch (${(pos * 100).toFixed(0)}%)`);
  }
  if (pdPass) smcScore++;

  // c) Fresh OB proximity check (within 6% of price)
  const freshOBs   = orderBlocks.filter(ob => ob.state === 'fresh');
  let obPass       = false;
  let nearestOB    = null;
  for (const ob of freshOBs) {
    const obMid  = (ob.high + ob.low) / 2;
    const dist   = Math.abs(price - obMid) / price;
    const dirOK  = (dir === 'bull' && ob.type === 'demand') || (dir === 'bear' && ob.type === 'supply');
    if (dist < 0.06 && dirOK) {
      obPass = true; nearestOB = ob;
      reasons.push(`Fresh ${ob.type} OB ${(dist * 100).toFixed(1)}% away`);
      smcScore++;
      break;
    }
  }
  if (!obPass) reasons.push('No fresh OB nearby');

  // Gate passes if: clear trend + at least one of (P/D zone OR OB proximity)
  const pass = dir !== 'neutral' && (pdPass || obPass);

  return {
    pass,
    dir,
    reason:    reasons.join(' · '),
    smcScore,
    pdZone,
    nearestOB,
    structure,
  };
}

// ═══════════════════════════════════════════════════════════════
//  GATE 2 — FUNDING GATE
//  Funding must:
//    a) Have a meaningful imbalance (|rate| ≥ threshold)
//    b) Direction must be CONTRARIAN to the trade direction
//       (negative funding for longs — shorts over-leveraged)
//       (positive funding for shorts — longs over-leveraged)
//  Returns { pass, rate, normRate, intervalHrs, reason, direction }
// ═══════════════════════════════════════════════════════════════
function runGate2(ticker, smcDir, fundingInfoMap, symbol) {
  if (!ticker) return { pass: false, rate: 0, reason: 'No ticker data' };

  const rawRate     = ticker.fundingRate / 100; // convert back to raw decimal
  const intervalHrs = fundingInfoMap.get(symbol) || fundingInfoMap.get(symbol.toUpperCase() + 'USDT') || 8;
  const normRate    = rawRate * (8 / intervalHrs);

  // Direction check — contrarian funding is what we WANT
  // For a LONG setup: negative funding = shorts paying longs = bullish pressure
  // For a SHORT setup: positive funding = longs paying shorts = bearish pressure
  let pass = false, reason = '', fundDir = 'neutral';

  const absFR = Math.abs(rawRate);

  if (smcDir === 'bull') {
    if (rawRate <= -FUNDING_THRESHOLD) {
      pass    = true;
      fundDir = 'negative';
      reason  = `Negative funding ${(rawRate * 100).toFixed(4)}% — shorts over-leveraged, squeeze risk supports longs`;
      if (intervalHrs !== 8) reason += ` (${(normRate * 100).toFixed(4)}% per 8h, ${intervalHrs}h interval)`;
    } else if (rawRate >= FUNDING_THRESHOLD * 4) {
      // Very high positive = danger for longs
      pass   = false;
      reason = `Funding too high (${(rawRate * 100).toFixed(4)}%) — over-leveraged longs, squeeze risk`;
    } else {
      // Neutral — mild pass (not ideal but not blocking)
      pass    = true;
      fundDir = 'neutral';
      reason  = `Funding neutral (${(rawRate * 100).toFixed(4)}%) — no strong derivative pressure`;
    }
  } else if (smcDir === 'bear') {
    if (rawRate >= FUNDING_THRESHOLD) {
      pass    = true;
      fundDir = 'positive';
      reason  = `Positive funding ${(rawRate * 100).toFixed(4)}% — longs over-leveraged, squeeze risk supports shorts`;
      if (intervalHrs !== 8) reason += ` (${(normRate * 100).toFixed(4)}% per 8h, ${intervalHrs}h interval)`;
    } else if (rawRate <= -FUNDING_THRESHOLD * 4) {
      pass   = false;
      reason = `Funding very negative (${(rawRate * 100).toFixed(4)}%) — over-leveraged shorts, squeeze risk`;
    } else {
      pass    = true;
      fundDir = 'neutral';
      reason  = `Funding neutral (${(rawRate * 100).toFixed(4)}%) — no strong derivative pressure`;
    }
  }

  return {
    pass,
    rate:        rawRate * 100, // back to % for display
    normRate:    normRate * 100,
    intervalHrs,
    fundDir,
    reason,
  };
}

// ═══════════════════════════════════════════════════════════════
//  GATE 3 — DERIVATIVES INTELLIGENCE GATE
//  Uses calcDerivScore() from Phase 4 signals.js
//  Requires: basis history, book ticker, OI, taker flow proxy
//  Returns { pass, derivScore, derivLabel, derivColor, components }
// ═══════════════════════════════════════════════════════════════
function runGate3(smcDir, derivScoreResult) {
  const { derivScore, derivLabel, derivColor, components } = derivScoreResult;
  let pass = false, reason = '';

  if (smcDir === 'bull') {
    pass   = derivScore >= DERIV_SCORE_LONG_MIN;
    reason = pass
      ? `Deriv score ${derivScore}/100 — derivatives confirm bullish confluence`
      : `Deriv score ${derivScore}/100 — insufficient derivative confirmation for long`;
  } else if (smcDir === 'bear') {
    pass   = derivScore <= DERIV_SCORE_SHORT_MAX;
    reason = pass
      ? `Deriv score ${derivScore}/100 — derivatives confirm bearish confluence`
      : `Deriv score ${derivScore}/100 — insufficient derivative confirmation for short`;
  } else {
    reason = 'Direction not established';
  }

  return { pass, derivScore, derivLabel, derivColor, components, reason };
}

// ═══════════════════════════════════════════════════════════════
//  MASTER SCAN
// ═══════════════════════════════════════════════════════════════
export async function runDerivScan({ exchange, tf, onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;

  try {
    // ── Step 0: Global one-time fetches ─────────────────────
    onProgress({ phase: 'init', msg: 'Fetching pairs, funding intervals + insurance fund…' });

    const [pairs, fundingInfoMap, insuranceFund] = await Promise.all([
      exchange === 'bybit' ? fetchBybitPairs() : fetchBinancePairs(),
      fetchFundingInfoCache(),
      fetchInsuranceLean(),
    ]);

    // Pre-compute insurance trend — shared across all coins
    const insuranceTrend = calcInsuranceTrend(insuranceFund);

    const total = pairs.length;
    onProgress({ phase: 'start', done: 0, total, msg: `${total} pairs — running 3-gate funnel…` });

    // ── Step 1: Gate 1 — SMC pre-screen (batch all pairs) ───
    // Fetches: ticker + HTF klines per coin
    const gate1Results = new Map(); // symbol → { pass, dir, g1data… }
    let done = 0;

    for (let i = 0; i < pairs.length; i += BATCH_SIZE_G1) {
      if (scanAborted) break;
      const batch = pairs.slice(i, i + BATCH_SIZE_G1);

      const batchResults = await Promise.all(batch.map(async sym => {
        try {
          const [htfCandles, ticker] = await Promise.all([
            fetchHTFKlines(sym, exchange, tf, 120),
            fetchTickerLean(sym, exchange),
          ]);
          const g1 = runGate1(htfCandles, ticker);
          return { sym, g1, ticker, htfCandles };
        } catch { return { sym, g1: { pass: false, reason: 'Fetch error' }, ticker: null, htfCandles: [] }; }
      }));

      for (const r of batchResults) {
        done++;
        gate1Results.set(r.sym, r);
      }

      onProgress({
        phase: 'gate1',
        done, total,
        msg: `Gate 1 (SMC) · ${done}/${total} · ${[...gate1Results.values()].filter(r => r.g1.pass).length} passed`,
      });

      if (i + BATCH_SIZE_G1 < pairs.length) await sleep(BATCH_DELAY_G1);
    }

    if (scanAborted) {
      onDone({ results: [], total, aborted: true });
      return;
    }

    // ── Step 2: Gate 2 — Funding gate (on Gate 1 survivors) ─
    // No extra API calls — ticker data already fetched in Gate 1
    const gate2Results = new Map();
    for (const [sym, r] of gate1Results) {
      if (!r.g1.pass || !r.ticker) continue;
      const g2 = runGate2(r.ticker, r.g1.dir, fundingInfoMap, sym);
      if (g2.pass) gate2Results.set(sym, { ...r, g2 });
    }

    const g2Count = gate2Results.size;
    onProgress({
      phase: 'gate2',
      done: total, total,
      msg:  `Gate 2 (Funding) · ${g2Count} passed from ${[...gate1Results.values()].filter(r => r.g1.pass).length} SMC qualifiers`,
    });

    if (scanAborted || !g2Count) {
      onDone({ results: [], total, aborted: scanAborted });
      return;
    }

    // ── Step 3: Gate 3 — Deriv score (on Gate 2 survivors) ──
    // Extra calls per coin: MTF klines + OI + basis + bookTicker
    const finalResults = [];
    const g2Symbols    = [...gate2Results.keys()];
    let   g3Done       = 0;

    for (let i = 0; i < g2Symbols.length; i += BATCH_SIZE_G3) {
      if (scanAborted) break;
      const batch = g2Symbols.slice(i, i + BATCH_SIZE_G3);

      const batchResults = await Promise.all(batch.map(async sym => {
        const existing = gate2Results.get(sym);
        try {
          const [mtfCandles, oiHistory, basisHistory, bookTicker] = await Promise.all([
            fetchMTFKlines(sym, exchange, tf, 200),
            fetchOILean(sym, 24),
            fetchBasisLean(sym, tf, 48),
            fetchSpreadLean(sym),
          ]);

          // Build a minimal data object matching what calcDerivScore expects
          const basisAna  = calcBasisSlope(basisHistory);
          const moneyFlow = calcDerivedMoneyFlow(existing.ticker, oiHistory, null);

          // Taker flow proxy from recent candle delta (no aggTrades per-scan — too heavy)
          const takerProxy = mtfCandles.length >= 2
            ? {
                takerBias:  ((mtfCandles[mtfCandles.length - 1].close - mtfCandles[mtfCandles.length - 2].close)
                             / mtfCandles[mtfCandles.length - 2].close) * 200,
                buyRatio:   0.5, sellRatio: 0.5,
              }
            : null;

          const miniData = {
            ticker:       existing.ticker,
            oiHistory,
            takerFlow:    takerProxy,
            fundingInfo:  fundingInfoMap,
            insuranceFund,
            basisHistory,
            bookTicker,
            marketCap:    null,
          };
          const miniAnalysis = {
            basisAnalysis:  basisAna,
            insuranceTrend,
            moneyFlow,
            candles:        mtfCandles,
          };

          const dsResult = calcDerivScore(miniData, miniAnalysis);
          const g3 = runGate3(existing.g1.dir, dsResult);

          return { sym, existing, g3, dsResult, mtfCandles, oiHistory, basisHistory, bookTicker };
        } catch (e) {
          return { sym, existing, g3: { pass: false, derivScore: 0, reason: `Error: ${e.message}` }, dsResult: null };
        }
      }));

      for (const r of batchResults) {
        g3Done++;
        if (r.g3.pass) {
          const { sym, existing, g3, dsResult, oiHistory, basisHistory, bookTicker } = r;
          const result = buildResult(sym, existing, g3, dsResult, oiHistory, basisHistory, bookTicker, insuranceTrend);
          finalResults.push(result);
          onResult(result);
        }
        onProgress({
          phase: 'gate3',
          done:  g3Done,
          total: g2Symbols.length,
          msg:   `Gate 3 (Deriv) · ${g3Done}/${g2Symbols.length} · ${finalResults.length} final`,
        });
      }

      if (i + BATCH_SIZE_G3 < g2Symbols.length) await sleep(BATCH_DELAY_G3);
    }

    // Sort: by derivScore (desc for longs, asc for shorts — strongest signal first)
    finalResults.sort((a, b) => {
      // Both longs: higher derivScore first
      if (a.dir === 'bull' && b.dir === 'bull') return b.derivScore - a.derivScore;
      // Both shorts: lower derivScore first (more bearish)
      if (a.dir === 'bear' && b.dir === 'bear') return a.derivScore - b.derivScore;
      // Longs before shorts
      return a.dir === 'bull' ? -1 : 1;
    });

    onDone({ results: finalResults, total, aborted: scanAborted });

  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  BUILD RESULT OBJECT
//  Consolidates all gate data into the final card payload
// ═══════════════════════════════════════════════════════════════
function buildResult(sym, existing, g3, dsResult, oiHistory, basisHistory, bookTicker, insuranceTrend) {
  const { g1, g2, ticker } = existing;
  const dir      = g1.dir;
  const isLong   = dir === 'bull';

  // Funding display
  const fundingStr = g2.intervalHrs !== 8
    ? `${g2.rate.toFixed(4)}% (${g2.normRate.toFixed(4)}% /8h · ${g2.intervalHrs}h)`
    : `${g2.rate.toFixed(4)}%`;

  // OI trend
  const oiLen = oiHistory?.length || 0;
  const oiTrend = oiLen >= 2
    ? (oiHistory[oiLen - 1].oi > oiHistory[0].oi ? 'rising' : 'falling')
    : 'unknown';

  // Basis summary
  const basisDir = basisHistory?.direction || 'unknown';

  // Composite conviction score (0–100)
  // Weights: SMC 40%, Deriv 40%, Funding alignment 20%
  const smcNorm     = Math.min(g1.smcScore / 3, 1) * 100;
  const derivNorm   = isLong ? g3.derivScore : (100 - g3.derivScore);
  const fundingNorm = g2.fundDir !== 'neutral' ? 100 : 60;
  const conviction  = Math.round(smcNorm * 0.4 + derivNorm * 0.4 + fundingNorm * 0.2);

  let convLabel, convColor;
  if      (conviction >= 80) { convLabel = 'PRIME';    convColor = '#00e676'; }
  else if (conviction >= 65) { convLabel = 'HIGH';     convColor = '#69f0ae'; }
  else if (conviction >= 50) { convLabel = 'MODERATE'; convColor = '#ffd54f'; }
  else                       { convLabel = 'WEAK';     convColor = '#ff9090'; }

  return {
    symbol:        sym,
    dir,
    isLong,
    biasLabel:     isLong ? '⬆ LONG' : '⬇ SHORT',
    biasColor:     isLong ? '#00e676' : '#ff4444',
    price:         ticker.price,
    fundingRate:   g2.rate,
    fundingStr,
    fundingDir:    g2.fundDir,
    oiTrend,
    basisDir,
    derivScore:    g3.derivScore,
    derivLabel:    g3.derivLabel,
    derivColor:    g3.derivColor,
    components:    dsResult?.components || {},
    conviction,
    convLabel,
    convColor,
    spread:        bookTicker?.spread || null,
    insuranceTrend,
    // Gate data for detailed card
    g1: { pass: g1.pass, smcScore: g1.smcScore, dir: g1.dir, reason: g1.reason, pdZone: g1.pdZone },
    g2: { pass: g2.pass, rate: g2.rate, normRate: g2.normRate, intervalHrs: g2.intervalHrs, reason: g2.reason },
    g3: { pass: g3.pass, derivScore: g3.derivScore, reason: g3.reason },
  };
}

export function abortDerivScan() { scanAborted = true; }

// ── Formatting helper ──────────────────────────────────────────
export function formatDerivPrice(p) {
  if (!p) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
