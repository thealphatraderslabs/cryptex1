// ATL · Derivatives Confluence Scanner (Phase 5 — v2)
// 3-gate sequential funnel — finds coins BEFORE the move, not after:
//
//   Gate 1 — Structure + Compression
//             Price at key level · ATR coiling · No recent BOS · HTF direction clear
//
//   Gate 2 — OI + CVD Loading
//             OI rising while price flat (quiet accumulation/distribution)
//             CVD from aggTrades leaning in breakout direction
//             These two together = someone positioning before price moves
//
//   Gate 3 — Deriv Confirmation
//             calcDerivScore (funding weight = 0, redistributed to OI + basis)
//             derivScore ≥ 58 long / ≤ 42 short
//
//   Funding — DISPLAY ONLY, zero gate weight, zero score weight
//             Shown on result card as context, never used in pass/fail
//
// API call budget per coin:
//   Gate 1: ticker (1) + HTF klines (1) = 2 calls — all pairs
//   Gate 2: OI history (1) + aggTrades (1) = 2 calls — Gate 1 survivors only
//   Gate 3: MTF klines (1) + OI long (1) + basis klines (2) + bookTicker (1)
//           = 5 calls — Gate 2 survivors only

import {
  calcATR,
  detectSwings,
  detectStructure,
  detectOrderBlocks,
  calcInsuranceTrend,
  calcDerivedMoneyFlow,
  calcBasisSlope,
} from './indicators.js';

import { calcDerivScore } from './signals.js';

// ── API bases ──────────────────────────────────────────────────
const BYBIT_BASE = 'https://api.bybit.com/v5/market';
const FAPI_BASE  = 'https://fapi.binance.com/fapi/v1';

// ── Batch sizing ───────────────────────────────────────────────
const BATCH_SIZE_G1  = 15;
const BATCH_SIZE_G2  = 12;
const BATCH_SIZE_G3  = 8;
const BATCH_DELAY_G1 = 150;
const BATCH_DELAY_G2 = 120;
const BATCH_DELAY_G3 = 200;

// ── Gate 1 thresholds ──────────────────────────────────────────
const ATR_COMPRESSION_MAX  = 0.88; // atrNow/atrBaseline must be below this
const OB_PROXIMITY_MAX_PCT = 0.04; // price within 4% of fresh OB or swing level
const RECENT_BOS_BARS      = 4;    // no BOS in last N bars (pre-move state)

// ── Gate 2 thresholds ──────────────────────────────────────────
const OI_DIVERGENCE_MIN_PCT = 1.5; // OI must rise >= 1.5% while price flat
const PRICE_FLAT_MAX_PCT    = 1.5; // price range <= 1.5% for OI divergence
const CVD_CONFIRM_THRESHOLD = 15;  // |cvdBias| >= 15% = strong directional
const GATE2_PASS_SCORE      = 2;   // need >= 2 points to pass

// ── Gate 3 thresholds ──────────────────────────────────────────
const DERIV_SCORE_LONG_MIN  = 58;
const DERIV_SCORE_SHORT_MAX = 42;

