// ATL Ticker Analyzer — API Module (Phase 4)
// Routing rules from API recon:
//   Bybit V5: primary for klines, OI, orderbook, funding, tickers, insurance, basis klines
//   FAPI:     primary for fundingRate, premiumIndex, mark price, fundingInfo
//   SPOT:     24hr stats
//   CoinGecko /simple/price: market cap for BTC/ETH/SOL (CORS-safe endpoint)

const API = {
  BYBIT:     'https://api.bybit.com/v5/market',
  FAPI:      'https://fapi.binance.com/fapi/v1',
  SPOT:      'https://api.binance.com/api/v3',
  COINGECKO: 'https://api.coingecko.com/api/v3',
};

// ── Timeframe map ──────────────────────────────────────────────
const TF_MAP = {
  '1m':  { bybit: '1',   fapi: '1m'  },
  '5m':  { bybit: '5',   fapi: '5m'  },
  '15m': { bybit: '15',  fapi: '15m' },
  '1h':  { bybit: '60',  fapi: '1h'  },
  '4h':  { bybit: '240', fapi: '4h'  },
  '1d':  { bybit: 'D',   fapi: '1d'  },
  '1w':  { bybit: 'W',   fapi: '1w'  },
};

// ── CoinGecko ID map for market cap (browser-safe coins only) ──
const CG_ID_MAP = {
  BTC:  'bitcoin',
  ETH:  'ethereum',
  SOL:  'solana',
  BNB:  'binancecoin',
  XRP:  'ripple',
  ADA:  'cardano',
  AVAX: 'avalanche-2',
  DOT:  'polkadot',
  LINK: 'chainlink',
  MATIC:'matic-network',
};

// ── Module-level funding info cache ───────────────────────────
// Populated once per session by fetchFundingInfo().
// Key: symbol (e.g. "BTCUSDT") → fundingIntervalHours (number)
let _fundingInfoCache = null;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
  return r.json();
}

// ═══════════════════════════════════════════════════════════════
//  EXISTING ENDPOINTS (unchanged)
// ═══════════════════════════════════════════════════════════════

// ── Klines ────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, limit = 300) {
  const tf  = TF_MAP[interval] || TF_MAP['1h'];
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.BYBIT}/kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return d.result.list.reverse().map(c => ({
      time:   Math.floor(Number(c[0]) / 1000),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch (e) {
    console.warn('Bybit kline failed, falling back to FAPI:', e.message);
    const url = `${API.FAPI}/klines?symbol=${sym}&interval=${tf.fapi}&limit=${limit}`;
    const d   = await fetchJSON(url);
    return d.map(c => ({
      time:   Math.floor(c[0] / 1000),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }
}

// ── Live Ticker ───────────────────────────────────────────────
async function fetchTicker(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.BYBIT}/tickers?category=linear&symbol=${sym}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    const t = d.result.list[0];
    return {
      price:        parseFloat(t.lastPrice),
      price24h:     parseFloat(t.price24hPcnt) * 100,
      high24h:      parseFloat(t.highPrice24h),
      low24h:       parseFloat(t.lowPrice24h),
      volume24h:    parseFloat(t.volume24h),
      turnover24h:  parseFloat(t.turnover24h),
      openInterest: parseFloat(t.openInterest),
      fundingRate:  parseFloat(t.fundingRate) * 100,
      markPrice:    parseFloat(t.markPrice),
      indexPrice:   parseFloat(t.indexPrice),
      source:       'Bybit',
    };
  } catch (e) {
    console.warn('Bybit ticker failed, using FAPI:', e.message);
    const [premIdx, spot24] = await Promise.all([
      fetchJSON(`${API.FAPI}/premiumIndex?symbol=${sym}`),
      fetchJSON(`${API.SPOT}/ticker/24hr?symbol=${sym}`),
    ]);
    return {
      price:        parseFloat(premIdx.markPrice),
      price24h:     parseFloat(spot24.priceChangePercent),
      high24h:      parseFloat(spot24.highPrice),
      low24h:       parseFloat(spot24.lowPrice),
      volume24h:    parseFloat(spot24.volume),
      turnover24h:  parseFloat(spot24.quoteVolume),
      openInterest: null,
      fundingRate:  parseFloat(premIdx.lastFundingRate) * 100,
      markPrice:    parseFloat(premIdx.markPrice),
      indexPrice:   parseFloat(premIdx.indexPrice),
      source:       'FAPI+SPOT',
    };
  }
}

// ── Order Book ────────────────────────────────────────────────
async function fetchOrderBook(symbol, depth = 50) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.BYBIT}/orderbook?category=linear&symbol=${sym}&limit=${depth}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return {
      bids:   d.result.b.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks:   d.result.a.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      source: 'Bybit',
    };
  } catch (e) {
    console.warn('Bybit OB failed, using FAPI:', e.message);
    const url = `${API.FAPI}/depth?symbol=${sym}&limit=${depth}`;
    const d   = await fetchJSON(url);
    return {
      bids:   d.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      asks:   d.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]),
      source: 'FAPI',
    };
  }
}

