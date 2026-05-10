// ATL · Funding Rate Scanner (Phase 4)
// Phase 4 changes:
//   • fetchFundingInfo() called once at scan start — builds intervalHours Map
//   • Each result item gets `intervalHours` and `normRate` (8h-equivalent)
//   • formatFundingRate() updated to show normalised rate when interval ≠ 8h
//   • All scan logic (thresholds, abort, batching) unchanged

const BYBIT_BASE = 'https://api.bybit.com/v5/market';
const FAPI_BASE  = 'https://fapi.binance.com/fapi/v1';

const THRESHOLD_POS =  0.0005;  // +0.05% raw
const THRESHOLD_NEG = -0.0005;  // -0.05% raw

const BATCH_SIZE  = 30;
const BATCH_DELAY = 120; // ms

let scanAborted = false;
let scanRunning = false;

// ── Module-level funding info cache ───────────────────────────
// Map<symbolBase, intervalHours> — fetched once per scan session
let _fundingInfoCache = null;

// ── Utils ──────────────────────────────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Funding Info (interval per symbol) ───────────────────────
// FAPI /fundingInfo — fetched once, cached for the scan session.
// Returns Map<base, intervalHours>
async function fetchFundingInfo() {
  if (_fundingInfoCache) return _fundingInfoCache;
  try {
    const d   = await fetchJSON(`${FAPI_BASE}/fundingInfo`);
    const map = new Map();
    for (const item of (d || [])) {
      const base = item.symbol?.replace('USDT', '').toUpperCase() || '';
      const hrs  = parseFloat(item.fundingIntervalHours) || 8;
      map.set(base, hrs);
      map.set(item.symbol, hrs);
    }
    _fundingInfoCache = map;
    return map;
  } catch (e) {
    console.warn('fetchFundingInfo failed:', e.message);
    _fundingInfoCache = new Map();
    return _fundingInfoCache;
  }
}

// Helper: normalise raw rate to 8h equivalent
function normRate(rate, intervalHrs) {
  return rate * (8 / (intervalHrs || 8));
}

// ── Pair fetching ──────────────────────────────────────────────
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

// ── Single funding fetch ───────────────────────────────────────
async function fetchBybitFunding(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  const d   = await fetchJSON(`${BYBIT_BASE}/tickers?category=linear&symbol=${sym}`);
  if (d.retCode !== 0) throw new Error(d.retMsg);
  const t = d.result.list[0];
  return {
    rate:            parseFloat(t.fundingRate),
    nextFundingTime: parseInt(t.nextFundingTime),
    price:           parseFloat(t.lastPrice),
    markPrice:       parseFloat(t.markPrice),
  };
}

async function fetchBinanceFunding(symbol) {
  const sym = symbol.toUpperCase() + 'USDT';
  const d   = await fetchJSON(`${FAPI_BASE}/premiumIndex?symbol=${sym}`);
  return {
    rate:            parseFloat(d.lastFundingRate),
    nextFundingTime: parseInt(d.nextFundingTime),
    price:           parseFloat(d.markPrice),
    markPrice:       parseFloat(d.markPrice),
  };
}

// ── Batch processor ────────────────────────────────────────────
async function processBatch(symbols, exchange, fundingInfoMap, onResult, onProgress, doneOffset, totalPairs) {
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    if (scanAborted) return;
    const batch = symbols.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async sym => {
        const data = exchange === 'bybit'
          ? await fetchBybitFunding(sym)
          : await fetchBinanceFunding(sym);
        return { symbol: sym, exchange, ...data };
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const item        = r.value;
      const intervalHrs = fundingInfoMap.get(item.symbol) || fundingInfoMap.get(item.symbol.toUpperCase()) || 8;
      const norm        = normRate(item.rate, intervalHrs);

      if (item.rate >= THRESHOLD_POS || item.rate <= THRESHOLD_NEG) {
        onResult({
          ...item,
          intervalHours: intervalHrs,
          normRate:      norm,
        });
      }
    }

    const done = Math.min(doneOffset + i + BATCH_SIZE, totalPairs);
    onProgress({ done, total: totalPairs, msg: `Scanning ${exchange === 'bybit' ? 'Bybit' : 'Binance'}… ${done}/${totalPairs}` });

    if (i + BATCH_SIZE < symbols.length) await sleep(BATCH_DELAY);
  }
}

