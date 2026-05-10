// ATL · SMC Scanner
// 7-gate sequential confluence engine
// Supports Bybit (linear perps) and Binance (FAPI perps)
// Timeframe-respecting: all klines fetched on selected TF

// ══════════════════════════════════════════════════════════════
//  IMPORTS (primitives reused from indicators.js)
// ══════════════════════════════════════════════════════════════
import {
  calcATR, calcRSI, calcMACD, calcEMAStack,
  detectSwings, detectStructure, detectOrderBlocks, detectFVGs,
  calcPremiumDiscount,
} from './indicators.js';

// ══════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════
const BYBIT_BASE  = 'https://api.bybit.com/v5/market';
const FAPI_BASE   = 'https://fapi.binance.com/fapi/v1';
const BATCH_SIZE  = 12;   // concurrent requests per batch
const BATCH_DELAY = 180;  // ms between batches

const TF_MAP = {
  '15m': { bybit: '15',  fapi: '15m', htfBybit: '60',  htfFapi: '1h'  },
  '1h':  { bybit: '60',  fapi: '1h',  htfBybit: '240', htfFapi: '4h'  },
  '4h':  { bybit: '240', fapi: '4h',  htfBybit: 'D',   htfFapi: '1d'  },
  '1d':  { bybit: 'D',   fapi: '1d',  htfBybit: 'W',   htfFapi: '1w'  },
  '1w':  { bybit: 'W',   fapi: '1w',  htfBybit: 'W',   htfFapi: '1w'  },
};

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let scanAborted   = false;
let scanRunning   = false;