// ── TF map ─────────────────────────────────────────────────────
const TF_MAP = {
  '15m': { bybit: '15',  fapi: '15m', htfBybit: '60',  htfFapi: '1h'  },
  '1h':  { bybit: '60',  fapi: '1h',  htfBybit: '240', htfFapi: '4h'  },
  '4h':  { bybit: '240', fapi: '4h',  htfBybit: 'D',   htfFapi: '1d'  },
  '1d':  { bybit: 'D',   fapi: '1d',  htfBybit: 'W',   htfFapi: '1w'  },
  '1w':  { bybit: 'W',   fapi: '1w',  htfBybit: 'W',   htfFapi: '1w'  },
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
//  LEAN DATA FETCHERS
// ═══════════════════════════════════════════════════════════════

async function fetchTickerLean(symbol, exchange) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    if (exchange === 'bybit') {
      const d = await fetchJSON(`${BYBIT_BASE}/tickers?category=linear&symbol=${sym}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      const t = d.result.list[0];
      return {
        price:        parseFloat(t.lastPrice),
        fundingRate:  parseFloat(t.fundingRate) * 100, // % — display only
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

// OI short window — Gate 2 divergence (6-12 bars)
async function fetchOIShort(symbol, limit = 12) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(
      `${BYBIT_BASE}/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=${limit}`
    );
    if (d.retCode !== 0) return [];
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.timestamp) / 1000),
      oi:   parseFloat(r.openInterest),
    }));
  } catch { return []; }
}

// OI long window — Gate 3 deriv scoring (24 bars)
async function fetchOILong(symbol, limit = 24) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(
      `${BYBIT_BASE}/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=${limit}`
    );
    if (d.retCode !== 0) return [];
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.timestamp) / 1000),
      oi:   parseFloat(r.openInterest),
    }));
  } catch { return []; }
}

// aggTrades — Gate 2 CVD calculation
// FAPI convention: m=true means the buyer is the maker = SELL order filled
// m=false means buyer is taker = BUY order placed aggressively
async function fetchAggTradesLean(symbol, limit = 150) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(`${FAPI_BASE}/aggTrades?symbol=${sym}&limit=${limit}`);
    let buyVol = 0, sellVol = 0;
    for (const t of d) {
      const qty = parseFloat(t.q);
      if (t.m) sellVol += qty; // maker = passive = sell side absorbed
      else     buyVol  += qty; // taker = aggressive = buy side pushing
    }
    const total   = buyVol + sellVol;
    const cvdBias = total > 0 ? ((buyVol - sellVol) / total) * 100 : 0;
    return {
      buyVol, sellVol, total, cvdBias,
      buyRatio:  total > 0 ? buyVol / total  : 0.5,
      sellRatio: total > 0 ? sellVol / total : 0.5,
    };
  } catch {
    return { buyVol: 0, sellVol: 0, total: 0, cvdBias: 0, buyRatio: 0.5, sellRatio: 0.5 };
  }
}

async function fetchBasisLean(symbol, tfKey, limit = 48) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const [markRes, indexRes] = await Promise.all([
      fetchJSON(`${BYBIT_BASE}/mark-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
      fetchJSON(`${BYBIT_BASE}/index-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
    ]);
    if (markRes.retCode !== 0 || indexRes.retCode !== 0) return null;
    const markList = (markRes.result?.list || []).reverse();
    const indexMap = new Map(
      (indexRes.result?.list || []).reverse().map(r => [r[0], parseFloat(r[4])])
    );
    const history = markList.map(r => {
      const mark  = parseFloat(r[4]);
      const index = indexMap.get(r[0]);
      if (!index) return null;
      return { time: Math.floor(Number(r[0]) / 1000), basis: ((mark - index) / index) * 100, mark, index };
    }).filter(Boolean);
    if (!history.length) return null;
    const vals = history.map(b => b.basis);
    const last = vals[vals.length - 1];
    const n    = Math.min(12, vals.length);
    const win  = vals.slice(-n);
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += win[i]; sxy += i * win[i]; sxx += i * i; }
    const slope     = n > 1 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
    const direction = slope > 0.0003 ? 'expanding' : slope < -0.0003 ? 'contracting' : 'flat';
    return { history, lastBasis: last, slope, direction };
  } catch { return null; }
}

async function fetchSpreadLean(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d   = await fetchJSON(`${FAPI_BASE}/ticker/bookTicker?symbol=${sym}`);
    const bid = parseFloat(d.bidPrice);
    const ask = parseFloat(d.askPrice);
    const mid = (bid + ask) / 2;
    return { bestBid: bid, bestAsk: ask, spread: mid > 0 ? ((ask - bid) / mid) * 100 : 0 };
  } catch { return null; }
}

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
    const first    = history[0].value;
    const last     = history[history.length - 1].value;
    const delta    = last - first;
    const deltaPct = first > 0 ? (delta / first) * 100 : 0;
    let stressed = false, stressIdx = -1;
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1].value > 0 &&
          (history[i - 1].value - history[i].value) / history[i - 1].value > 0.02) {
        stressed = true; stressIdx = i; break;
      }
    }
    return {
      coin: 'BTC', history, current: last, delta, deltaPct,
      trend: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
      stressed, stressIdx,
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
//  GATE 1 — STRUCTURE + COMPRESSION
//
//  Finds coins that are COILING at a key level before breaking.
//  All four checks must pass:
//
//  1. ATR compression  — atrNow/atrBaseline < 0.88 (volatility contracting)
//  2. HTF direction    — structure trend must be bull or bear
//  3. No recent BOS    — last structure event > RECENT_BOS_BARS ago
//  4. Price at level   — within 4% of fresh OB or swing high/low
//
//  CVC fails check 1 — ATR exploded on the move
//  FOLKS fails check 4 — price is mid-range, no nearby level
// ═══════════════════════════════════════════════════════════════
function runGate1(htfCandles, ticker) {
  if (!htfCandles || htfCandles.length < 60 || !ticker) {
    return { pass: false, dir: 'neutral', reason: 'Insufficient HTF data', smcScore: 0, atrRatio: 1 };
  }

  const price = ticker.price;
  const n     = htfCandles.length;
  const atrs  = calcATR(htfCandles, 14);

  // ── 1. ATR compression ───────────────────────────────────────
  let atrNow = null;
  for (let i = n - 1; i >= 0; i--) {
    if (atrs[i] != null) { atrNow = atrs[i]; break; }
  }
  const atrBaseVals = [];
  for (let i = Math.max(0, n - 21); i <= Math.max(0, n - 5); i++) {
    if (atrs[i] != null) atrBaseVals.push(atrs[i]);
  }
  const atrBaseline = atrBaseVals.length > 0
    ? atrBaseVals.reduce((a, b) => a + b, 0) / atrBaseVals.length
    : atrNow;
  const atrRatio = (atrNow && atrBaseline) ? atrNow / atrBaseline : 1;

  if (atrRatio >= ATR_COMPRESSION_MAX) {
    return {
      pass: false, dir: 'neutral', smcScore: 0, atrRatio,
      reason: `ATR expanding (ratio ${atrRatio.toFixed(2)}) — price already in motion, not coiling`,
    };
  }

  // ── 2. HTF direction ─────────────────────────────────────────
  const { pivotHighs, pivotLows } = detectSwings(htfCandles, 5, 20);
  const structure = detectStructure(
    htfCandles,
    pivotHighs.map(p => ({ ...p })),
    pivotLows.map(p => ({ ...p }))
  );
  const dir = structure?.trend || 'neutral';

  if (dir === 'neutral') {
    return {
      pass: false, dir, smcScore: 0, atrRatio,
      reason: `HTF structure neutral — no directional bias to trade`,
    };
  }

  // ── 3. No recent BOS ─────────────────────────────────────────
  const events    = structure?.events || [];
  const lastEvent = events[events.length - 1];
  const barsSince = lastEvent ? (n - 1 - (lastEvent.idx || 0)) : 999;

  if (barsSince <= RECENT_BOS_BARS) {
    return {
      pass: false, dir, smcScore: 1, atrRatio,
      reason: `BOS ${barsSince} bar(s) ago — move already started, waiting for next setup`,
    };
  }

  // ── 4. Price at key level ────────────────────────────────────
  const freshOBs = detectOrderBlocks(htfCandles, atrs, events, 8)
    .filter(ob => ob.state === 'fresh');

  // Nearest direction-matched OB
  let nearestOB = null;
  let obDist    = Infinity;
  for (const ob of freshOBs) {
    const dirOK = (dir === 'bull' && ob.type === 'demand') ||
                  (dir === 'bear' && ob.type === 'supply');
    if (!dirOK) continue;
    const dist = Math.abs(price - (ob.high + ob.low) / 2) / price;
    if (dist < obDist) { obDist = dist; nearestOB = ob; }
  }

  // Nearest direction-matched swing level as fallback
  let nearestSwing = null;
  let swingDist    = Infinity;
  const swingPool  = dir === 'bull' ? pivotLows : pivotHighs;
  for (const piv of swingPool.slice(-5)) {
    const dist = Math.abs(price - piv.price) / price;
    if (dist < swingDist) { swingDist = dist; nearestSwing = piv; }
  }

  const levelDist  = Math.min(obDist, swingDist);
  const levelPrice = obDist <= swingDist
    ? (nearestOB ? (nearestOB.high + nearestOB.low) / 2 : null)
    : nearestSwing?.price;
  const levelType  = obDist <= swingDist
    ? (nearestOB ? `${nearestOB.type} OB` : 'swing')
    : `swing ${dir === 'bull' ? 'low' : 'high'}`;

  if (levelDist > OB_PROXIMITY_MAX_PCT) {
    return {
      pass: false, dir, smcScore: 1, atrRatio,
      reason: `Price ${(levelDist * 100).toFixed(1)}% from nearest ${levelType} — not at decision point`,
    };
  }

  // ── All checks passed ─────────────────────────────────────────
  // smcScore 1-4: direction(1) + compression(1) + level tightness(0-2)
  const proximityBonus = levelDist < 0.02 ? 2 : levelDist < 0.035 ? 1 : 0;
  const smcScore       = Math.min(1 + 1 + proximityBonus, 4);

  return {
    pass:         true,
    dir,
    smcScore,
    atrRatio,
    nearestLevel: levelPrice,
    levelDist,
    levelType,
    nearestOB,
    structure,
    reason: `HTF ${dir.toUpperCase()} · ATR ${(atrRatio * 100).toFixed(0)}% of baseline · ${(levelDist * 100).toFixed(1)}% from ${levelType} · pre-BOS (${barsSince} bars clean)`,
  };
}

// ═══════════════════════════════════════════════════════════════
//  GATE 2 — OI + CVD LOADING
//
//  Finds coins where smart money is POSITIONING before price moves.
//
//  Signal A — OI divergence (max 2 points)
//    OI rising >= 1.5% over last 6 bars while price range <= 1.5%
//    = new positions opening without price moving
//    = accumulation or distribution in progress
//    Partial credit: OI rising >= 0.9% with limited price movement = 1pt
//
//  Signal B — CVD direction (max 2 points)
//    Net taker aggressor bias from last 150 aggTrades
//    Strong match (>= 15% net) = 2pts
//    Mild match (>= 5% net) = 1pt
//    Opposing (-1pt penalty)
//
//  Gate passes if total score >= GATE2_PASS_SCORE (2)
//  Funding is NOT evaluated — not fetched, not scored
// ═══════════════════════════════════════════════════════════════
function runGate2(oiHistory, aggTradesData, smcDir, htfCandles) {
  let score = 0;
  const parts = [];

  // ── Signal A: OI divergence ───────────────────────────────────
  let oiDelta      = 0;
  let priceRange   = 0;
  let oiDivergence = false;

  if (oiHistory && oiHistory.length >= 6) {
    const oiWin  = oiHistory.slice(-6);
    const oiFirst = oiWin[0].oi;
    const oiLast  = oiWin[oiWin.length - 1].oi;
    oiDelta = oiFirst > 0 ? ((oiLast - oiFirst) / oiFirst) * 100 : 0;

    if (htfCandles && htfCandles.length >= 6) {
      const priceWin = htfCandles.slice(-6);
      const maxC     = Math.max(...priceWin.map(c => c.close));
      const minC     = Math.min(...priceWin.map(c => c.close));
      priceRange     = minC > 0 ? ((maxC - minC) / minC) * 100 : 99;
    }

    if (oiDelta >= OI_DIVERGENCE_MIN_PCT && priceRange <= PRICE_FLAT_MAX_PCT) {
      oiDivergence = true;
      score += 2;
      parts.push(`OI +${oiDelta.toFixed(1)}% · price flat ${priceRange.toFixed(1)}% — loading`);
    } else if (oiDelta >= OI_DIVERGENCE_MIN_PCT * 0.6 && priceRange <= PRICE_FLAT_MAX_PCT * 1.3) {
      score += 1;
      parts.push(`OI +${oiDelta.toFixed(1)}% · mild price movement — partial loading`);
    } else if (oiDelta < -1) {
      parts.push(`OI ${oiDelta.toFixed(1)}% falling — positions closing`);
    } else {
      parts.push(`OI ${oiDelta.toFixed(1)}% · price ${priceRange.toFixed(1)}% — no divergence`);
    }
  } else {
    parts.push('OI data unavailable');
  }

  // ── Signal B: CVD from aggTrades ─────────────────────────────
  let cvdBias      = 0;
  let cvdDirection = 'neutral';

  if (aggTradesData && aggTradesData.total > 0) {
    cvdBias = aggTradesData.cvdBias;

    const strongBull = smcDir === 'bull' && cvdBias >= CVD_CONFIRM_THRESHOLD;
    const strongBear = smcDir === 'bear' && cvdBias <= -CVD_CONFIRM_THRESHOLD;
    const mildBull   = smcDir === 'bull' && cvdBias >= 5 && cvdBias < CVD_CONFIRM_THRESHOLD;
    const mildBear   = smcDir === 'bear' && cvdBias <= -5 && cvdBias > -CVD_CONFIRM_THRESHOLD;
    const opposing   = (smcDir === 'bull' && cvdBias < -CVD_CONFIRM_THRESHOLD) ||
                       (smcDir === 'bear' && cvdBias >  CVD_CONFIRM_THRESHOLD);

    if (strongBull || strongBear) {
      score += 2;
      cvdDirection = smcDir === 'bull' ? 'bullish' : 'bearish';
      parts.push(`CVD ${cvdBias > 0 ? '+' : ''}${cvdBias.toFixed(1)}% — strong ${cvdDirection} taker flow`);
    } else if (mildBull || mildBear) {
      score += 1;
      cvdDirection = smcDir === 'bull' ? 'bullish' : 'bearish';
      parts.push(`CVD ${cvdBias > 0 ? '+' : ''}${cvdBias.toFixed(1)}% — mild ${cvdDirection} lean`);
    } else if (opposing) {
      score -= 1;
      parts.push(`CVD ${cvdBias > 0 ? '+' : ''}${cvdBias.toFixed(1)}% — taker flow opposing ${smcDir}`);
    } else {
      parts.push(`CVD ${cvdBias > 0 ? '+' : ''}${cvdBias.toFixed(1)}% — neutral`);
    }
  } else {
    parts.push('CVD unavailable');
  }

  return {
    pass:         score >= GATE2_PASS_SCORE,
    score,
    oiDelta,
    priceRange,
    oiDivergence,
    cvdBias,
    cvdDirection,
    reason:       parts.join(' · '),
  };
}

// ═══════════════════════════════════════════════════════════════
//  GATE 3 — DERIV CONFIRMATION
//
//  calcDerivScore() is called with funding weight = 0 (fixed to
//  neutral 50 in signals.js — no directional contribution).
//  Score driven by: OI flow 35%, basis 30%, taker 15%, insurance 10%, spread 5% + fixed funding 0%.
// ═══════════════════════════════════════════════════════════════
function runGate3(smcDir, derivScoreResult) {
  const { derivScore, derivLabel, derivColor, components } = derivScoreResult;
  let pass = false, reason = '';

  if (smcDir === 'bull') {
    pass   = derivScore >= DERIV_SCORE_LONG_MIN;
    reason = pass
      ? `Deriv ${derivScore}/100 — confirms bullish confluence`
      : `Deriv ${derivScore}/100 — insufficient (need ≥ ${DERIV_SCORE_LONG_MIN})`;
  } else if (smcDir === 'bear') {
    pass   = derivScore <= DERIV_SCORE_SHORT_MAX;
    reason = pass
      ? `Deriv ${derivScore}/100 — confirms bearish confluence`
      : `Deriv ${derivScore}/100 — insufficient (need ≤ ${DERIV_SCORE_SHORT_MAX})`;
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
    // ── Step 0: Global one-time fetches ──────────────────────
    onProgress({ phase: 'init', msg: 'Fetching pairs + insurance fund…' });

    const [pairs, insuranceFund] = await Promise.all([
      exchange === 'bybit' ? fetchBybitPairs() : fetchBinancePairs(),
      fetchInsuranceLean(),
    ]);
    const insuranceTrend = calcInsuranceTrend(insuranceFund);
    const total          = pairs.length;

    onProgress({ phase: 'start', done: 0, total, msg: `${total} pairs — running 3-gate funnel…` });

    // ── Gate 1: Structure + Compression ──────────────────────
    const gate1Results = new Map();
    let done = 0;

    for (let i = 0; i < pairs.length; i += BATCH_SIZE_G1) {
      if (scanAborted) break;
      const batch = pairs.slice(i, i + BATCH_SIZE_G1);

      const results = await Promise.all(batch.map(async sym => {
        try {
          const [htfCandles, ticker] = await Promise.all([
            fetchHTFKlines(sym, exchange, tf, 120),
            fetchTickerLean(sym, exchange),
          ]);
          return { sym, g1: runGate1(htfCandles, ticker), ticker, htfCandles };
        } catch {
          return { sym, g1: { pass: false, reason: 'Fetch error', smcScore: 0, atrRatio: 1 }, ticker: null, htfCandles: [] };
        }
      }));

      for (const r of results) { done++; gate1Results.set(r.sym, r); }

      const g1Passed = [...gate1Results.values()].filter(r => r.g1.pass).length;
      onProgress({
        phase: 'gate1', done, total,
        msg:   `Gate 1 (Structure) · ${done}/${total} · ${g1Passed} passed`,
      });

      if (i + BATCH_SIZE_G1 < pairs.length) await sleep(BATCH_DELAY_G1);
    }

    if (scanAborted) { onDone({ results: [], total, aborted: true }); return; }

    // ── Gate 2: OI + CVD Loading ──────────────────────────────
    const g1Survivors = [...gate1Results.values()].filter(r => r.g1.pass);
    const g1Count     = g1Survivors.length;

    onProgress({
      phase: 'gate2_start', done: 0, total: g1Count,
      msg:   `Gate 2 (OI + CVD) · evaluating ${g1Count} structure qualifiers…`,
    });
    await sleep(80);

    const gate2Results = new Map();
    let g2Done = 0;

    for (let i = 0; i < g1Survivors.length; i += BATCH_SIZE_G2) {
      if (scanAborted) break;
      const batch = g1Survivors.slice(i, i + BATCH_SIZE_G2);

      const results = await Promise.all(batch.map(async r => {
        try {
          const [oiHistory, aggTrades] = await Promise.all([
            fetchOIShort(r.sym, 12),
            fetchAggTradesLean(r.sym, 150),
          ]);
          const g2 = runGate2(oiHistory, aggTrades, r.g1.dir, r.htfCandles);
          return { ...r, g2, oiHistory, aggTrades };
        } catch {
          return { ...r, g2: { pass: false, score: 0, reason: 'Fetch error', oiDelta: 0, cvdBias: 0 }, oiHistory: [], aggTrades: null };
        }
      }));

      for (const r of results) {
        g2Done++;
        if (r.g2.pass) gate2Results.set(r.sym, r);
      }

      onProgress({
        phase: 'gate2_progress', done: g2Done, total: g1Count,
        msg:   `Gate 2 (OI + CVD) · ${g2Done}/${g1Count} · ${gate2Results.size} passed`,
      });

      if (i + BATCH_SIZE_G2 < g1Survivors.length) await sleep(BATCH_DELAY_G2);
    }

    const g2Count = gate2Results.size;
    onProgress({
      phase: 'gate2', done: g1Count, total: g1Count,
      msg:   `Gate 2 (OI + CVD) · ${g2Count} passed from ${g1Count} structure qualifiers`,
    });
    await sleep(120);

    if (scanAborted || !g2Count) { onDone({ results: [], total, aborted: scanAborted }); return; }

    // ── Gate 3: Deriv Confirmation ────────────────────────────
    const finalResults = [];
    const g2Symbols    = [...gate2Results.keys()];
    let   g3Done       = 0;

    for (let i = 0; i < g2Symbols.length; i += BATCH_SIZE_G3) {
      if (scanAborted) break;
      const batch = g2Symbols.slice(i, i + BATCH_SIZE_G3);

      const results = await Promise.all(batch.map(async sym => {
        const existing = gate2Results.get(sym);
        try {
          const [mtfCandles, oiLong, basisHistory, bookTicker] = await Promise.all([
            fetchMTFKlines(sym, exchange, tf, 200),
            fetchOILong(sym, 24),
            fetchBasisLean(sym, tf, 48),
            fetchSpreadLean(sym),
          ]);

          const basisAna  = calcBasisSlope(basisHistory);
          const moneyFlow = calcDerivedMoneyFlow(existing.ticker, oiLong, null);

          // Use CVD from Gate 2 aggTrades as taker flow proxy
          const takerFlow = existing.aggTrades?.total > 0
            ? {
                takerBias:  existing.aggTrades.cvdBias,
                buyRatio:   existing.aggTrades.buyRatio,
                sellRatio:  existing.aggTrades.sellRatio,
              }
            : null;

          // Funding passed in data but signals.js weights it at 0
          // (funding component fixed to 50 — no directional effect on score)
          const miniData = {
            ticker:       existing.ticker,
            oiHistory:    oiLong,
            takerFlow,
            fundingInfo:  new Map(), // empty — funding not scored
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
          const g3       = runGate3(existing.g1.dir, dsResult);

          return { sym, existing, g3, dsResult, mtfCandles, oiLong, basisHistory, bookTicker };
        } catch (e) {
          return {
            sym, existing,
            g3: { pass: false, derivScore: 0, reason: `Error: ${e.message}` },
            dsResult: null, mtfCandles: [], oiLong: [], basisHistory: null, bookTicker: null,
          };
        }
      }));

      for (const r of results) {
        g3Done++;
        if (r.g3.pass) {
          const result = buildResult(r, insuranceTrend);
          finalResults.push(result);
          onResult(result);
        }
        onProgress({
          phase: 'gate3', done: g3Done, total: g2Symbols.length,
          msg:   `Gate 3 (Deriv) · ${g3Done}/${g2Symbols.length} · ${finalResults.length} final`,
        });
      }

      if (i + BATCH_SIZE_G3 < g2Symbols.length) await sleep(BATCH_DELAY_G3);
    }

    // Sort by conviction descending — strongest setups first
    finalResults.sort((a, b) => b.conviction - a.conviction);

    onDone({ results: finalResults, total, aborted: scanAborted });

  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  BUILD RESULT OBJECT
// ═══════════════════════════════════════════════════════════════
function buildResult(r, insuranceTrend) {
  const { sym, existing, g3, dsResult, oiLong, basisHistory, bookTicker } = r;
  const { g1, g2, ticker } = existing;
  const dir    = g1.dir;
  const isLong = dir === 'bull';

  // Funding — display only
  const fr      = ticker?.fundingRate || 0; // already in %
  const frColor = fr < -0.05 ? '#00e676' : fr > 0.05 ? '#ff4444' : '#8892a0';
  const frLabel = fr < -0.05 ? 'NEGATIVE' : fr > 0.05 ? 'POSITIVE' : 'NEUTRAL';

  // OI trend from long window
  const oiLen   = oiLong?.length || 0;
  const oiTrend = oiLen >= 2
    ? (oiLong[oiLen - 1].oi > oiLong[0].oi ? 'rising' : 'falling')
    : 'unknown';

  // Conviction — SMC 50% + OI/CVD 30% + derivScore 20%
  const smcNorm   = Math.min(g1.smcScore / 4, 1) * 100;
  const g2Norm    = Math.min(Math.max(g2.score / 4, 0), 1) * 100;
  const derivNorm = isLong ? g3.derivScore : (100 - g3.derivScore);
  const conviction = Math.round(smcNorm * 0.5 + g2Norm * 0.3 + derivNorm * 0.2);

  let convLabel, convColor;
  if      (conviction >= 80) { convLabel = 'PRIME';    convColor = '#00e676'; }
  else if (conviction >= 65) { convLabel = 'HIGH';     convColor = '#69f0ae'; }
  else if (conviction >= 50) { convLabel = 'MODERATE'; convColor = '#ffd54f'; }
  else                       { convLabel = 'WEAK';     convColor = '#ff9090'; }

  return {
    symbol:     sym,
    dir,
    isLong,
    biasLabel:  isLong ? '⬆ LONG' : '⬇ SHORT',
    biasColor:  isLong ? '#00e676' : '#ff4444',
    price:      ticker.price,

    // Funding — display only, no gate role
    fundingRate: fr,
    fundingStr:  `${fr.toFixed(4)}%`,
    frColor,
    frLabel,

    // Gate summaries
    g1: {
      pass:         g1.pass,
      smcScore:     g1.smcScore,
      dir:          g1.dir,
      atrRatio:     g1.atrRatio,
      levelDist:    g1.levelDist,
      levelType:    g1.levelType,
      nearestLevel: g1.nearestLevel,
      reason:       g1.reason,
    },
    g2: {
      pass:         g2.pass,
      score:        g2.score,
      oiDelta:      g2.oiDelta,
      priceRange:   g2.priceRange,
      oiDivergence: g2.oiDivergence,
      cvdBias:      g2.cvdBias,
      cvdDirection: g2.cvdDirection,
      reason:       g2.reason,
    },
    g3: {
      pass:       g3.pass,
      derivScore: g3.derivScore,
      derivLabel: g3.derivLabel,
      derivColor: g3.derivColor,
      reason:     g3.reason,
    },

    // Deriv breakdown for card
    derivScore:  g3.derivScore,
    derivLabel:  g3.derivLabel,
    derivColor:  g3.derivColor,
    components:  dsResult?.components || {},

    // Context
    oiTrend,
    basisDir:      basisHistory?.direction || 'unknown',
    spread:        bookTicker?.spread ?? null,
    insuranceTrend,

    // Conviction
    conviction,
    convLabel,
    convColor,
  };
}

export function abortDerivScan() { scanAborted = true; }

export function formatDerivPrice(p) {
  if (!p) return '—';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(3);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