// ── Single exchange scan ───────────────────────────────────────
export async function runFundingScan({ exchange, onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;
  _fundingInfoCache = null; // reset cache each scan

  const results = [];

  try {
    onProgress({ done: 0, total: 0, msg: 'Fetching pairs + funding intervals…' });

    // Phase 4: fetch funding info FIRST, before pair loop
    const fundingInfoMap = await fetchFundingInfo();

    const pairs = exchange === 'bybit'
      ? await fetchBybitPairs()
      : await fetchBinancePairs();

    const total = pairs.length;
    onProgress({ done: 0, total, msg: `${total} pairs — scanning…` });

    await processBatch(
      pairs, exchange, fundingInfoMap,
      item => { results.push(item); onResult(item); },
      onProgress, 0, total
    );

    results.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
    onDone({ results, total, aborted: scanAborted });

  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

// ── Common scan (both exchanges) ───────────────────────────────
export async function runFundingCommonScan({ onProgress, onResult, onDone, onError }) {
  if (scanRunning) return;
  scanRunning = true;
  scanAborted = false;
  _fundingInfoCache = null;

  try {
    onProgress({ done: 0, total: 0, msg: 'Fetching pairs + funding intervals from both exchanges…' });

    // Phase 4: funding info first
    const fundingInfoMap = await fetchFundingInfo();

    const [bybitPairs, binancePairs] = await Promise.all([
      fetchBybitPairs(),
      fetchBinancePairs(),
    ]);

    const binanceSet = new Set(binancePairs.map(s => s.toUpperCase()));
    const common     = bybitPairs.filter(s => binanceSet.has(s.toUpperCase()));
    const total      = common.length * 2;
    let done         = 0;

    onProgress({ done: 0, total, msg: `${common.length} common pairs — scanning both exchanges…` });

    const bybitResults   = new Map();
    const binanceResults = new Map();

    for (let i = 0; i < common.length; i += BATCH_SIZE) {
      if (scanAborted) break;
      const batch = common.slice(i, i + BATCH_SIZE);

      const [bRes, nRes] = await Promise.all([
        Promise.allSettled(batch.map(async sym => {
          const d = await fetchBybitFunding(sym);
          return { symbol: sym, ...d };
        })),
        Promise.allSettled(batch.map(async sym => {
          const d = await fetchBinanceFunding(sym);
          return { symbol: sym, ...d };
        })),
      ]);

      bRes.forEach(r => { if (r.status === 'fulfilled') bybitResults.set(r.value.symbol, r.value); });
      nRes.forEach(r => { if (r.status === 'fulfilled') binanceResults.set(r.value.symbol, r.value); });

      done = Math.min(done + batch.length * 2, total);
      onProgress({ done, total, msg: `Scanning… ${Math.round(done / total * 100)}%` });

      if (i + BATCH_SIZE < common.length) await sleep(BATCH_DELAY);
    }

    // Build qualified pairs — must pass threshold on BOTH exchanges, same direction
    const qualified = [];
    for (const sym of common) {
      if (scanAborted) break;
      const bybit   = bybitResults.get(sym);
      const binance = binanceResults.get(sym);
      if (!bybit || !binance) continue;

      const br = bybit.rate;
      const nr = binance.rate;

      const bothPos = br >= THRESHOLD_POS && nr >= THRESHOLD_POS;
      const bothNeg = br <= THRESHOLD_NEG && nr <= THRESHOLD_NEG;

      if (bothPos || bothNeg) {
        const intervalHrs = fundingInfoMap.get(sym) || fundingInfoMap.get(sym.toUpperCase()) || 8;
        const avgRaw      = (br + nr) / 2;
        const avgNorm     = normRate(avgRaw, intervalHrs);

        const item = {
          symbol:          sym,
          bybitRate:       br,
          binanceRate:     nr,
          bybitPrice:      bybit.price,
          binancePrice:    binance.price,
          bybitNextTime:   bybit.nextFundingTime,
          binanceNextTime: binance.nextFundingTime,
          direction:       bothPos ? 'positive' : 'negative',
          avgRate:         avgRaw,
          // Phase 4 additions
          intervalHours:   intervalHrs,
          bybitNorm:       normRate(br, intervalHrs),
          binanceNorm:     normRate(nr, intervalHrs),
          avgNorm,
        };
        qualified.push(item);
        onResult(item);
      }
    }

    qualified.sort((a, b) => Math.abs(b.avgRate) - Math.abs(a.avgRate));
    onDone({ results: qualified, total: common.length, aborted: scanAborted });

  } catch (e) {
    onError(e.message);
  } finally {
    scanRunning = false;
  }
}

export function abortFundingScan() { scanAborted = true; }

// ── Helpers ────────────────────────────────────────────────────

// Phase 4: formatFundingRate now accepts optional intervalHours
// and shows the normalised 8h-equivalent when interval ≠ 8h
export function formatFundingRate(rate, intervalHours) {
  const raw     = (rate * 100).toFixed(4) + '%';
  const hrs     = intervalHours || 8;
  if (hrs === 8) return raw;
  const norm    = normRate(rate, hrs);
  return `${raw} (${(norm * 100).toFixed(4)}% per 8h)`;
}

export function fundingDirection(rate) {
  if (rate >= THRESHOLD_POS) return { label: 'POSITIVE', color: '#ff4444', bg: 'rgba(255,68,68,0.08)', desc: 'Longs paying shorts' };
  if (rate <= THRESHOLD_NEG) return { label: 'NEGATIVE', color: '#00e676', bg: 'rgba(0,230,118,0.08)', desc: 'Shorts paying longs' };
  return { label: 'NEUTRAL', color: '#5a6470', bg: 'transparent', desc: 'Balanced' };
}

export function timeToFunding(nextFundingTime) {
  if (!nextFundingTime) return '—';
  const diff = nextFundingTime - Date.now();
  if (diff <= 0) return 'Imminent';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