// ── OI History ────────────────────────────────────────────────
async function fetchOIHistory(symbol, interval = '1h', limit = 48) {
  const sym    = symbol.toUpperCase() + 'USDT';
  const period = { '5m':'5min','15m':'15min','1h':'1h','4h':'4h','1d':'1d','1w':'1w' }[interval] || '1h';
  try {
    const url = `${API.BYBIT}/open-interest?category=linear&symbol=${sym}&intervalTime=${period}&limit=${limit}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.timestamp) / 1000),
      oi:   parseFloat(r.openInterest),
    }));
  } catch (e) {
    console.warn('OI history unavailable:', e.message);
    return [];
  }
}

// ── Funding History ───────────────────────────────────────────
async function fetchFundingHistory(symbol, limit = 20) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const url = `${API.FAPI}/fundingRate?symbol=${sym}&limit=${limit}`;
    const d   = await fetchJSON(url);
    return d.map(r => ({
      time: Math.floor(r.fundingTime / 1000),
      rate: parseFloat(r.fundingRate) * 100,
    })).reverse();
  } catch (e) {
    console.warn('FAPI funding failed, using Bybit:', e.message);
    const url = `${API.BYBIT}/funding/history?category=linear&symbol=${sym}&limit=${limit}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) return [];
    return d.result.list.reverse().map(r => ({
      time: Math.floor(Number(r.execTime) / 1000),
      rate: parseFloat(r.fundingRate) * 100,
    }));
  }
}

// ── Premium Index ─────────────────────────────────────────────
async function fetchPremiumIndex(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d = await fetchJSON(`${API.FAPI}/premiumIndex?symbol=${sym}`);
    return {
      markPrice:       parseFloat(d.markPrice),
      indexPrice:      parseFloat(d.indexPrice),
      lastFundingRate: parseFloat(d.lastFundingRate) * 100,
      nextFundingTime: d.nextFundingTime,
      spread:          ((parseFloat(d.markPrice) - parseFloat(d.indexPrice)) / parseFloat(d.indexPrice)) * 100,
    };
  } catch (e) {
    return null;
  }
}

// ── Implied Vol ───────────────────────────────────────────────
async function fetchImpliedVol(symbol) {
  const base = symbol.toUpperCase();
  if (base !== 'BTC' && base !== 'ETH') return null;
  try {
    const url = `${API.BYBIT}/historical-volatility?category=option&baseCoin=${base}&period=7`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) return null;
    const list = d.result;
    if (!list?.length) return null;
    return {
      iv7d:  parseFloat(list[0]?.value || 0),
      iv30d: parseFloat(list[list.length - 1]?.value || 0),
    };
  } catch (e) {
    return null;
  }
}