// ══════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ══════════════════════════════════════════════════════════════
//  PAIR FETCHING
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
//  KLINES (lean — only what the gate engine needs)
// ══════════════════════════════════════════════════════════════
async function fetchKlinesLean(symbol, exchange, tfKey, limit = 200) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';

  if (exchange === 'bybit') {
    try {
      const d = await fetchJSON(`${BYBIT_BASE}/kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      return d.result.list.reverse().map(c => ({
        time:   Math.floor(Number(c[0]) / 1000),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch { return []; }
  } else {
    try {
      const d = await fetchJSON(`${FAPI_BASE}/klines?symbol=${sym}&interval=${tf.fapi}&limit=${limit}`);
      return d.map(c => ({
        time:   Math.floor(c[0] / 1000),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch { return []; }
  }
}

async function fetchHTFKlinesLean(symbol, exchange, tfKey, limit = 100) {
  const tf  = TF_MAP[tfKey] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';

  if (exchange === 'bybit') {
    try {
      const d = await fetchJSON(`${BYBIT_BASE}/kline?symbol=${sym}&interval=${tf.htfBybit}&limit=${limit}`);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      return d.result.list.reverse().map(c => ({
        time:   Math.floor(Number(c[0]) / 1000),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch { return []; }
  } else {
    try {
      const d = await fetchJSON(`${FAPI_BASE}/klines?symbol=${sym}&interval=${tf.htfFapi}&limit=${limit}`);
      return d.map(c => ({
        time:   Math.floor(c[0] / 1000),
        open:   parseFloat(c[1]),
        high:   parseFloat(c[2]),
        low:    parseFloat(c[3]),
        close:  parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }));
    } catch { return []; }
  }
}

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
        price24hPct:  parseFloat(t.price24hPcnt) * 100,
      };
    } else {
      const d = await fetchJSON(`${FAPI_BASE}/premiumIndex?symbol=${sym}`);
      return {
        price:        parseFloat(d.markPrice),
        fundingRate:  parseFloat(d.lastFundingRate) * 100,
        openInterest: null,
        price24hPct:  null,
      };
    }
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════
//  7-GATE ENGINE
//  Returns { score, gates, bias, biasColor, biasLabel, price, fundingRate, oiTrend }
// ══════════════════════════════════════════════════════════════
function runGates(candles, htfCandles, ticker) {
  const gates = [];
  let score   = 0;

  // Need at least 60 bars to run
  if (!candles || candles.length < 60) {
    return null;
  }

  const price = ticker?.price || candles[candles.length - 1].close;

  // ── Pre-compute indicators ─────────────────────────────────
  const atrs      = calcATR(candles, 14);
  const rsi       = calcRSI(candles, 14);
  const macdData  = calcMACD(candles);
  const emas      = calcEMAStack(candles);
  const { pivotHighs, pivotLows } = detectSwings(candles, 5, 20);
  const structure = detectStructure(
    candles,
    pivotHighs.map(p => ({ ...p })),
    pivotLows.map(p => ({ ...p }))
  );
  const orderBlocks = detectOrderBlocks(candles, atrs, structure.events || [], 8);
  const fvgs        = detectFVGs(candles, 0.03, 10);
  const premDisc    = calcPremiumDiscount(candles, 100);

  let htfStructure = null;
  if (htfCandles && htfCandles.length >= 50) {
    const htfSwings = detectSwings(htfCandles, 5, 20);
    htfStructure = detectStructure(
      htfCandles,
      htfSwings.pivotHighs.map(p => ({ ...p })),
      htfSwings.pivotLows.map(p => ({ ...p }))
    );
  }

  const lastRSI      = rsi[rsi.length - 1];
  const lastEMA20    = emas.ema20[emas.ema20.length - 1];
  const lastEMA50    = emas.ema50[emas.ema50.length - 1];
  const lastEMA200   = emas.ema200[emas.ema200.length - 1];
  const lastHist     = macdData.histogram[macdData.histogram.length - 1];
  const prevHist     = macdData.histogram[macdData.histogram.length - 2];
  const mtfTrend     = structure?.trend;
  const htfTrend     = htfStructure?.trend;
  const fundingRate  = ticker?.fundingRate || 0;

  // Determine primary direction from HTF → MTF cascade
  // If HTF is clear, use it. Else fall back to MTF.
  const primaryDir = htfTrend || mtfTrend || 'neutral';

  // ── GATE 1: HTF Structure ──────────────────────────────────
  // HTF must show a clear directional trend (bull or bear)
  // Choppy / neutral HTF = not ready
  const g1Pass = htfTrend === 'bull' || htfTrend === 'bear';
  gates.push({
    id:    1,
    label: 'HTF Structure',
    desc:  g1Pass
      ? `HTF is ${htfTrend === 'bull' ? 'bullish' : 'bearish'} — directional bias confirmed`
      : 'HTF structure unclear or ranging — no directional bias',
    pass:  g1Pass,
  });
  if (g1Pass) score++;

  // ── GATE 2: LTF Structure Alignment ───────────────────────
  // MTF must agree with HTF direction
  // Misalignment = counter-trend risk, not a prime setup
  const g2Pass = g1Pass && (mtfTrend === htfTrend);
  gates.push({
    id:    2,
    label: 'TF Alignment',
    desc:  !g1Pass
      ? 'Skipped — HTF structure not established'
      : g2Pass
        ? `MTF (${mtfTrend}) aligns with HTF (${htfTrend}) — dual-TF confluence`
        : `MTF (${mtfTrend}) conflicts with HTF (${htfTrend}) — counter-trend risk`,
    pass:  g2Pass,
  });
  if (g2Pass) score++;

  // ── GATE 3: Premium / Discount Zone ───────────────────────
  // Longs: price must be in discount (position < 0.45)
  // Shorts: price must be in premium (position > 0.55)
  // Mid-range entries = poor R:R
  let g3Pass = false;
  let g3Desc = 'No P/D data';
  if (premDisc) {
    const pos = premDisc.position; // 0 = range low, 1 = range high
    if (primaryDir === 'bull') {
      g3Pass = pos < 0.45;
      g3Desc = g3Pass
        ? `Price in discount zone (${(pos * 100).toFixed(0)}% of range) — valid long entry area`
        : `Price in premium/mid (${(pos * 100).toFixed(0)}% of range) — chasing, poor R:R for long`;
    } else if (primaryDir === 'bear') {
      g3Pass = pos > 0.55;
      g3Desc = g3Pass
        ? `Price in premium zone (${(pos * 100).toFixed(0)}% of range) — valid short entry area`
        : `Price in discount/mid (${(pos * 100).toFixed(0)}% of range) — chasing, poor R:R for short`;
    } else {
      g3Desc = 'Direction not established — P/D zone check skipped';
    }
  }
  gates.push({
    id:    3,
    label: 'Premium / Discount',
    desc:  g3Desc,
    pass:  g3Pass,
  });
  if (g3Pass) score++;

  // ── GATE 4: Fresh Order Block ──────────────────────────────
  // A fresh, unmitigated OB must exist near current price
  // Tolerance: within 3% of price
  const freshOBs = orderBlocks.filter(ob => ob.state === 'fresh');
  let g4Pass    = false;
  let g4Desc    = 'No fresh order blocks detected near price';
  let nearestOB = null;

  for (const ob of freshOBs) {
    const obMid  = (ob.top + ob.bottom) / 2;
    const dist   = Math.abs(price - obMid) / price;
    const dirOK  = (primaryDir === 'bull' && ob.type === 'demand')
                || (primaryDir === 'bear' && ob.type === 'supply')
                || primaryDir === 'neutral';
    if (dist < 0.03 && dirOK) {
      g4Pass    = true;
      nearestOB = ob;
      g4Desc    = `Fresh ${ob.type} OB at $${ob.bottom.toFixed(2)}–$${ob.top.toFixed(2)} (${(dist * 100).toFixed(1)}% away)`;
      break;
    }
  }
  // Wider tolerance: within 6% still gets a pass (weaker)
  if (!g4Pass && freshOBs.length > 0) {
    for (const ob of freshOBs) {
      const obMid = (ob.top + ob.bottom) / 2;
      const dist  = Math.abs(price - obMid) / price;
      const dirOK = (primaryDir === 'bull' && ob.type === 'demand')
                 || (primaryDir === 'bear' && ob.type === 'supply')
                 || primaryDir === 'neutral';
      if (dist < 0.06 && dirOK) {
        g4Pass    = true;
        nearestOB = ob;
        g4Desc    = `Fresh ${ob.type} OB approaching — $${ob.bottom.toFixed(2)}–$${ob.top.toFixed(2)} (${(dist * 100).toFixed(1)}% away)`;
        break;
      }
    }
  }
  gates.push({
    id:    4,
    label: 'Fresh Order Block',
    desc:  g4Desc,
    pass:  g4Pass,
  });
  if (g4Pass) score++;

  // ── GATE 5: FVG Confluence ─────────────────────────────────
  // Open FVG overlapping or adjacent to OB zone
  // Or open FVG near price (within 4%) if no OB
  const openFVGs = fvgs.filter(f => !f.filled);
  let g5Pass = false;
  let g5Desc = 'No open FVG near price or OB zone';

  for (const fvg of openFVGs) {
    const fvgMid = (fvg.top + fvg.bottom) / 2;
    const dist   = Math.abs(price - fvgMid) / price;
    if (dist < 0.04) {
      g5Pass = true;
      g5Desc = `Open ${fvg.type} FVG at $${fvg.bottom.toFixed(2)}–$${fvg.top.toFixed(2)} (${(dist * 100).toFixed(1)}% from price)`;
      break;
    }
    // Check overlap with nearestOB
    if (nearestOB) {
      const overlap = fvg.bottom < nearestOB.top && fvg.top > nearestOB.bottom;
      if (overlap) {
        g5Pass = true;
        g5Desc = `FVG + OB overlap zone — stacked confluence at $${Math.max(fvg.bottom, nearestOB.bottom).toFixed(2)}`;
        break;
      }
    }
  }
  gates.push({
    id:    5,
    label: 'FVG Confluence',
    desc:  g5Desc,
    pass:  g5Pass,
  });
  if (g5Pass) score++;

  // ── GATE 6: Derivatives Check ──────────────────────────────
  // For longs: funding should not be highly positive (not euphoric)
  //   Positive funding = longs over-leveraged = short pressure
  //   Negative or neutral funding = room for longs
  // For shorts: funding should not be highly negative
  // OI trend: check last 5 candles volume as proxy if no OI history
  let g6Pass = false;
  let g6Desc = 'No derivatives data';

  if (ticker) {
    const fr = fundingRate;
    if (primaryDir === 'bull') {
      g6Pass = fr <= 0.03; // not overly positive
      g6Desc = g6Pass
        ? `Funding ${fr.toFixed(4)}% — not over-leveraged long, room to move up`
        : `Funding ${fr.toFixed(4)}% — longs over-leveraged, squeeze risk`;
    } else if (primaryDir === 'bear') {
      g6Pass = fr >= -0.03; // not overly negative
      g6Desc = g6Pass
        ? `Funding ${fr.toFixed(4)}% — not over-leveraged short, room to move down`
        : `Funding ${fr.toFixed(4)}% — shorts over-leveraged, short squeeze risk`;
    } else {
      g6Pass = Math.abs(fr) < 0.05;
      g6Desc = `Funding ${fr.toFixed(4)}% — ${Math.abs(fr) < 0.05 ? 'neutral' : 'elevated'}`;
    }
  }
  gates.push({
    id:    6,
    label: 'Derivatives',
    desc:  g6Desc,
    pass:  g6Pass,
  });
  if (g6Pass) score++;

  // ── GATE 7: EMA Stack + Momentum ──────────────────────────
  // Bull: EMA20 > EMA50 > EMA200, RSI 40–70, MACD histogram rising
  // Bear: EMA20 < EMA50 < EMA200, RSI 30–60, MACD histogram falling
  let g7Pass = false;
  let g7Desc = 'Momentum not aligned';

  const emaStackBull = lastEMA20 > lastEMA50 && lastEMA50 > lastEMA200;
  const emaStackBear = lastEMA20 < lastEMA50 && lastEMA50 < lastEMA200;
  const histRising   = lastHist != null && prevHist != null && lastHist > prevHist;
  const histFalling  = lastHist != null && prevHist != null && lastHist < prevHist;
  const rsiBull      = lastRSI != null && lastRSI >= 40 && lastRSI <= 70;
  const rsiBear      = lastRSI != null && lastRSI >= 30 && lastRSI <= 60;

  if (primaryDir === 'bull') {
    g7Pass = emaStackBull && rsiBull && histRising;
    if (!g7Pass) {
      // Partial: any 2 of 3
      const c = [emaStackBull, rsiBull, histRising].filter(Boolean).length;
      g7Pass = c >= 2;
      g7Desc = c >= 2
        ? `Partial momentum (${c}/3): EMA${emaStackBull ? '✓' : '✗'} RSI${rsiBull ? '✓' : '✗'} MACD${histRising ? '✓' : '✗'} — awakening`
        : `Weak momentum (${c}/3): EMA${emaStackBull ? '✓' : '✗'} RSI${rsiBull ? '✓' : '✗'} MACD${histRising ? '✓' : '✗'}`;
    } else {
      g7Desc = `Full bull momentum — EMA stack aligned, RSI ${lastRSI?.toFixed(1)}, MACD rising`;
    }
  } else if (primaryDir === 'bear') {
    g7Pass = emaStackBear && rsiBear && histFalling;
    if (!g7Pass) {
      const c = [emaStackBear, rsiBear, histFalling].filter(Boolean).length;
      g7Pass = c >= 2;
      g7Desc = c >= 2
        ? `Partial momentum (${c}/3): EMA${emaStackBear ? '✓' : '✗'} RSI${rsiBear ? '✓' : '✗'} MACD${histFalling ? '✓' : '✗'} — awakening`
        : `Weak momentum (${c}/3): EMA${emaStackBear ? '✓' : '✗'} RSI${rsiBear ? '✓' : '✗'} MACD${histFalling ? '✓' : '✗'}`;
    } else {
      g7Desc = `Full bear momentum — EMA stack inverted, RSI ${lastRSI?.toFixed(1)}, MACD falling`;
    }
  } else {
    g7Desc = 'Direction not established — momentum check skipped';
  }

  gates.push({
    id:    7,
    label: 'EMA + Momentum',
    desc:  g7Desc,
    pass:  g7Pass,
  });
  if (g7Pass) score++;

  // ── Bias derivation ────────────────────────────────────────
  let bias, biasLabel, biasColor;
  if (score === 7)      { bias = primaryDir === 'bear' ? 'SHORT' : 'LONG';      biasLabel = primaryDir === 'bear' ? '⬇ SHORT'      : '⬆ LONG';      biasColor = primaryDir === 'bear' ? '#ff4444' : '#00e676'; }
  else if (score >= 5)  { bias = primaryDir === 'bear' ? 'LEAN_SHORT' : 'LEAN_LONG'; biasLabel = primaryDir === 'bear' ? '↘ LEAN SHORT' : '↗ LEAN LONG'; biasColor = primaryDir === 'bear' ? '#ff7070' : '#69f0ae'; }
  else if (score >= 3)  { bias = 'DEVELOPING'; biasLabel = '→ DEVELOPING'; biasColor = '#ffd54f'; }
  else                  { bias = 'WEAK';        biasLabel = '— WEAK';       biasColor = '#5a6470'; }

  return {
    score,
    gates,
    bias,
    biasLabel,
    biasColor,
    primaryDir,
    price,
    fundingRate,
    rsi: lastRSI,
  };
}

// ══════════════════════════════════════════════════════════════
//  SCAN SINGLE COIN
// ══════════════════════════════════════════════════════════════
async function scanCoin(symbol, exchange, tf) {
  try {
    const [candles, htfCandles, ticker] = await Promise.all([
      fetchKlinesLean(symbol, exchange, tf, 200),
      fetchHTFKlinesLean(symbol, exchange, tf, 100),
      fetchTickerLean(symbol, exchange),
    ]);
    if (!candles || candles.length < 60) return null;
    const result = runGates(candles, htfCandles, ticker);
    if (!result) return null;
    return { symbol, exchange, tf, ticker, ...result };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//  MASTER SCAN
// ══════════════════════════════════════════════════════════════
async function runScan({ exchange, tf, onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;

  try {
    // 1. Fetch pair list
    onProgress?.({ phase: 'pairs', msg: `Fetching pairs from ${exchange === 'bybit' ? 'Bybit' : 'Binance'}…` });
    let pairs;
    try {
      pairs = exchange === 'bybit' ? await fetchBybitPairs() : await fetchBinancePairs();
    } catch (e) {
      onError?.(`Failed to fetch pair list: ${e.message}`);
      scanRunning = false;
      return;
    }

    onProgress?.({ phase: 'start', total: pairs.length, msg: `Found ${pairs.length} pairs — scanning on ${tf.toUpperCase()}…` });

    // 2. Scan in batches
    const results = [];
    let done = 0;

    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      if (scanAborted) break;
      const batch  = pairs.slice(i, i + BATCH_SIZE);
      const batch_results = await Promise.all(batch.map(sym => scanCoin(sym, exchange, tf)));

      for (const r of batch_results) {
        done++;
        if (r && r.score >= 6) {
          results.push(r);
          onResult?.(r);
        }
        onProgress?.({
          phase:   'scanning',
          done,
          total:   pairs.length,
          msg:     `Scanning ${done} / ${pairs.length} pairs…`,
          partial: results.length,
        });
      }

      if (i + BATCH_SIZE < pairs.length) await sleep(BATCH_DELAY);
    }

    onDone?.({ results, total: pairs.length, aborted: scanAborted });
  } finally {
    scanRunning = false;
  }
}

function abortScan() {
  scanAborted = true;
}

// ══════════════════════════════════════════════════════════════
//  MULTI-TF COMMON SCAN
//  Scans all 5 timeframes sequentially, returns only coins that
//  score 6+/7 on EVERY timeframe (15m, 1h, 4h, 1d, 1w)
// ══════════════════════════════════════════════════════════════
const COMMON_TFS = ['15m', '1h', '4h', '1d', '1w'];

async function runMultiTFScan({ exchange, onProgress, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;

  try {
    // 1. Fetch pair list once — reused across all TFs
    onProgress?.({ phase: 'pairs', tf: null, msg: `Fetching pairs from ${exchange === 'bybit' ? 'Bybit' : 'Binance'}…` });
    let pairs;
    try {
      pairs = exchange === 'bybit' ? await fetchBybitPairs() : await fetchBinancePairs();
    } catch (e) {
      onError?.(`Failed to fetch pair list: ${e.message}`);
      scanRunning = false;
      return;
    }

    // tfResults: Map<symbol, { [tf]: result }>
    // qualifiedPerTF: Map<tf, Set<symbol>>
    const tfResults      = new Map(); // symbol → { tf: result, … }
    const qualifiedPerTF = new Map(); // tf → Set of symbols that passed

    // 2. Scan each TF sequentially
    for (const tf of COMMON_TFS) {
      if (scanAborted) break;

      onProgress?.({
        phase: 'tf-start',
        tf,
        msg:   `Scanning ${tf.toUpperCase()} (${COMMON_TFS.indexOf(tf) + 1}/${COMMON_TFS.length})…`,
      });

      const qualifiedThisTF = new Set();
      let done = 0;

      for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
        if (scanAborted) break;
        const batch = pairs.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(sym => scanCoin(sym, exchange, tf)));

        for (const r of batchResults) {
          done++;
          if (r && r.score >= 6) {
            qualifiedThisTF.add(r.symbol);
            if (!tfResults.has(r.symbol)) tfResults.set(r.symbol, {});
            tfResults.get(r.symbol)[tf] = r;
          }
        }

        onProgress?.({
          phase:   'scanning',
          tf,
          done,
          total:   pairs.length,
          msg:     `${tf.toUpperCase()} · ${done} / ${pairs.length} scanned · ${qualifiedThisTF.size} qualified`,
        });

        if (i + BATCH_SIZE < pairs.length) await sleep(BATCH_DELAY);
      }

      qualifiedPerTF.set(tf, qualifiedThisTF);
    }

    // 3. Intersect — only coins that qualified on ALL 5 TFs
    // Start with all symbols from first TF, intersect with each subsequent
    let commonSymbols = qualifiedPerTF.get(COMMON_TFS[0]) ? new Set(qualifiedPerTF.get(COMMON_TFS[0])) : new Set();
    for (const tf of COMMON_TFS.slice(1)) {
      const tfSet = qualifiedPerTF.get(tf) || new Set();
      for (const sym of commonSymbols) {
        if (!tfSet.has(sym)) commonSymbols.delete(sym);
      }
    }

    // 4. Build final result array
    const results = [];
    for (const sym of commonSymbols) {
      const tfData = tfResults.get(sym);
      if (!tfData) continue;

      // Use 1h data as the "primary" for price/bias display
      const primary = tfData['1h'] || tfData['4h'] || tfData['1d'] || Object.values(tfData)[0];

      // Total score = sum across all TFs (max 35)
      const totalScore = COMMON_TFS.reduce((s, tf) => s + (tfData[tf]?.score || 0), 0);

      // Consensus direction — majority across TFs
      const bullCount = COMMON_TFS.filter(tf => tfData[tf]?.primaryDir === 'bull').length;
      const bearCount = COMMON_TFS.filter(tf => tfData[tf]?.primaryDir === 'bear').length;
      const consensusDir = bullCount >= bearCount ? 'bull' : 'bear';

      results.push({
        symbol:       sym,
        exchange,
        tfData,          // { '15m': result, '1h': result, … }
        totalScore,      // out of 35
        consensusDir,
        price:        primary?.price,
        fundingRate:  primary?.fundingRate,
        rsi:          primary?.rsi,
        biasColor:    consensusDir === 'bull' ? '#00e676' : '#ff4444',
        biasLabel:    consensusDir === 'bull' ? '⬆ LONG' : '⬇ SHORT',
      });
    }

    // Sort by total score desc
    results.sort((a, b) => b.totalScore - a.totalScore);

    onDone?.({ results, total: pairs.length, aborted: scanAborted });
  } finally {
    scanRunning = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  HEATMAP RENDERER
// ══════════════════════════════════════════════════════════════
function renderHeatmap(container, results, tf) {
  if (!results.length) {
    container.innerHTML = `
      <div class="smc-empty">
        <div class="smc-empty-glyph">◎</div>
        <div>No coins scored 6+ gates on ${tf.toUpperCase()}</div>
        <div style="font-size:9px;color:var(--muted);margin-top:6px">Try a different timeframe or exchange</div>
      </div>`;
    return;
  }

  // Sort by score desc, then by bias direction (longs first within same score)
  const sorted = [...results].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aLong = a.primaryDir === 'bull' ? 1 : 0;
    const bLong = b.primaryDir === 'bull' ? 1 : 0;
    return bLong - aLong;
  });

  const scoreColor = s => {
    if (s === 7) return '#00e676';
    if (s === 6) return '#69f0ae';
    if (s === 5) return '#ffd54f';
    return '#ff8f00';
  };

  const cells = sorted.map(r => {
    const col   = scoreColor(r.score);
    const bgCol = r.score === 7 ? 'rgba(0,230,118,0.10)'
                : r.score === 6 ? 'rgba(105,240,174,0.07)'
                : r.score === 5 ? 'rgba(255,213,79,0.07)'
                : 'rgba(255,143,0,0.06)';

    const gateRows = r.gates.map(g => `
      <div class="smc-hover-gate ${g.pass ? 'gate-pass' : 'gate-fail'}">
        <span class="gate-icon">${g.pass ? '✓' : '✗'}</span>
        <span class="gate-label">${g.label}</span>
        <span class="gate-desc">${g.desc}</span>
      </div>`).join('');

    return `
      <div class="smc-cell" style="--cell-col:${col};--cell-bg:${bgCol}" data-score="${r.score}">
        <div class="smc-cell-inner">
          <div class="smc-cell-ticker">${r.symbol}</div>
          <div class="smc-cell-score" style="color:${col}">${r.score}/7</div>
          <div class="smc-cell-bias" style="color:${r.biasColor}">${r.biasLabel}</div>
          <div class="smc-cell-price">$${formatScanPrice(r.price)}</div>
        </div>
        <div class="smc-hover-card">
          <div class="smc-hover-header">
            <span class="smc-hover-sym">${r.symbol}/USDT</span>
            <span class="smc-hover-tf">${tf.toUpperCase()} · ${r.exchange === 'bybit' ? 'Bybit' : 'Binance'}</span>
          </div>
          <div class="smc-hover-price">$${formatScanPrice(r.price)}</div>
          <div class="smc-hover-bias" style="color:${r.biasColor}">${r.biasLabel}</div>
          <div class="smc-hover-stats">
            <span>Score <b style="color:${col}">${r.score}/7</b></span>
            <span>Funding <b style="color:${r.fundingRate < 0 ? '#00e676' : r.fundingRate > 0.05 ? '#ff4444' : '#ffd54f'}">${r.fundingRate?.toFixed(4)}%</b></span>
            <span>RSI <b>${r.rsi?.toFixed(1) ?? '—'}</b></span>
          </div>
          <div class="smc-hover-gates">${gateRows}</div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="smc-grid">${cells}</div>`;
}

function formatScanPrice(p) {
  if (!p) return '—';
  if (p >= 1000)  return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(3);
  if (p >= 0.01)  return p.toFixed(4);
  return p.toFixed(6);
}

export { runScan, abortScan, renderHeatmap, runMultiTFScan, COMMON_TFS };