// ── Agg Trades ────────────────────────────────────────────────
async function fetchAggTrades(symbol, limit = 100) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d     = await fetchJSON(`${API.FAPI}/aggTrades?symbol=${sym}&limit=${limit}`);
    const buys  = d.filter(t => !t.m).reduce((s, t) => s + parseFloat(t.q), 0);
    const sells = d.filter(t =>  t.m).reduce((s, t) => s + parseFloat(t.q), 0);
    const total = buys + sells;
    return {
      buyRatio:  total > 0 ? buys / total : 0.5,
      sellRatio: total > 0 ? sells / total : 0.5,
      takerBias: total > 0 ? ((buys - sells) / total) * 100 : 0,
    };
  } catch (e) {
    return { buyRatio: 0.5, sellRatio: 0.5, takerBias: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
//  PHASE 4 — NEW ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ── Insurance Fund ────────────────────────────────────────────
// Bybit /insurance?coin=BTC
// Returns last `limit` snapshots (newest first from API → we reverse).
// Each snapshot: { time, value (in coin units) }
// Stress flag: any single-bar drop > STRESS_DROP_PCT of fund value.
const INSURANCE_STRESS_PCT = 0.02; // 2% single-bar drop = stress event

async function fetchInsuranceFund(coin = 'BTC', limit = 50) {
  try {
    const url = `${API.BYBIT}/insurance?coin=${coin}`;
    const d   = await fetchJSON(url);
    if (d.retCode !== 0) throw new Error(d.retMsg);

    // API returns list newest-first; we want oldest-first for sparkline
    const raw = (d.result?.list || []).slice(0, limit).reverse();
    const history = raw.map(r => ({
      time:   Math.floor(Number(r.updatedTime) / 1000),
      value:  parseFloat(r.symbols[0]?.insuranceFund || r.insuranceFund || 0),
    }));

    if (!history.length) return null;

    const first = history[0].value;
    const last  = history[history.length - 1].value;
    const delta = last - first;
    const deltaPct = first > 0 ? (delta / first) * 100 : 0;

    // Detect stress bars: any bar where fund dropped > threshold
    let stressed   = false;
    let stressIdx  = -1;
    for (let i = 1; i < history.length; i++) {
      const drop = (history[i - 1].value - history[i].value) / history[i - 1].value;
      if (drop > INSURANCE_STRESS_PCT) {
        stressed  = true;
        stressIdx = i;
        break;
      }
    }

    return {
      coin,
      history,
      current:    last,
      delta,
      deltaPct,
      trend:      delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'flat',
      stressed,
      stressIdx,
    };
  } catch (e) {
    console.warn('Insurance fund unavailable:', e.message);
    return null;
  }
}

// ── Funding Info (interval per symbol) ───────────────────────
// FAPI /fundingInfo — returns fundingIntervalHours per symbol.
// Fetched once and cached. Used to normalise funding rate display.
// Returns Map<symbolBase, intervalHours>
async function fetchFundingInfo() {
  if (_fundingInfoCache) return _fundingInfoCache;
  try {
    const d   = await fetchJSON(`${API.FAPI}/fundingInfo`);
    const map = new Map();
    for (const item of (d || [])) {
      // symbol e.g. "BTCUSDT" → base "BTC"
      const base = item.symbol?.replace('USDT', '') || '';
      const hrs  = parseFloat(item.fundingIntervalHours) || 8;
      map.set(base.toUpperCase(), hrs);
      map.set(item.symbol, hrs); // also store full symbol key
    }
    _fundingInfoCache = map;
    return map;
  } catch (e) {
    console.warn('fetchFundingInfo failed:', e.message);
    _fundingInfoCache = new Map();
    return _fundingInfoCache;
  }
}

// Helper: normalise any funding rate to its 8h-equivalent
// rate: raw rate in % (e.g. 0.06 for 0.06%), intervalHours: 4 | 8 | etc.
function normaliseFundingRate(rate, intervalHours) {
  const h = intervalHours || 8;
  return rate * (8 / h);
}

// ── Basis History (mark − index over time) ───────────────────
// Fetches Bybit /premium-index-price-kline AND /mark-price-kline
// Aligns by timestamp, computes basis[i] = (mark - index) / index * 100
// interval: '15m' | '1h' | '4h' — use primary TF
async function fetchBasisHistory(symbol, interval = '1h', limit = 60) {
  const sym = symbol.toUpperCase() + 'USDT';
  const tf  = TF_MAP[interval] || TF_MAP['1h'];

  try {
    const [markRes, indexRes] = await Promise.all([
      fetchJSON(`${API.BYBIT}/mark-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
      fetchJSON(`${API.BYBIT}/index-price-kline?symbol=${sym}&interval=${tf.bybit}&limit=${limit}`),
    ]);

    if (markRes.retCode !== 0 || indexRes.retCode !== 0) throw new Error('Basis klines failed');

    // Both return [startTime, open, high, low, close] newest-first → reverse
    const markList  = (markRes.result?.list  || []).reverse();
    const indexList = (indexRes.result?.list || []).reverse();

    // Build lookup by timestamp for index prices
    const indexMap = new Map();
    for (const row of indexList) {
      indexMap.set(row[0], parseFloat(row[4])); // close
    }

    const basisHistory = [];
    for (const row of markList) {
      const markClose  = parseFloat(row[4]);
      const indexClose = indexMap.get(row[0]);
      if (indexClose == null || indexClose === 0) continue;
      const basis = ((markClose - indexClose) / indexClose) * 100;
      basisHistory.push({
        time:  Math.floor(Number(row[0]) / 1000),
        basis,
        mark:  markClose,
        index: indexClose,
      });
    }

    if (!basisHistory.length) return null;

    const values     = basisHistory.map(b => b.basis);
    const lastBasis  = values[values.length - 1];
    const maxBasis   = Math.max(...values);
    const minBasis   = Math.min(...values);

    // Slope: linear regression over last 12 bars
    const window = values.slice(-12);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n  = window.length;
    for (let i = 0; i < n; i++) {
      sumX  += i; sumY  += window[i];
      sumXY += i * window[i]; sumXX += i * i;
    }
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;

    const FLAT_THRESHOLD = 0.0003; // basis % per bar
    let direction;
    if      (slope >  FLAT_THRESHOLD) direction = 'expanding';
    else if (slope < -FLAT_THRESHOLD) direction = 'contracting';
    else                               direction = 'flat';

    return { history: basisHistory, lastBasis, maxBasis, minBasis, slope, direction };
  } catch (e) {
    console.warn('Basis history unavailable:', e.message);
    return null;
  }
}

// ── Book Ticker (best bid/ask spread) ─────────────────────────
// FAPI /ticker/bookTicker — single call, very fast
// Returns bestBid, bestAsk, spread %
async function fetchBookTicker(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  try {
    const d    = await fetchJSON(`${API.FAPI}/ticker/bookTicker?symbol=${sym}`);
    const bid  = parseFloat(d.bidPrice);
    const ask  = parseFloat(d.askPrice);
    const mid  = (bid + ask) / 2;
    const spread = mid > 0 ? ((ask - bid) / mid) * 100 : 0;
    return { bestBid: bid, bestAsk: ask, spread, source: 'FAPI' };
  } catch (e) {
    // Fallback: derive from Bybit orderbook top of book
    try {
      const url = `${API.BYBIT}/orderbook?category=linear&symbol=${sym}&limit=1`;
      const d   = await fetchJSON(url);
      if (d.retCode !== 0) throw new Error(d.retMsg);
      const bid  = parseFloat(d.result.b[0]?.[0] || 0);
      const ask  = parseFloat(d.result.a[0]?.[0] || 0);
      const mid  = (bid + ask) / 2;
      const spread = mid > 0 ? ((ask - bid) / mid) * 100 : 0;
      return { bestBid: bid, bestAsk: ask, spread, source: 'Bybit' };
    } catch {
      return null;
    }
  }
}

// ── Market Cap (CoinGecko simple/price — browser-safe) ────────
// Only works for coins in CG_ID_MAP. Returns null for others.
async function fetchMarketCap(symbol) {
  const base = symbol.toUpperCase().replace('USDT', '');
  const cgId = CG_ID_MAP[base];
  if (!cgId) return null;
  try {
    const url = `${API.COINGECKO}/simple/price?ids=${cgId}&vs_currencies=usd&include_market_cap=true`;
    const d   = await fetchJSON(url);
    const cap = d?.[cgId]?.usd_market_cap;
    return cap ? parseFloat(cap) : null;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MASTER FETCH — all data for a symbol (Phase 4 extended)
// ═══════════════════════════════════════════════════════════════
async function fetchAllData(symbol, primaryTF = '1h') {
  const [
    ticker,
    klinesLTF,
    klinesMTF,
    klinesHTF,
    orderBook,
    oiHistory,
    fundingHist,
    premIndex,
    impliedVol,
    takerFlow,
    // Phase 4 additions
    insuranceFund,
    basisHistory,
    bookTicker,
    marketCap,
    fundingInfo,
  ] = await Promise.allSettled([
    fetchTicker(symbol),
    fetchKlines(symbol, '15m', 200),
    fetchKlines(symbol, primaryTF, 300),
    fetchKlines(symbol, '4h', 200),
    fetchOrderBook(symbol, 50),
    fetchOIHistory(symbol, '1h', 48),
    fetchFundingHistory(symbol, 20),
    fetchPremiumIndex(symbol),
    fetchImpliedVol(symbol),
    fetchAggTrades(symbol, 200),
    // Phase 4
    fetchInsuranceFund('BTC', 50),
    fetchBasisHistory(symbol, primaryTF, 60),
    fetchBookTicker(symbol),
    fetchMarketCap(symbol),
    fetchFundingInfo(),
  ]);

  const resolve = r => r.status === 'fulfilled' ? r.value : null;

  return {
    // Existing
    ticker:       resolve(ticker),
    klinesLTF:    resolve(klinesLTF)    || [],
    klinesMTF:    resolve(klinesMTF)    || [],
    klinesHTF:    resolve(klinesHTF)    || [],
    orderBook:    resolve(orderBook),
    oiHistory:    resolve(oiHistory)    || [],
    fundingHist:  resolve(fundingHist)  || [],
    premIndex:    resolve(premIndex),
    impliedVol:   resolve(impliedVol),
    takerFlow:    resolve(takerFlow),
    // Phase 4
    insuranceFund:  resolve(insuranceFund),
    basisHistory:   resolve(basisHistory),
    bookTicker:     resolve(bookTicker),
    marketCap:      resolve(marketCap),
    fundingInfo:    resolve(fundingInfo) || new Map(),
  };
}

export {
  fetchAllData,
  fetchKlines,
  fetchTicker,
  fetchOrderBook,
  fetchOIHistory,
  fetchFundingHistory,
  // Phase 4 exports (used by funding-scanner.js and future phases)
  fetchInsuranceFund,
  fetchFundingInfo,
  fetchBasisHistory,
  fetchBookTicker,
  fetchMarketCap,
  normaliseFundingRate,
};
