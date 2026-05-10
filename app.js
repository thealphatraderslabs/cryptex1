// ATL Ticker Analyzer — Main App Controller (Phase 4)
// Phase 4 changes vs v3:
//   • import calcDerivScore from signals.js
//   • populateDerivativesPanel() fully rebuilt:
//       – Funding: normalised rate + interval tag + 8-bar history sparkline
//       – Basis: sparkline + slope direction + last basis %
//       – OI: money flow label (INFLOW/OUTFLOW/etc.) + OI/MCap ratio for BTC/ETH/SOL
//       – Insurance fund: current value + delta + trend tag + stress badge + sparkline
//       – Taker flow: derivScore gauge bar added below existing bar
//       – Order book: bid/ask spread row added
//   • renderBiasHero() injects derivScore sub-label into bias block
//   • All other functions unchanged

import { fetchAllData } from './api.js';
import { runAnalysis }  from './indicators.js';
import { generateSignal, generateMTFBias, calcDerivScore } from './signals.js';
import {
  initChart, initRSIChart, initMACDChart,
  setupOverlayCanvas, renderAll,
} from './chart.js';

// ── State ──────────────────────────────────────────────────────
let currentSymbol = '';
let currentTF     = '1h';
let isLoading     = false;
let rawData       = null;
let analysis      = null;
let signal        = null;

// ── DOM Refs ───────────────────────────────────────────────────
const dom = {
  searchInput:        () => document.getElementById('tickerInput'),
  searchBtn:          () => document.getElementById('analysisBtn'),
  tfSelect:           () => document.getElementById('tfSelect'),
  autoRefreshBtn:     () => document.getElementById('autoRefreshBtn'),
  refreshIntervalSel: () => document.getElementById('refreshIntervalSel'),
  loadingOverlay:     () => document.getElementById('loading-overlay'),
  loadingMsg:         () => document.getElementById('loading-sub-text'),
  errorBanner:        () => document.getElementById('error-banner'),
  errorText:          () => document.getElementById('error-text'),
  symbolDisplay:      () => document.getElementById('h-ticker'),
  priceDisplay:       () => document.getElementById('h-price'),
  change24h:          () => document.getElementById('h-change'),
  biasChip:           () => document.getElementById('h-bias'),
  scoreRing:          () => null,
  scoreNumber:        () => null,
  drawerPanel:        () => document.getElementById('drawer-panel'),
  drawerTitle:        () => document.getElementById('drawer-title'),
  drawerContent:      () => document.getElementById('drawer-content'),
  drawerClose:        () => document.getElementById('drawer-close'),
  chartContainer:     () => document.getElementById('chart-container'),
  rsiContainer:       () => document.getElementById('rsi-container'),
  macdContainer:      () => document.getElementById('macd-container'),
  volContainer:       () => document.getElementById('vol-profile-container'),
  fundingMini:        () => document.getElementById('funding-mini'),
  oiMini:             () => document.getElementById('oi-mini'),
  liqContainer:       () => document.getElementById('liq-mini'),
  statsBar:           () => document.getElementById('stats-bar'),
  refreshBtn:         () => document.getElementById('rail-refresh'),
  lastUpdated:        () => document.getElementById('last-updated'),
  dbBias:             () => document.getElementById('ds-bias'),
  dbEntry:            () => document.getElementById('ds-entry'),
  dbSL:               () => document.getElementById('ds-sl'),
  dbTP:               () => document.getElementById('ds-tp'),
  dbStruct:           () => document.getElementById('s-htf'),
  dbZone:             () => document.getElementById('s-zone'),
  dbInvalid:          () => document.getElementById('ds-invalid'),
  dbSlotBias:         () => document.getElementById('ds-bias-slot'),
  tabSetup:           () => document.getElementById('tab-setup'),
  tabStructure:       () => document.getElementById('tab-structure'),
  tabLevels:          () => document.getElementById('tab-levels'),
  tabDerivatives:     () => document.getElementById('tab-derivatives'),
};

// ── Loading ────────────────────────────────────────────────────
const LOADING_MSGS = [
  'Scanning exchange feeds…',
  'Fetching OHLCV candles…',
  'Pulling order book + basis klines…',
  'Fetching insurance fund data…',
  'Analyzing market structure…',
  'Detecting order blocks…',
  'Mapping FVGs…',
  'Computing derivatives intelligence…',
  'Running confluence engine…',
  'Generating trade setup…',
];
let loadMsgIdx = 0, loadMsgTimer = null;

function startLoadingCycle(msg) {
  stopLoadingCycle();
  const el = dom.loadingMsg();
  if (!el) return;
  el.textContent = msg || LOADING_MSGS[0];
  loadMsgIdx   = 0;
  loadMsgTimer = setInterval(() => {
    loadMsgIdx = (loadMsgIdx + 1) % LOADING_MSGS.length;
    if (el) el.textContent = LOADING_MSGS[loadMsgIdx];
  }, 900);
}
function stopLoadingCycle() {
  if (loadMsgTimer) { clearInterval(loadMsgTimer); loadMsgTimer = null; }
}
function setLoading(v, msg) {
  isLoading = v;
  const overlay = dom.loadingOverlay();
  if (!overlay) return;
  if (v) { overlay.classList.add('active'); startLoadingCycle(msg); }
  else   { overlay.classList.remove('active'); stopLoadingCycle(); }
}
function showError(msg) {
  const banner = dom.errorBanner();
  const text   = dom.errorText();
  if (!banner || !text) return;
  text.textContent = msg;
  banner.classList.add('visible');
  setTimeout(() => banner.classList.remove('visible'), 5000);
}

// ── Main Analysis Flow ─────────────────────────────────────────
async function analyze(symbol, tf = currentTF) {
  if (isLoading) return;
  if (!symbol || !symbol.trim()) return showError('Please enter a symbol (e.g. BTC)');

  symbol        = symbol.trim().toUpperCase().replace(/USDT$/i, '');
  currentSymbol = symbol;
  currentTF     = tf;

  setLoading(true);
  window.__atlSetStatus?.('loading');

  try {
    rawData  = await fetchAllData(symbol, tf);
    analysis = runAnalysis(rawData);

    if (!analysis) throw new Error('Insufficient candle data — try a different timeframe or symbol');

    signal = generateSignal(rawData, analysis);

    renderUI(symbol, rawData, analysis, signal);
    renderAll(
      analysis, rawData,
      dom.chartContainer(), dom.rsiContainer(), dom.macdContainer(),
      dom.volContainer(), dom.fundingMini(), dom.oiMini(), dom.liqContainer()
    );

    updateStatsBar(rawData, analysis);
    populateDecisionBar(analysis, signal);
    buildIntelTabs(analysis, signal, rawData);
    renderMiniCharts(rawData, analysis);
    updateLastUpdated();
    window.__atlSetStatus?.('live');

  } catch (err) {
    console.error(err);
    showError(err.message || 'Failed to fetch data. Check the symbol and try again.');
    window.__atlSetStatus?.('ready');
  } finally {
    setLoading(false);
  }
}

// ── Hero Strip ─────────────────────────────────────────────────
function renderUI(symbol, data, analysis, signal) {
  const ticker = data.ticker;
  const price  = ticker?.price || analysis.price;
  const chg    = ticker?.price24h || 0;

  const sd    = document.getElementById('h-ticker');
  const pd    = document.getElementById('h-price');
  const c24   = document.getElementById('h-change');
  const hHigh    = document.getElementById('h-high');
  const hLow     = document.getElementById('h-low');
  const hVol     = document.getElementById('h-vol');
  const hOI      = document.getElementById('h-oi');
  const hFunding = document.getElementById('h-funding');
  const hRSI     = document.getElementById('h-rsi');
  const hMark    = document.getElementById('h-mark');
  const hATR     = document.getElementById('h-atr');

  if (sd) sd.textContent = `${symbol} / USDT`;
  if (pd) pd.textContent = `$${formatPrice(price)}`;

  if (hHigh)    hHigh.textContent    = ticker ? `$${formatPrice(ticker.high24h)}` : '—';
  if (hLow)     hLow.textContent     = ticker ? `$${formatPrice(ticker.low24h)}` : '—';
  if (hVol)     hVol.textContent     = ticker ? formatLarge(ticker.turnover24h) + ' USDT' : '—';
  if (hOI)      hOI.textContent      = ticker?.openInterest ? formatLarge(ticker.openInterest) : '—';

  if (hFunding) {
    const fr = ticker?.fundingRate || 0;
    hFunding.textContent = `${fr.toFixed(4)}%`;
    hFunding.style.color = fr < -0.01 ? '#00e676' : fr > 0.05 ? '#ff4444' : '#ffd54f';
  }
  if (hRSI) {
    const rsi = analysis.lastRSI;
    hRSI.textContent = rsi != null ? rsi.toFixed(1) : '—';
    hRSI.style.color = rsi > 70 ? '#ff4444' : rsi < 30 ? '#00e676' : '#8892a0';
  }
  if (hMark) hMark.textContent = ticker ? `$${formatPrice(ticker.markPrice)}` : '—';
  if (hATR)  hATR.textContent  = analysis.lastATR ? `$${formatPrice(analysis.lastATR)}` : '—';

  if (c24) {
    c24.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    c24.className   = `ph-change ${chg >= 0 ? 'pos' : 'neg'}`;
  }

  if (signal) renderBiasHero(signal, rawData, analysis);
  renderScoreRing(signal?.normalizedScore || 0, signal?.biasColor || '#ffd54f');
}

// ── Bias Hero — Phase 4: injects derivScore sub-label ─────────
function renderBiasHero(signal, data, analysis) {
  const label    = signal.biasLabel || '—';
  const score    = signal.normalizedScore || 0;
  const scoreStr = `${score > 0 ? '+' : ''}${score}`;
  const isLong   = label.toLowerCase().includes('long');
  const isShort  = label.toLowerCase().includes('short');
  const color    = isLong ? '#00e676' : isShort ? '#ff4444' : '#ffd54f';

  const labelEl = document.getElementById('h-bias');
  const confEl  = document.getElementById('h-bias-conf');

  if (labelEl) {
    labelEl.textContent        = scoreStr;
    labelEl.style.color        = color;
    labelEl.style.fontSize     = '18px';
    labelEl.style.fontFamily   = 'var(--font-head)';
    labelEl.style.fontWeight   = '800';
    labelEl.style.letterSpacing = '0.05em';
  }

  // Phase 4: show derivScore + bias label stacked
  if (confEl && data && analysis) {
    const ds = calcDerivScore(data, analysis);
    confEl.innerHTML = `
      <span style="display:block;color:#5a6470;font-size:7px;font-family:var(--font-mono);letter-spacing:0.14em">${label}</span>
      <span style="display:block;color:${ds.derivColor};font-size:7px;font-family:var(--font-mono);letter-spacing:0.1em;margin-top:1px">
        DERIV ${ds.derivScore} · ${ds.derivLabel}
      </span>`;
  } else if (confEl) {
    confEl.textContent = label;
    confEl.style.color = '#5a6470';
    confEl.style.fontSize = '7px';
  }
}

function renderScoreRing(score, color) {
  const ring = dom.scoreRing();
  const num  = dom.scoreNumber();
  if (!ring || !num) return;
  const abs    = Math.abs(score);
  const offset = 283 - (abs / 100) * 283;
  ring.style.stroke           = color;
  ring.style.strokeDashoffset = offset;
  num.textContent = (score > 0 ? '+' : '') + score;
  num.style.color = color;
}

// ── Stats Bar ──────────────────────────────────────────────────
function updateStatsBar(data, analysis) {
  const bar = dom.statsBar();
  if (!bar) return;
  const t = data.ticker;
  const stats = [
    { label: 'Mark Price',    value: t ? `$${formatPrice(t.markPrice)}` : '—' },
    { label: 'Index Price',   value: t ? `$${formatPrice(t.indexPrice)}` : '—' },
    { label: 'Funding Rate',  value: t ? `${t.fundingRate.toFixed(4)}%` : '—', color: t?.fundingRate < 0 ? '#00e676' : t?.fundingRate > 0.05 ? '#ff4444' : '#8892a0' },
    { label: 'Open Interest', value: t?.openInterest ? formatLarge(t.openInterest) : '—' },
    { label: 'Volume 24H',    value: t ? formatLarge(t.turnover24h) + ' USDT' : '—' },
    { label: 'ATR (14)',      value: analysis.lastATR ? `$${formatPrice(analysis.lastATR)}` : '—' },
    { label: 'RSI (14)',      value: analysis.lastRSI != null ? analysis.lastRSI.toFixed(1) : '—', color: analysis.lastRSI > 70 ? '#ff4444' : analysis.lastRSI < 30 ? '#00e676' : '#8892a0' },
    { label: 'Structure',     value: analysis.structure?.trend || '—', color: analysis.structure?.trend === 'bull' ? '#00e676' : '#ff4444' },
    { label: 'Premium/Disc',  value: analysis.premDisc?.zone?.toUpperCase() || '—', color: analysis.premDisc?.zone === 'discount' ? '#00e676' : analysis.premDisc?.zone === 'premium' ? '#ff4444' : '#ffd54f' },
    { label: 'HTF Bias',      value: analysis.htfStructure?.trend || '—', color: analysis.htfStructure?.trend === 'bull' ? '#00e676' : '#ff4444' },
  ];
  bar.innerHTML = stats.map(s => `
    <div class="stat-item">
      <span class="stat-label">${s.label}</span>
      <span class="stat-value" style="color:${s.color || '#e8edf2'}">${s.value}</span>
    </div>`).join('');
}

// ── Decision Bar ───────────────────────────────────────────────
function populateDecisionBar(analysis, signal) {
  const s     = signal?.setup;
  const trend = analysis.structure?.trend || 'neutral';
  const pd    = analysis.premDisc;

  const biasEl = dom.dbBias();
  const slotEl = dom.dbSlotBias();
  if (biasEl) {
    biasEl.textContent = signal?.biasLabel || '—';
    biasEl.style.color = signal?.biasColor || '#8892a0';
  }
  if (slotEl) slotEl.style.borderBottomColor = signal?.biasColor || 'transparent';

  const entryEl = dom.dbEntry();
  if (entryEl) {
    entryEl.textContent = s ? `$${formatPrice(s.entry)}` : '—';
    entryEl.style.color = s ? (s.direction === 'LONG' ? '#00e676' : '#ff4444') : '#8892a0';
  }

  const slEl = dom.dbSL();
  if (slEl) slEl.textContent = s ? `$${formatPrice(s.sl)}` : '—';

  const tpEl = dom.dbTP();
  if (tpEl) {
    tpEl.textContent = s
      ? `$${formatPrice(s.tp1)} / $${formatPrice(s.tp2)} / $${formatPrice(s.tp3)}`
      : '— / — / —';
  }

  const structEl = dom.dbStruct();
  if (structEl) {
    const htf = analysis.htfStructure?.trend || '—';
    const mtf = trend;
    structEl.textContent = `MTF: ${mtf.toUpperCase()} · HTF: ${htf.toUpperCase()}`;
    structEl.style.color = mtf === 'bull' ? '#00e676' : mtf === 'bear' ? '#ff4444' : '#ffd54f';
  }

  const zoneEl = dom.dbZone();
  if (zoneEl && pd) {
    zoneEl.textContent = `${pd.zone.toUpperCase()} (${(pd.position * 100).toFixed(0)}%)`;
    zoneEl.style.color = pd.zone === 'discount' ? '#00e676' : pd.zone === 'premium' ? '#ff4444' : '#ffd54f';
  } else if (zoneEl) {
    zoneEl.textContent = '—';
  }

  const invEl = dom.dbInvalid();
  if (invEl) {
    invEl.textContent = s?.invalidationReason
      ? truncate(s.invalidationReason, 60)
      : 'No active setup — wait for structure confirmation';
  }
}

// ── Intel Tabs ─────────────────────────────────────────────────
function buildIntelTabs(analysis, signal, data) {
  populateDerivativesPanel(data, analysis);
  populateStructurePanel(analysis, signal);
  populateTradePanel(analysis, signal, data);
}

// ══════════════════════════════════════════════════════════════════
//  DERIVATIVES PANEL — Phase 4 full rebuild
//  Sections:
//    1. Funding Rate      (normalised + interval tag + history spark)
//    2. Basis / Spread    (basis sparkline + slope + live spread)
//    3. Open Interest     (money flow label + OI spark + OI/MCap)
//    4. Insurance Fund    (value + delta + trend + stress + sparkline)
//    5. Taker Flow        (existing bar + derivScore gauge)
//    6. Order Book        (existing walls + spread row)
// ══════════════════════════════════════════════════════════════════
function populateDerivativesPanel(data, analysis) {
  const t   = data.ticker;
  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) el.style.color = color;
  };

  // ── 1. FUNDING RATE ──────────────────────────────────────────
  const fr        = t?.fundingRate || 0;
  const sym       = currentSymbol.toUpperCase();
  const intervalHrs = data.fundingInfo?.get?.(sym) || 8;
  // normaliseFundingRate: rate * (8 / intervalHrs)
  const normFR    = fr * (8 / intervalHrs);
  const frColor   = normFR < -0.01 ? '#00e676' : normFR > 0.05 ? '#ff4444' : '#ffd54f';

  const frDisplay = intervalHrs !== 8
    ? `${fr.toFixed(4)}% · ${normFR.toFixed(4)}% per 8h`
    : `${fr.toFixed(4)}%`;

  const frExplain = normFR < -0.05 ? 'Extreme negative — short squeeze risk HIGH'
    : normFR < -0.01 ? 'Negative — shorts paying longs, mild bullish'
    : normFR > 0.1   ? 'Very high positive — long liquidation risk'
    : normFR > 0.03  ? 'Elevated positive — leverage flush risk'
    : 'Neutral — no significant pressure';

  set('d-funding',        frDisplay, frColor);
  set('d-funding-interp', frExplain, frColor);

  // Interval tag (shows funding interval if non-standard)
  const intTagEl = document.getElementById('d-funding-interval');
  if (intTagEl) {
    intTagEl.textContent  = intervalHrs !== 8 ? `${intervalHrs}h interval` : '8h interval';
    intTagEl.style.color  = intervalHrs !== 8 ? '#ffd54f' : '#5a6470';
  }

  // Next funding countdown
  const pm = data.premIndex;
  if (pm?.nextFundingTime) {
    const mins = Math.round((pm.nextFundingTime - Date.now()) / 60000);
    set('d-funding-t', `${mins}m`, '#8892a0');
  }

  // Funding history mini sparkline (8-bar inline SVG)
  renderFundingHistorySpark(data.fundingHist);

  // Funding history list
  const histEl = document.getElementById('funding-history-list');
  const hist   = data.fundingHist?.slice(-8) || [];
  if (histEl && hist.length) {
    histEl.innerHTML = hist.map(h => {
      const normR = h.rate * (8 / intervalHrs);
      const col   = h.rate < 0 ? '#00e676' : '#ff4444';
      const normTag = intervalHrs !== 8 ? ` <span style="color:#5a6470;font-size:8px">(${normR.toFixed(4)}% 8h)</span>` : '';
      return `<div class="deriv-row">
        <span class="deriv-key">${new Date(h.time * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        <span class="deriv-val" style="color:${col}">${h.rate.toFixed(4)}%${normTag}</span>
      </div>`;
    }).join('');
  }

  // ── 2. BASIS / SPREAD ────────────────────────────────────────
  const basisAna = analysis.basisAnalysis;

  if (basisAna) {
    const basisCol = basisAna.direction === 'expanding' ? '#ff9090'
      : basisAna.direction === 'contracting' ? '#00e676' : '#ffd54f';

    set('d-basis-val',       basisAna.basisStr || '—', basisCol);
    set('d-basis-direction', basisAna.label || '—',    basisCol);

    // Basis sparkline
    renderBasisSparkline(basisAna.history);
  } else {
    set('d-basis-val',       '—', '#5a6470');
    set('d-basis-direction', 'NO DATA', '#5a6470');
  }

  // Bid/Ask spread
  const bt = data.bookTicker;
  if (bt) {
    const spreadCol = bt.spread < 0.01 ? '#00e676' : bt.spread > 0.05 ? '#ff4444' : '#ffd54f';
    set('d-spread', `${bt.spread.toFixed(4)}%`, spreadCol);
  }
  // Mark/Index from premiumIndex
  if (pm) {
    set('d-mark',  `$${formatPrice(pm.markPrice)}`,  '#e8edf2');
    set('d-index', `$${formatPrice(pm.indexPrice)}`, '#e8edf2');
    // Keep existing spread fallback if no bookTicker
    if (!bt) {
      const spreadCol = pm.spread > 0 ? '#00e676' : '#ff4444';
      set('d-spread', `${pm.spread.toFixed(4)}%`, spreadCol);
    }
  }

  // ── 3. OPEN INTEREST ────────────────────────────────────────
  const oiData = data.oiHistory || [];
  const oiLen  = oiData.length;

  if (t?.openInterest) set('d-oi', formatLarge(t.openInterest), '#e8edf2');
  if (oiLen >= 2) {
    const rising = oiData[oiLen - 1].oi > oiData[0].oi;
    set('d-oi-trend', rising ? '▲ Rising' : '▼ Falling', rising ? '#00e676' : '#ff4444');
  }

  // Money flow label (Phase 4)
  const mf    = analysis.moneyFlow;
  const mfEl  = document.getElementById('d-money-flow');
  if (mfEl && mf) {
    mfEl.textContent = mf.label;
    mfEl.style.color = mf.color;
  }

  // OI/MCap ratio (BTC/ETH/SOL only)
  const mcapEl = document.getElementById('d-oi-mcap');
  if (mcapEl) {
    if (data.marketCap && t?.openInterest) {
      const oiUSD   = t.openInterest * (t.price || analysis.price || 1);
      const ratio   = (oiUSD / data.marketCap * 100).toFixed(2);
      const ratioColor = parseFloat(ratio) > 3 ? '#ff4444' : parseFloat(ratio) > 1.5 ? '#ffd54f' : '#00e676';
      mcapEl.textContent = `${ratio}%`;
      mcapEl.style.color = ratioColor;
    } else {
      mcapEl.textContent = '—';
      mcapEl.style.color = '#5a6470';
    }
  }

  // OI spark bars (existing)
  const spark = document.getElementById('oi-spark');
  if (spark && oiLen > 0) {
    const maxOI  = Math.max(...oiData.map(o => o.oi));
    const recent = oiData.slice(-24);
    spark.innerHTML = recent.map((o, i) => {
      const h      = Math.round((o.oi / maxOI) * 32);
      const rising = o.oi >= (oiData[oiData.indexOf(o) - 1]?.oi || o.oi);
      return `<div style="width:3px;height:${h}px;background:${rising ? '#00e676' : '#ff4444'};opacity:0.7;border-radius:1px"></div>`;
    }).join('');
  }

  // ── 4. INSURANCE FUND ────────────────────────────────────────
  renderInsuranceSection(data.insuranceFund, analysis.insuranceTrend);

  // ── 5. TAKER FLOW ────────────────────────────────────────────
  const tf = data.takerFlow;
  if (tf) {
    set('d-taker-bias',
      `${tf.takerBias > 0 ? '+' : ''}${tf.takerBias.toFixed(1)}%`,
      tf.takerBias > 0 ? '#00e676' : '#ff4444'
    );
    const takerBar = document.getElementById('d-taker-bar');
    const buyLbl   = document.getElementById('d-buy-pct');
    const sellLbl  = document.getElementById('d-sell-pct');
    if (takerBar) takerBar.style.width = `${(tf.buyRatio * 100).toFixed(0)}%`;
    if (buyLbl)   buyLbl.textContent   = `BUY ${(tf.buyRatio * 100).toFixed(0)}%`;
    if (sellLbl)  sellLbl.textContent  = `SELL ${(tf.sellRatio * 100).toFixed(0)}%`;
  }

  // derivScore gauge (Phase 4) — rendered below taker bar
  renderDerivScoreGauge(data, analysis);

  // ── 6. ORDER BOOK ────────────────────────────────────────────
  const ob = analysis.obAnalysis;
  if (ob) {
    set('d-ob-bias',
      ob.bias.toUpperCase(),
      ob.bias === 'bullish' ? '#00e676' : ob.bias === 'bearish' ? '#ff4444' : '#ffd54f'
    );
    const obBar  = document.getElementById('d-ob-bar');
    const bidLbl = document.getElementById('d-bid-pct');
    const askLbl = document.getElementById('d-ask-pct');
    if (obBar)  obBar.style.width  = `${(ob.bidAskRatio * 100).toFixed(0)}%`;
    if (bidLbl) bidLbl.textContent = `BID ${(ob.bidAskRatio * 100).toFixed(0)}%`;
    if (askLbl) askLbl.textContent = `ASK ${((1 - ob.bidAskRatio) * 100).toFixed(0)}%`;
    set('d-bid-walls', ob.bidWalls.slice(0, 3).map(w => `$${formatPrice(w.price)} (${w.size.toFixed(1)})`).join(' · ') || '—', '#00e676');
    set('d-ask-walls', ob.askWalls.slice(0, 3).map(w => `$${formatPrice(w.price)} (${w.size.toFixed(1)})`).join(' · ') || '—', '#ff4444');
  }

  // Liquidation clusters (unchanged)
  renderLiqClusters(analysis);
}

// ── Insurance Fund section renderer ────────────────────────────
function renderInsuranceSection(insuranceFund, insuranceTrend) {
  const container = document.getElementById('d-insurance-section');
  if (!container) return;

  if (!insuranceFund || !insuranceTrend || insuranceTrend.trend === 'unknown') {
    container.innerHTML = `
      <div class="deriv-row">
        <span class="deriv-key">BTC Fund</span>
        <span class="deriv-val" style="color:#5a6470">UNAVAILABLE</span>
      </div>`;
    return;
  }

  const { current, deltaPct, trend, history } = insuranceFund;
  const { label, color, stressed, stressLabel } = insuranceTrend;

  const deltaSign  = deltaPct >= 0 ? '+' : '';
  const deltaColor = deltaPct >= 0 ? '#00e676' : '#ff4444';

  container.innerHTML = `
    ${stressed ? `
    <div style="padding:4px 10px;background:rgba(255,68,68,0.08);border-bottom:1px solid rgba(255,68,68,0.2)">
      <span style="color:#ff4444;font-size:8px;letter-spacing:0.1em">⚠ STRESS EVENT DETECTED</span>
      <span style="display:block;color:#ff9090;font-size:7px;margin-top:1px">${stressLabel}</span>
    </div>` : ''}
    <div class="deriv-row">
      <span class="deriv-key">BTC Fund</span>
      <span class="deriv-val">${formatLarge(current)} BTC</span>
    </div>
    <div class="deriv-row">
      <span class="deriv-key">48h Delta</span>
      <span class="deriv-val" style="color:${deltaColor}">${deltaSign}${deltaPct.toFixed(3)}%</span>
    </div>
    <div class="deriv-row">
      <span class="deriv-key">Trend</span>
      <span class="deriv-val" style="color:${color}">${label}</span>
    </div>
    <div class="oi-spark-wrap">
      <div class="oi-spark-label">INSURANCE FUND — 48 PERIODS</div>
      <div id="insurance-spark" class="oi-spark-bars" style="height:28px"></div>
    </div>`;

  // Render insurance sparkline
  const sparkEl = document.getElementById('insurance-spark');
  if (sparkEl && history?.length) {
    const maxVal = Math.max(...history.map(h => h.value));
    const minVal = Math.min(...history.map(h => h.value));
    const range  = maxVal - minVal || 1;
    sparkEl.innerHTML = history.slice(-32).map((h, i, arr) => {
      const heightPct = Math.round(((h.value - minVal) / range) * 22) + 4;
      const prev      = arr[i - 1];
      const rising    = !prev || h.value >= prev.value;
      const isStress  = insuranceTrend.stressIdx > 0 && i === insuranceTrend.stressIdx;
      return `<div style="width:3px;height:${heightPct}px;background:${isStress ? '#ff4444' : rising ? '#00e676' : '#ff9090'};opacity:${isStress ? 1 : 0.7};border-radius:1px"></div>`;
    }).join('');
  }
}

// ── Funding history sparkline (8-bar inline) ───────────────────
function renderFundingHistorySpark(fundingHist) {
  const el = document.getElementById('d-funding-spark');
  if (!el || !fundingHist?.length) return;
  const vals   = fundingHist.slice(-8).map(h => h.rate);
  const maxAbs = Math.max(...vals.map(Math.abs)) || 0.01;
  el.innerHTML = vals.map(v => {
    const h   = Math.round((Math.abs(v) / maxAbs) * 20) + 2;
    const col = v < 0 ? '#00e676' : '#ff4444';
    return `<div style="width:6px;height:${h}px;background:${col};opacity:0.8;border-radius:1px;flex-shrink:0"></div>`;
  }).join('');
}

// ── Basis Sparkline ────────────────────────────────────────────
function renderBasisSparkline(basisHistory) {
  const el = document.getElementById('d-basis-spark');
  if (!el || !basisHistory?.length) return;
  const vals = basisHistory.map(b => b.basis);
  svgSparkline(el, vals, '#40c4ff', 0.15);
}

// ── derivScore Gauge (0–100 bar below taker section) ──────────
function renderDerivScoreGauge(data, analysis) {
  const el = document.getElementById('d-deriv-score-gauge');
  if (!el) return;

  const ds = calcDerivScore(data, analysis);

  // Component breakdown — compact rows
  const compRows = Object.entries(ds.components).map(([k, c]) => {
    const barW = c.score;
    const col  = c.score >= 60 ? '#00e676' : c.score <= 40 ? '#ff4444' : '#ffd54f';
    return `<div style="display:flex;align-items:center;gap:6px;padding:2px 10px">
      <span style="font-size:8px;color:#5a6470;width:66px;flex-shrink:0">${c.label}</span>
      <div style="flex:1;height:3px;background:var(--bg4)">
        <div style="width:${barW}%;height:100%;background:${col};transition:width 0.4s"></div>
      </div>
      <span style="font-size:8px;color:${col};width:24px;text-align:right;font-family:var(--font-mono)">${c.score}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:5px 10px 3px;display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:8px;color:#5a6470;letter-spacing:0.12em;text-transform:uppercase">DERIV SCORE</span>
      <span style="font-size:13px;font-weight:700;color:${ds.derivColor};font-family:var(--font-head)">${ds.derivScore}</span>
    </div>
    <div style="padding:0 10px 4px">
      <div style="height:5px;background:var(--bg4);position:relative;overflow:hidden">
        <div style="width:${ds.derivScore}%;height:100%;background:${ds.derivColor};transition:width 0.5s;border-radius:0"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:2px">
        <span style="font-size:7px;color:#5a6470">BEAR</span>
        <span style="font-size:8px;color:${ds.derivColor};font-family:var(--font-mono);letter-spacing:0.06em">${ds.derivLabel}</span>
        <span style="font-size:7px;color:#5a6470">BULL</span>
      </div>
    </div>
    ${compRows}`;
}

// ── Liquidation Clusters renderer (unchanged) ─────────────────
function renderLiqClusters(analysis) {
  const el  = document.getElementById('liq-container');
  if (!el) return;

  const liq   = analysis?.liqLevels;
  const price = analysis?.price;

  if (!liq || !price) {
    el.innerHTML = `<div class="empty-state" style="height:50px;font-size:8px">NO DATA</div>`;
    return;
  }

  const { shortLiqs, longLiqs } = liq;
  const shorts = [...shortLiqs].sort((a, b) => a.price - b.price).slice(0, 4);
  const longs  = [...longLiqs].sort((a, b) => b.price - a.price).slice(0, 4);

  const allDists = [...shorts, ...longs].map(l => Math.abs(l.price - price));
  const maxDist  = Math.max(...allDists) || 1;

  function barRow(item, side) {
    const dist   = Math.abs(item.price - price);
    const pct    = ((item.price - price) / price * 100);
    const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    const barW   = Math.round((dist / maxDist) * 100);
    const col    = side === 'short' ? '#ff4444' : '#00e676';
    const bg     = side === 'short' ? 'rgba(255,68,68,0.1)' : 'rgba(0,230,118,0.1)';
    return `
      <div class="liq-cluster-row">
        <span class="liq-cluster-label">${item.label}</span>
        <div class="liq-cluster-bar-wrap">
          <div class="liq-cluster-bar" style="width:${barW}%;background:${col};opacity:0.7"></div>
        </div>
        <span class="liq-cluster-pct" style="color:${col}">${pctStr}</span>
        <span class="liq-cluster-side" style="color:${col};background:${bg}">
          ${side === 'short' ? 'SHORT' : 'LONG'}
        </span>
      </div>`;
  }

  el.innerHTML = `
    <div class="liq-cluster-note">ILLUSTRATIVE — NOT LIVE DATA</div>
    ${shorts.map(l => barRow(l, 'short')).join('')}
    <div class="liq-cluster-divider"></div>
    ${longs.map(l => barRow(l, 'long')).join('')}
  `;
}

// ══════════════════════════════════════════════════════════════════
//  STRUCTURE PANEL (unchanged from v3)
// ══════════════════════════════════════════════════════════════════
function populateStructurePanel(analysis, signal) {
  const set = (id, val, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (color) el.style.color = color;
  };

  const st       = analysis.structure;
  const htf      = analysis.htfStructure;
  const trend    = st?.trend || 'neutral';
  const tCol     = trend === 'bull' ? '#00e676' : trend === 'bear' ? '#ff4444' : '#ffd54f';
  const htfTrend = htf?.trend || 'neutral';
  const htfCol   = htfTrend === 'bull' ? '#00e676' : htfTrend === 'bear' ? '#ff4444' : '#ffd54f';
  const price    = analysis.price;

  set('s-trend', trend.toUpperCase(), tCol);
  const emas    = analysis.lastEMAs;
  const emaBias = emas && price
    ? (price > emas.ema20 && price > emas.ema50 ? 'Above EMA20/50' : price < emas.ema20 && price < emas.ema50 ? 'Below EMA20/50' : 'Mixed EMA position')
    : '—';
  set('s-trend-sub', emaBias, '#8892a0');

  set('s-htf',     `MTF: ${trend.toUpperCase()} · HTF: ${htfTrend.toUpperCase()}`, tCol);
  set('s-htf-sub', htf ? `4H: ${htfTrend}` : 'HTF data unavailable', htfCol);

  const events   = st?.events || [];
  const lastEv   = events[events.length - 1];
  const structEl = document.getElementById('s-struct');
  if (structEl) {
    if (lastEv) {
      const cls = lastEv.type === 'CHoCH' ? 'tag-warn' : lastEv.dir === 'bull' ? 'tag-bull' : 'tag-bear';
      structEl.innerHTML = `<span class="tag ${cls}">${lastEv.type}</span>`;
    } else {
      structEl.innerHTML = `<span class="tag neutral">NONE</span>`;
    }
  }
  set('s-struct-sub', lastEv ? `$${formatPrice(lastEv.price)} — ${lastEv.dir === 'bull' ? 'Bullish' : 'Bearish'}` : 'No events detected', '#8892a0');

  const pd = analysis.premDisc;
  if (pd) {
    set('s-zone',     pd.zone.toUpperCase(), pd.zone === 'discount' ? '#00e676' : pd.zone === 'premium' ? '#ff4444' : '#ffd54f');
    set('s-zone-sub', `${(pd.position * 100).toFixed(1)}% of range`, '#8892a0');
  }

  const pivH = analysis.pivotHighs?.slice(-1)[0];
  const pivL = analysis.pivotLows?.slice(-1)[0];
  if (pivH) { set('s-sh', `$${formatPrice(pivH.price)}`, '#ff4444'); set('s-sh-sub', new Date(pivH.time * 1000).toLocaleDateString(), '#8892a0'); }
  if (pivL) { set('s-sl', `$${formatPrice(pivL.price)}`, '#00e676'); set('s-sl-sub', new Date(pivL.time * 1000).toLocaleDateString(), '#8892a0'); }

  const obEl     = document.getElementById('ob-container');
  const obs      = analysis.orderBlocks || [];
  const freshOBs = obs.filter(o => o.state === 'fresh');
  if (obEl) {
    if (freshOBs.length) {
      obEl.innerHTML = freshOBs.slice(0, 5).map(ob => {
        const mid     = (ob.low + ob.high) / 2;
        const distPct = ((mid - price) / price * 100);
        const distStr = `${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%`;
        const distCol = distPct >= 0 ? '#00e676' : '#ff4444';
        return `<div class="ob-card ${ob.type === 'demand' ? 'ob-card-bull' : 'ob-card-bear'}">
          <span class="tag ${ob.type === 'demand' ? 'tag-bull' : 'tag-bear'}">${ob.type === 'demand' ? 'BULL OB' : 'BEAR OB'}</span>
          <span class="ob-range">$${formatPrice(ob.low)} – $${formatPrice(ob.high)}</span>
          <span class="ob-struct">${ob.structureType}</span>
          <span style="font-size:9px;color:${distCol};font-family:var(--font-mono);margin-left:auto">${distStr}</span>
        </div>`;
      }).join('');
    } else {
      obEl.innerHTML = `<div class="empty-state" style="height:40px;font-size:8px">NO FRESH OBs DETECTED</div>`;
    }
  }

  const fvgEl  = document.getElementById('fvg-list');
  const fvgCnt = document.getElementById('fvg-count');
  const fvgs   = analysis.fvgs || [];
  if (fvgCnt) fvgCnt.textContent = `${fvgs.length} ACTIVE`;
  if (fvgEl) {
    if (fvgs.length) {
      fvgEl.innerHTML = fvgs.slice(-6).reverse().map(f => {
        const filled = (f.dir === 'bull' && price > f.top) || (f.dir === 'bear' && price < f.bottom);
        const statusLabel = filled ? 'FILLED' : 'OPEN';
        const statusColor = filled ? '#5a6470' : '#00e676';
        return `<div class="fvg-row ${f.dir === 'bull' ? 'fvg-bull' : 'fvg-bear'}">
          <span class="tag ${f.dir === 'bull' ? 'tag-bull' : 'tag-bear'}">${f.dir === 'bull' ? 'BFVG' : 'SFVG'}</span>
          <span class="fvg-range">$${formatPrice(f.bottom)} – $${formatPrice(f.top)}</span>
          <span class="fvg-size">${f.size.toFixed(2)}%</span>
          <span style="font-size:8px;color:${statusColor};letter-spacing:0.06em;margin-left:auto">${statusLabel}</span>
        </div>`;
      }).join('');
    } else {
      fvgEl.innerHTML = `<div class="empty-state" style="height:30px;font-size:8px">NO ACTIVE FVGs</div>`;
    }
  }

  const srEl = document.getElementById('sr-levels');
  const sr   = analysis.srLevels || [];
  if (srEl && sr.length) {
    const sorted = [...sr].sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    srEl.innerHTML = sorted.slice(0, 8).map(l => {
      const pct = ((l.price - price) / price * 100).toFixed(2);
      const col = l.type === 'support' ? '#00e676' : '#ff4444';
      return `<div class="sr-chip" style="border-color:${col}20">
        <span style="color:${col};font-size:8px">${l.type === 'support' ? 'S' : 'R'}</span>
        <span>$${formatPrice(l.price)}</span>
        <span style="color:#5a6470">${pct > 0 ? '+' : ''}${pct}%</span>
      </div>`;
    }).join('');
  }

  renderMTFBiasTable(analysis, rawData);
}

// ── MTF Bias Table renderer (unchanged) ───────────────────────
function renderMTFBiasTable(analysis, data) {
  const el = document.getElementById('mtf-bias-table');
  if (!el) return;

  const rows = generateMTFBias(analysis, data);

  const trendTag = (trend, tf) => {
    if (!trend || trend === '—') return `<span style="color:#5a6470">—</span>`;
    const isBull     = trend === 'bull';
    const bg         = isBull ? 'rgba(0,230,118,0.12)' : 'rgba(255,68,68,0.12)';
    const col        = isBull ? '#00e676' : '#ff4444';
    const isCurrent  = tf === currentTF.toUpperCase();
    return `<span style="display:inline-block;padding:1px 6px;background:${bg};color:${col};font-size:8px;font-weight:600;letter-spacing:0.06em">${trend.toUpperCase()}${isCurrent ? ' ◀' : ''}</span>`;
  };

  el.innerHTML = `
    <div class="panel-hd panel-hd-inner">
      <span class="panel-hd-label">MULTI-TIMEFRAME BIAS</span>
    </div>
    <div class="mtf-table">
      <div class="mtf-header-row">
        <span class="mtf-col-tf">TF</span>
        <span class="mtf-col-trend">TREND</span>
        <span class="mtf-col-struct">STRUCTURE</span>
        <span class="mtf-col-level">KEY LEVEL</span>
        <span class="mtf-col-dist">DIST%</span>
      </div>
      ${rows.map(r => {
        const levelStr = r.keyLevel ? `$${formatPrice(r.keyLevel.price)}` : '—';
        const distStr  = r.distPct != null ? `${r.distPct >= 0 ? '+' : ''}${r.distPct.toFixed(2)}%` : '—';
        const distCol  = r.distPct == null ? '#5a6470' : r.distPct >= 0 ? '#00e676' : '#ff4444';
        return `<div class="mtf-row">
          <span class="mtf-col-tf">${r.tf}</span>
          <span class="mtf-col-trend">${trendTag(r.trend, r.tf)}</span>
          <span class="mtf-col-struct">${r.structure !== '—'
            ? `<span class="tag tag-bos" style="font-size:7px">${r.structure}</span>`
            : '<span style="color:#5a6470">—</span>'}</span>
          <span class="mtf-col-level">${levelStr}</span>
          <span class="mtf-col-dist" style="color:${distCol}">${distStr}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
//  TRADE PANEL (unchanged from v3)
// ══════════════════════════════════════════════════════════════════
function populateTradePanel(analysis, signal, data) {
  const wrap = document.getElementById('scenarios-wrap');
  if (!wrap) return;

  const s = signal?.setup;

  if (!s) {
    wrap.innerHTML = `
      <div class="empty-state" style="padding:24px 16px;text-align:center">
        <div class="empty-glyph">⏳</div>
        <div style="color:#ffd54f;font-size:10px;margin:8px 0 4px">NO SETUP — CONFLUENCE INSUFFICIENT</div>
        <div style="color:#5a6470;font-size:8px">Score: ${signal?.normalizedScore || 0} · ${signal?.biasLabel || 'NEUTRAL'}</div>
        <div style="color:#5a6470;font-size:8px;margin-top:3px">Wait for BOS/CHoCH + OB retest + FVG fill</div>
      </div>
      ${buildConfluenceBars(signal)}`;
    return;
  }

  const isLong   = s.direction === 'LONG';
  const dirColor = isLong ? '#00e676' : '#ff4444';
  const scoreStr = `${signal.normalizedScore > 0 ? '+' : ''}${signal.normalizedScore}`;

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:${isLong ? 'rgba(0,230,118,0.05)' : 'rgba(255,68,68,0.05)'};border-bottom:1px solid var(--border)">
      <span style="color:${dirColor};font-family:var(--font-head);font-weight:700;font-size:14px;letter-spacing:0.1em">${isLong ? '⬆ LONG' : '⬇ SHORT'}</span>
      <span style="color:${signal.biasColor};font-family:var(--font-mono);font-size:11px">Score: ${scoreStr}</span>
    </div>
    <div class="trade-level-card" style="border-left:3px solid ${dirColor}">
      <div class="tlc-label">ENTRY</div>
      <div class="tlc-price" style="color:${dirColor}">$${formatPrice(s.entry)}</div>
      <div class="tlc-reason">${s.entryReason}</div>
    </div>
    <div class="trade-level-card" style="border-left:3px solid #ff4444">
      <div class="tlc-label">STOP LOSS</div>
      <div class="tlc-price" style="color:#ff4444">$${formatPrice(s.sl)}</div>
      <div class="tlc-reason">${s.slReason}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--border);border-top:1px solid var(--border)">
      ${[
        { label: `TP1 — ${s.rr1}R`, price: s.tp1, reason: s.tp1Reason },
        { label: `TP2 — ${s.rr2}R`, price: s.tp2, reason: s.tp2Reason },
        { label: `TP3 — ${s.rr3}R`, price: s.tp3, reason: s.tp3Reason },
      ].map(tp => `
        <div style="background:var(--bg2);padding:8px 6px;min-width:0;overflow:hidden">
          <div style="font-size:7px;color:#5a6470;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${tp.label}</div>
          <div style="font-size:11px;color:#00e676;font-family:var(--font-mono);font-weight:600;word-break:break-all;line-height:1.3">$${formatPrice(tp.price)}</div>
          <div style="font-size:8px;color:#8892a0;margin-top:2px;line-height:1.5">${tp.reason}</div>
        </div>`).join('')}
    </div>
    <div style="padding:6px 14px;border-bottom:1px solid var(--border);display:flex;gap:16px">
      <span style="font-size:9px;color:#5a6470">ATR (14): <span style="color:#ffd54f">${analysis.lastATR ? '$' + formatPrice(analysis.lastATR) : '—'}</span></span>
      <span style="font-size:9px;color:#5a6470">2× ATR: <span style="color:#ffd54f">${analysis.lastATR ? '$' + formatPrice(analysis.lastATR * 2) : '—'}</span></span>
    </div>
    <div style="padding:10px 14px;background:rgba(255,68,68,0.04);border-bottom:1px solid rgba(255,68,68,0.12)">
      <div style="font-size:8px;color:#ff9090;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">⚠ INVALIDATION</div>
      <div style="font-size:9px;color:#8892a0;line-height:1.6">${s.invalidationReason}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border-bottom:1px solid var(--border)">
      <div style="background:var(--bg2);padding:10px 12px">
        <div style="font-size:8px;color:#00e676;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">BULL SCENARIO</div>
        <div style="font-size:9px;color:#8892a0;line-height:1.6">${s.bullScenario}</div>
      </div>
      <div style="background:var(--bg2);padding:10px 12px">
        <div style="font-size:8px;color:#ff4444;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:5px">BEAR SCENARIO</div>
        <div style="font-size:9px;color:#8892a0;line-height:1.6">${s.bearScenario}</div>
      </div>
    </div>
    <div style="padding:4px 0">
      ${buildConfluenceTable(signal)}
    </div>`;

  const confHd = document.getElementById('conf-hd');
  const confBd = document.getElementById('conf-breakdown');
  if (confHd) confHd.style.display = 'none';
  if (confBd) confBd.style.display = 'none';
}

function buildConfluenceBars(signal) {
  if (!signal?.scores) return '<div style="padding:8px 12px;font-size:8px;color:#5a6470">No confluence data</div>';
  return `
    <div style="padding:8px 12px">
      ${Object.entries(signal.scores).map(([k, s]) => `
        <div class="conf-bar-row">
          <span class="conf-label">${k}</span>
          <div class="conf-bar-wrap">
            <div class="conf-bar-fill" style="width:${Math.abs(s.score / 2) * 100}%;background:${s.score > 0 ? '#00e676' : s.score < 0 ? '#ff4444' : '#5a6470'}"></div>
          </div>
          <span class="conf-score" style="color:${s.score > 0 ? '#00e676' : s.score < 0 ? '#ff4444' : '#5a6470'}">${s.score > 0 ? '+' : ''}${s.score.toFixed(1)}</span>
        </div>`).join('')}
    </div>`;
}

function buildConfluenceTable(signal) {
  if (!signal?.scores) return '';
  const items = Object.entries(signal.scores).map(([k, s]) => {
    const aligned    = s.score > 0;
    const neutral    = s.score === 0;
    const col        = aligned ? '#00e676' : neutral ? '#5a6470' : '#ff4444';
    const statusLbl  = aligned ? 'ALIGNED' : neutral ? 'NEUTRAL' : 'AGAINST';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 14px;border-bottom:1px solid rgba(255,255,255,0.04)">
      <span style="font-size:9px;color:#8892a0;text-transform:capitalize">${k}</span>
      <span style="font-size:8px;color:${col};letter-spacing:0.08em">${statusLbl}</span>
    </div>`;
  });
  return `
    <div style="padding:0">
      <div style="padding:4px 14px;font-size:8px;color:#5a6470;letter-spacing:0.12em;text-transform:uppercase;background:var(--bg3);border-bottom:1px solid var(--border)">SMC CONFLUENCE CHECKLIST</div>
      ${items.join('')}
    </div>`;
}

function buildReasonBlock(reasons, label) {
  if (!reasons?.length) return '';
  return `
    <div class="tab-block">
      <div class="tab-block-label">${label}</div>
      ${reasons.map(r => `<div class="drawer-reason">▸ ${r}</div>`).join('')}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════
//  LEGACY TAB FUNCTIONS (unchanged)
// ══════════════════════════════════════════════════════════════════
function populateTabSetup(analysis, signal, data)     { populateTradePanel(analysis, signal, data); }
function populateTabDerivatives(data, analysis, signal) { populateDerivativesPanel(data, analysis); }

function populateTabStructure(analysis, signal) {
  const pane = dom.tabStructure();
  if (!pane) return;

  const trend      = analysis.structure?.trend || 'neutral';
  const htf        = analysis.htfStructure?.trend || '—';
  const events     = analysis.structure?.events?.slice(-6).reverse() || [];
  const obs        = analysis.orderBlocks || [];
  const freshOBs   = obs.filter(ob => ob.state === 'fresh');
  const divs       = analysis.divs || [];
  const trendColor = trend === 'bull' ? '#00e676' : trend === 'bear' ? '#ff4444' : '#ffd54f';
  const htfColor   = htf   === 'bull' ? '#00e676' : htf   === 'bear' ? '#ff4444' : '#ffd54f';

  pane.innerHTML = `
    <div class="tab-two-col">
      <div class="tab-stat-block"><div class="tab-stat-label">MTF TREND (${currentTF})</div><div class="tab-stat-value" style="color:${trendColor}">${trend.toUpperCase()}</div></div>
      <div class="tab-stat-block"><div class="tab-stat-label">HTF TREND (4H)</div><div class="tab-stat-value" style="color:${htfColor}">${htf.toUpperCase()}</div></div>
    </div>
    <div class="tab-block">
      <div class="tab-block-label">RECENT STRUCTURE EVENTS</div>
      ${events.length
        ? events.map(ev => `<div class="tab-event-row">
            <span class="tag ${ev.type === 'CHoCH' ? 'tag-warn' : ev.dir === 'bull' ? 'tag-bull' : 'tag-bear'}">${ev.type}</span>
            <span class="tab-event-dir" style="color:${ev.dir === 'bull' ? '#00e676' : '#ff4444'}">${ev.dir === 'bull' ? '↑ Bullish' : '↓ Bearish'}</span>
            <span class="tab-event-price">$${formatPrice(ev.price)}</span>
          </div>`).join('')
        : '<div class="tab-empty">No structure events detected yet</div>'}
    </div>
    <div class="tab-block">
      <div class="tab-block-label">FRESH ORDER BLOCKS (${freshOBs.length})</div>
      ${freshOBs.length
        ? freshOBs.map(ob => `<div class="tab-ob ${ob.type === 'demand' ? 'tab-ob-demand' : 'tab-ob-supply'}">
            <div class="tab-ob-header">
              <span class="tag ${ob.type === 'demand' ? 'tag-bull' : 'tag-bear'}">${ob.type.toUpperCase()}</span>
              <span class="tab-ob-type">${ob.structureType}</span>
              <span class="tab-ob-range">$${formatPrice(ob.low)} – $${formatPrice(ob.high)}</span>
            </div>
          </div>`).join('')
        : '<div class="tab-empty">No fresh order blocks in current range</div>'}
    </div>
    ${buildReasonBlock(signal?.scores?.structure?.reasons, 'STRUCTURE CONFLUENCE')}`;
}

function populateTabLevels(analysis, signal) {
  const pane = dom.tabLevels();
  if (!pane) return;

  const pd    = analysis.premDisc;
  const fvgs  = analysis.fvgs || [];
  const liq   = analysis.liqLevels;
  const price = analysis.price;
  const zoneColor = !pd ? '#ffd54f' : pd.zone === 'discount' ? '#00e676' : pd.zone === 'premium' ? '#ff4444' : '#ffd54f';

  pane.innerHTML = `
    <div class="tab-block">
      <div class="tab-block-label">PREMIUM / DISCOUNT ZONE</div>
      ${pd ? `<div class="tab-two-col" style="margin-bottom:10px">
        <div class="tab-stat-block"><div class="tab-stat-label">CURRENT ZONE</div><div class="tab-stat-value" style="color:${zoneColor}">${pd.zone.toUpperCase()}</div></div>
        <div class="tab-stat-block"><div class="tab-stat-label">RANGE POSITION</div><div class="tab-stat-value" style="color:${zoneColor}">${(pd.position * 100).toFixed(1)}%</div></div>
      </div>` : '<div class="tab-empty">Premium/Discount data unavailable</div>'}
    </div>
    <div class="tab-block">
      <div class="tab-block-label">FAIR VALUE GAPS (${fvgs.length} active)</div>
      ${fvgs.length
        ? fvgs.slice().reverse().map(f => {
            const filled = (f.dir === 'bull' && price > f.top) || (f.dir === 'bear' && price < f.bottom);
            return `<div class="tab-ob ${f.dir === 'bull' ? 'tab-ob-demand' : 'tab-ob-supply'}">
              <div class="tab-ob-header">
                <span class="tag ${f.dir === 'bull' ? 'tag-bull' : 'tag-bear'}">${f.dir.toUpperCase()} FVG</span>
                <span class="tab-ob-type">${f.size.toFixed(3)}% gap</span>
                <span class="tab-ob-range">$${formatPrice(f.bottom)} – $${formatPrice(f.top)}</span>
                <span style="font-size:8px;color:${filled ? '#5a6470' : '#00e676'};margin-left:auto">${filled ? 'FILLED' : 'OPEN'}</span>
              </div>
            </div>`;
          }).join('')
        : '<div class="tab-empty">No unfilled FVGs detected</div>'}
    </div>
    ${liq ? `<div class="tab-block">
      <div class="tab-block-label">LIQUIDATION MAP</div>
      <div class="tab-liq-grid">
        <div class="tab-liq-col">
          <div class="tab-liq-header" style="color:#ff4444">SHORT LIQUIDATIONS</div>
          ${liq.shortLiqs.map(l => `<div class="tab-liq-row"><span>${l.label}</span><span style="color:#ff4444">$${formatPrice(l.price)}</span><span class="tab-muted-text">+${((l.price / liq.swingHigh - 1) * 100).toFixed(1)}%</span></div>`).join('')}
        </div>
        <div class="tab-liq-col">
          <div class="tab-liq-header" style="color:#00e676">LONG LIQUIDATIONS</div>
          ${liq.longLiqs.map(l => `<div class="tab-liq-row"><span>${l.label}</span><span style="color:#00e676">$${formatPrice(l.price)}</span><span class="tab-muted-text">${((l.price / liq.swingLow - 1) * 100).toFixed(1)}%</span></div>`).join('')}
        </div>
      </div>
    </div>` : ''}`;
}

// ── Mini Charts (unchanged) ────────────────────────────────────
function renderMiniCharts(data, analysis) {
  const rsiEl  = dom.rsiContainer();
  const macdEl = dom.macdContainer();
  if (rsiEl)  renderRSIPanel(rsiEl, analysis.rsi);
  if (macdEl) renderMACDPanel(macdEl, analysis.macd);

  const fundEl = dom.fundingMini();
  if (fundEl && data.fundingHist?.length) {
    svgSparkline(fundEl, data.fundingHist.map(h => h.rate), '#ffd54f', 0.2);
  }
  const oiEl = dom.oiMini();
  if (oiEl && data.oiHistory?.length) {
    const rising = data.oiHistory.slice(-1)[0]?.oi > data.oiHistory[0]?.oi;
    svgSparkline(oiEl, data.oiHistory.map(o => o.oi), rising ? '#00e676' : '#ff4444', 0.15);
  }
  const liqEl = dom.liqContainer();
  if (liqEl && analysis.liqLevels) {
    const liq   = analysis.liqLevels;
    const price = analysis.price;
    const items = [
      ...liq.shortLiqs.slice(0, 3).map(l => ({ label: l.label, price: l.price, side: 'short' })),
      ...liq.longLiqs.slice(0, 3).map(l => ({ label: l.label, price: l.price, side: 'long' })),
    ].sort((a, b) => b.price - a.price);
    liqEl.innerHTML = `<div style="padding:4px 8px;display:flex;flex-direction:column;gap:2px;height:100%">
      ${items.map(l => {
        const pct = ((l.price - price) / price * 100).toFixed(1);
        const col = l.side === 'short' ? '#ff4444' : '#00e676';
        return `<div style="display:flex;align-items:center;gap:4px;flex:1">
          <span style="font-size:7px;color:${col};width:28px;flex-shrink:0">${l.label}</span>
          <div style="flex:1;height:2px;background:rgba(255,255,255,0.06);border-radius:1px">
            <div style="width:${Math.min(Math.abs(parseFloat(pct)) * 8, 100)}%;height:100%;background:${col};border-radius:1px"></div>
          </div>
          <span style="font-size:7px;color:#5a6470;width:36px;text-align:right">${pct}%</span>
        </div>`;
      }).join('')}
    </div>`;
  }
}

function initTabs() {
  document.querySelectorAll('.intel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.intel-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.intel-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.getElementById(`tab-${tab.dataset.tab}`);
      if (pane) pane.classList.add('active');
    });
  });
}

// ── Drawer System (unchanged) ──────────────────────────────────
function openDrawer(type) {
  const panel   = dom.drawerPanel();
  const title   = dom.drawerTitle();
  const content = dom.drawerContent();
  if (!panel || !title || !content) return;
  const { html, titleText } = buildDrawerContent(type, analysis, signal, rawData);
  title.textContent = titleText;
  content.innerHTML = html;
  panel.classList.add('open');
}
function closeDrawer() { dom.drawerPanel()?.classList.remove('open'); }
function buildDrawerContent(type, analysis, signal, data) {
  switch (type) {
    case 'structure':   return drawerStructure(analysis);
    case 'orderblocks': return drawerOrderBlocks(analysis);
    case 'fvg':         return drawerFVG(analysis);
    case 'premdisc':    return drawerPremDisc(analysis);
    case 'derivatives': return drawerDerivatives(data, analysis);
    case 'liquidation': return drawerLiquidation(analysis);
    case 'setup':       return drawerSetup(signal, analysis);
    case 'rsi':         return drawerRSI(analysis);
    case 'orderbook':   return drawerOrderBook(analysis);
    default:            return { html: '<p>No content</p>', titleText: type };
  }
}

function drawerStructure(analysis) {
  const { structure, htfStructure } = analysis;
  const events = structure?.events?.slice(-8).reverse() || [];
  const rows   = events.map(ev => `
    <div class="drawer-row">
      <span class="tag ${ev.type === 'CHoCH' ? 'tag-warn' : ev.dir === 'bull' ? 'tag-bull' : 'tag-bear'}">${ev.type}</span>
      <span>${ev.dir === 'bull' ? '↑ Bullish' : '↓ Bearish'}</span>
      <span>$${formatPrice(ev.price)}</span>
    </div>`).join('');
  return {
    titleText: '⚡ Market Structure Analysis',
    html: `
    <div class="drawer-section"><div class="drawer-label">TREND STATE</div><div class="drawer-big" style="color:${structure?.trend === 'bull' ? '#00e676' : '#ff4444'}">${structure?.trend?.toUpperCase() || 'NEUTRAL'}</div><div class="drawer-sub">HTF (4H): ${htfStructure?.trend?.toUpperCase() || 'N/A'}</div></div>
    <div class="drawer-section"><div class="drawer-label">RECENT STRUCTURE EVENTS</div>${rows || '<div class="drawer-empty">No events detected</div>'}</div>
    ${buildReasonBlock(signal?.scores?.structure?.reasons, 'STRUCTURE CONFLUENCE')}`,
  };
}
function drawerOrderBlocks(analysis) {
  const obs  = analysis.orderBlocks;
  const rows = obs.slice().reverse().map(ob => `
    <div class="drawer-ob ${ob.type === 'demand' ? 'ob-demand' : 'ob-supply'}">
      <div class="ob-header">
        <span class="tag ${ob.type === 'demand' ? 'tag-bull' : 'tag-bear'}">${ob.type.toUpperCase()} OB</span>
        <span class="tag tag-info">${ob.structureType}</span>
        <span class="ob-state ${ob.state}">${ob.state.toUpperCase()}</span>
      </div>
      <div class="ob-levels"><span>High: $${formatPrice(ob.high)}</span><span>Low: $${formatPrice(ob.low)}</span><span>${((ob.high - ob.low) / ob.low * 100).toFixed(2)}%</span></div>
    </div>`).join('');
  return { titleText: '🧱 Order Blocks', html: `<div class="drawer-section"><div class="drawer-label">ORDER BLOCKS (${obs.length})</div>${rows || '<div class="drawer-empty">None detected</div>'}</div>` };
}
function drawerFVG(analysis) {
  const fvgs = analysis.fvgs;
  const rows = fvgs.slice().reverse().map(f => `
    <div class="drawer-ob ${f.dir === 'bull' ? 'ob-demand' : 'ob-supply'}">
      <div class="ob-header"><span class="tag ${f.dir === 'bull' ? 'tag-bull' : 'tag-bear'}">${f.dir.toUpperCase()} FVG</span><span>${f.size.toFixed(3)}%</span></div>
      <div class="ob-levels"><span>Top: $${formatPrice(f.top)}</span><span>Bottom: $${formatPrice(f.bottom)}</span><span>Mid: $${formatPrice(f.mid)}</span></div>
    </div>`).join('');
  return { titleText: '📐 Fair Value Gaps', html: `<div class="drawer-section"><div class="drawer-label">ACTIVE FVGs (${fvgs.length})</div>${rows || '<div class="drawer-empty">None</div>'}</div>` };
}
function drawerPremDisc(analysis) {
  const pd = analysis.premDisc;
  if (!pd) return { titleText: 'Premium / Discount', html: '<p>No data</p>' };
  const zoneColor = pd.zone === 'discount' ? '#00e676' : pd.zone === 'premium' ? '#ff4444' : '#ffd54f';
  const levels = [
    { label: 'Range High (100%)', price: pd.rangeHigh, color: '#ff4444' },
    { label: '61.8% (Premium)',   price: pd.fib618,    color: '#ffa0a0' },
    { label: '50% (EQ)',          price: pd.fib50,     color: '#ffd54f' },
    { label: '38.2% (Discount)',  price: pd.fib382,    color: '#69f0ae' },
    { label: 'Range Low (0%)',    price: pd.rangeLow,  color: '#00e676' },
  ];
  return {
    titleText: '🎯 Premium / Discount',
    html: `
    <div class="drawer-section"><div class="drawer-label">ZONE</div><div class="drawer-big" style="color:${zoneColor}">${pd.zone.toUpperCase()}</div><div class="drawer-sub">${(pd.position * 100).toFixed(1)}% of range</div></div>
    <div class="drawer-section"><div class="drawer-label">FIBONACCI LEVELS</div>${levels.map(l => `<div class="drawer-row"><span style="color:${l.color}">${l.label}</span><span>$${formatPrice(l.price)}</span></div>`).join('')}</div>`,
  };
}
function drawerDerivatives(data, analysis) {
  const t    = data.ticker;
  const fr   = t?.fundingRate || 0;
  const hist = data.fundingHist?.slice(-10) || [];
  const ds   = calcDerivScore(data, analysis);
  return {
    titleText: '📡 Derivatives Intelligence',
    html: `
    <div class="drawer-section"><div class="drawer-label">DERIV SCORE</div><div class="drawer-big" style="color:${ds.derivColor}">${ds.derivScore} / 100</div><div class="drawer-sub">${ds.derivLabel}</div></div>
    <div class="drawer-section"><div class="drawer-label">FUNDING RATE</div><div class="drawer-big" style="color:${fr < -0.01 ? '#00e676' : fr > 0.05 ? '#ff4444' : '#ffd54f'}">${fr.toFixed(4)}%</div></div>
    <div class="drawer-section"><div class="drawer-label">FUNDING HISTORY</div>${hist.map(h => `<div class="drawer-row"><span>${new Date(h.time * 1000).toLocaleDateString()}</span><span style="color:${h.rate < 0 ? '#00e676' : '#ff4444'}">${h.rate.toFixed(4)}%</span></div>`).join('')}</div>`,
  };
}
function drawerLiquidation(analysis) {
  const liq = analysis.liqLevels;
  return {
    titleText: '💥 Liquidation Map',
    html: `
    <div class="drawer-section"><div class="drawer-label">SHORT LIQUIDATIONS</div>${liq.shortLiqs.map(l => `<div class="drawer-row"><span style="color:#ff4444">${l.label}</span><span>$${formatPrice(l.price)}</span><span style="color:#5a6470">+${((l.price / liq.swingHigh - 1) * 100).toFixed(1)}%</span></div>`).join('')}</div>
    <div class="drawer-section"><div class="drawer-label">LONG LIQUIDATIONS</div>${liq.longLiqs.map(l => `<div class="drawer-row"><span style="color:#00e676">${l.label}</span><span>$${formatPrice(l.price)}</span><span style="color:#5a6470">${((l.price / liq.swingLow - 1) * 100).toFixed(1)}%</span></div>`).join('')}</div>`,
  };
}
function drawerSetup(signal, analysis) {
  if (!signal?.setup) return { titleText: 'Trade Setup', html: '<div class="drawer-empty">No setup — confluence insufficient.</div>' };
  const s      = signal.setup;
  const isLong = s.direction === 'LONG';
  return {
    titleText: `${isLong ? '⬆' : '⬇'} ${s.direction} Setup`,
    html: `
    <div class="setup-grid">
      <div class="setup-level entry"><div class="level-label">ENTRY</div><div class="level-price">$${formatPrice(s.entry)}</div><div class="level-reason">${s.entryReason}</div></div>
      <div class="setup-level sl"><div class="level-label">STOP LOSS</div><div class="level-price">$${formatPrice(s.sl)}</div><div class="level-reason">${s.slReason}</div></div>
      <div class="setup-level tp1"><div class="level-label">TP1 — ${s.rr1}R</div><div class="level-price">$${formatPrice(s.tp1)}</div><div class="level-reason">${s.tp1Reason}</div></div>
    </div>
    <div class="drawer-section"><div class="drawer-label">INVALIDATION</div><div class="drawer-reason" style="color:#ff9090">⚠ ${s.invalidationReason}</div></div>
    <div class="drawer-section"><div class="drawer-label">CONFLUENCE</div>${buildConfluenceBars(signal)}</div>`,
  };
}
function drawerRSI(analysis) {
  const rsi  = analysis.lastRSI;
  const divs = analysis.divs;
  return {
    titleText: '📊 RSI + MACD',
    html: `
    <div class="drawer-section"><div class="drawer-label">RSI (14)</div><div class="drawer-big" style="color:${rsi > 70 ? '#ff4444' : rsi < 30 ? '#00e676' : '#a78bfa'}">${rsi?.toFixed(2) || '—'}</div></div>
    <div class="drawer-section"><div class="drawer-label">MACD</div>
      <div class="drawer-row"><span>MACD Line</span><span style="color:#00bfff">${analysis.lastMACD.line?.toFixed(4) || '—'}</span></div>
      <div class="drawer-row"><span>Signal</span><span style="color:#ff7c7c">${analysis.lastMACD.signal?.toFixed(4) || '—'}</span></div>
      <div class="drawer-row"><span>Histogram</span><span style="color:${analysis.lastMACD.histogram > 0 ? '#00e676' : '#ff4444'}">${analysis.lastMACD.histogram?.toFixed(4) || '—'}</span></div>
    </div>
    <div class="drawer-section"><div class="drawer-label">DIVERGENCES</div>${divs.length ? divs.map(d => `<div class="drawer-reason">▸ ${d.type.toUpperCase()} — RSI ${d.rsiPrev.toFixed(1)} → ${d.rsiNow.toFixed(1)}</div>`).join('') : '<div class="drawer-empty">None detected</div>'}</div>`,
  };
}
function drawerOrderBook(analysis) {
  const ob = analysis.obAnalysis;
  if (!ob) return { titleText: 'Order Book', html: '<div class="drawer-empty">No data</div>' };
  return {
    titleText: '📖 Order Book',
    html: `
    <div class="drawer-section">
      <div class="depth-bar-wrap">
        <div class="depth-bid" style="width:${(ob.bidAskRatio * 100).toFixed(1)}%">Bids ${(ob.bidAskRatio * 100).toFixed(0)}%</div>
        <div class="depth-ask" style="width:${((1 - ob.bidAskRatio) * 100).toFixed(1)}%">Asks ${((1 - ob.bidAskRatio) * 100).toFixed(0)}%</div>
      </div>
    </div>
    <div class="drawer-section"><div class="drawer-label">BID WALLS</div>${ob.bidWalls.slice(0, 5).map(w => `<div class="drawer-row"><span>$${formatPrice(w.price)}</span><span style="color:#00e676">${w.size.toFixed(1)}</span></div>`).join('') || '<div class="drawer-empty">None</div>'}</div>
    <div class="drawer-section"><div class="drawer-label">ASK WALLS</div>${ob.askWalls.slice(0, 5).map(w => `<div class="drawer-row"><span>$${formatPrice(w.price)}</span><span style="color:#ff4444">${w.size.toFixed(1)}</span></div>`).join('') || '<div class="drawer-empty">None</div>'}</div>`,
  };
}

// ── Helpers ────────────────────────────────────────────────────
function formatPrice(p) {
  if (!p) return '0';
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}
function formatLarge(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n?.toFixed(2) || '0';
}
function truncate(str, n) { return str.length > n ? str.slice(0, n) + '…' : str; }
function updateLastUpdated() {
  const el = dom.lastUpdated();
  if (el) el.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// ── SVG Sparkline ──────────────────────────────────────────────
function svgSparkline(container, values, color, fillOpacity = 0.15) {
  if (!container || !values?.length) return;
  const W        = container.offsetWidth || 120;
  const H        = container.offsetHeight || 68;
  const filtered = values.filter(v => v != null && isFinite(v));
  if (filtered.length < 2) return;
  const min   = Math.min(...filtered);
  const max   = Math.max(...filtered);
  const range = max - min || 1;
  const pts   = filtered.map((v, i) => {
    const x = (i / (filtered.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const poly     = pts.join(' ');
  const fillPath = `M${pts[0]} L${pts.join(' L')} L${W},${H} L0,${H} Z`;
  container.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
      <defs>
        <linearGradient id="sg${color.replace('#','')}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="${fillOpacity * 3}"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${fillPath}" fill="url(#sg${color.replace('#','')})" />
      <polyline points="${poly}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}" r="2" fill="${color}"/>
    </svg>`;
}

// ── RSI + MACD sub-panels (unchanged) ─────────────────────────
function renderRSIPanel(container, rsiValues) {
  if (!container) return;
  const vals = rsiValues.filter(v => v != null);
  const last = vals[vals.length - 1];
  const col  = last > 70 ? '#ff4444' : last < 30 ? '#00e676' : '#a78bfa';
  const W    = container.offsetWidth || 200;
  const H    = 90;
  const toY  = v => H - ((v - 0) / 100) * (H - 6) - 3;
  const recent = vals.slice(-100);
  const pts  = recent.map((v, i) => `${((i / (recent.length - 1)) * W).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  container.innerHTML = `
    <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
      <line x1="0" y1="${toY(70)}" x2="${W}" y2="${toY(70)}" stroke="rgba(255,68,68,0.25)" stroke-width="1" stroke-dasharray="3,3"/>
      <line x1="0" y1="${toY(30)}" x2="${W}" y2="${toY(30)}" stroke="rgba(0,230,118,0.25)" stroke-width="1" stroke-dasharray="3,3"/>
      <line x1="0" y1="${toY(50)}" x2="${W}" y2="${toY(50)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="4" y="10" fill="${col}" font-size="9" font-family="monospace">${last?.toFixed(1)}</text>
    </svg>`;
}

function renderMACDPanel(container, macdData) {
  if (!container || !macdData) return;
  const { macdLine, signalLine, histogram } = macdData;
  const recent = histogram.slice(-80);
  const W      = container.offsetWidth || 200;
  const H      = 90;
  const max    = Math.max(...recent.map(Math.abs)) || 1;
  const midY   = H / 2;
  const barW   = (W / recent.length) - 0.5;
  const bars   = recent.map((v, i) => {
    const h   = Math.abs(v) / max * (midY - 4);
    const y   = v >= 0 ? midY - h : midY;
    const col = v >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,68,68,0.7)';
    return `<rect x="${(i * W / recent.length).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}"/>`;
  }).join('');
  const lineRecent = macdLine.slice(-80);
  const sigRecent  = signalLine.slice(-80);
  const lineMin    = Math.min(...lineRecent, ...sigRecent);
  const lineMax    = Math.max(...lineRecent, ...sigRecent);
  const lineRange  = lineMax - lineMin || 1;
  const toY        = v => H - ((v - lineMin) / lineRange) * (H - 8) - 4;
  const macdPts    = lineRecent.map((v, i) => `${(i * W / lineRecent.length).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const sigPts     = sigRecent.map((v, i)  => `${(i * W / sigRecent.length).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  container.innerHTML = `
    <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
      ${bars}
      <line x1="0" y1="${midY}" x2="${W}" y2="${midY}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
      <polyline points="${macdPts}" fill="none" stroke="#40c4ff" stroke-width="1.2"/>
      <polyline points="${sigPts}"  fill="none" stroke="#ff7c7c" stroke-width="1"/>
    </svg>`;
}

// ── Boot ───────────────────────────────────────────────────────
function boot() {
  const chartEl = dom.chartContainer();
  const rsiEl   = dom.rsiContainer();
  const macdEl  = dom.macdContainer();

  if (chartEl) { initChart(chartEl); setupOverlayCanvas(chartEl); }
  if (rsiEl)   initRSIChart(rsiEl);
  if (macdEl)  initMACDChart(macdEl);

  initTabs();

  const input = dom.searchInput();
  const btn   = dom.searchBtn();
  if (btn)   btn.addEventListener('click', () => analyze(input?.value || ''));
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') analyze(input.value); });

  document.querySelectorAll('.tf-pill[data-ticker]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tf-pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const ticker = b.dataset.ticker;
      if (input) input.value = ticker;
      analyze(ticker, currentTF);
    });
  });

  const tfSel = dom.tfSelect();
  if (tfSel) {
    tfSel.addEventListener('change', () => {
      currentTF = tfSel.value;
      if (currentSymbol) analyze(currentSymbol, currentTF);
    });
  }

  let autoTimer = null;
  const autoBtn     = dom.autoRefreshBtn();
  const intervalSel = dom.refreshIntervalSel();
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      if (autoTimer) {
        clearInterval(autoTimer); autoTimer = null;
        autoBtn.textContent = 'OFF';
        autoBtn.classList.add('auto-off');
        autoBtn.classList.remove('auto-on');
      } else {
        const secs = parseInt(intervalSel?.value || '60', 10) * 1000;
        autoBtn.textContent = 'ON';
        autoBtn.classList.remove('auto-off');
        autoBtn.classList.add('auto-on');
        autoTimer = setInterval(() => { if (currentSymbol) analyze(currentSymbol, currentTF); }, secs);
      }
    });
  }

  dom.refreshBtn()?.addEventListener('click', () => {
    const sym = currentSymbol || input?.value || '';
    if (sym) analyze(sym);
    else showError('Enter a symbol first');
  });

  dom.drawerClose()?.addEventListener('click', closeDrawer);
  dom.drawerPanel()?.addEventListener('click', e => {
    if (e.target === dom.drawerPanel()) closeDrawer();
  });

  document.getElementById('mbr-analysis')?.addEventListener('click', () => {
    document.getElementById('stage-analysis')?.scrollIntoView({ behavior: 'smooth' });
  });

  // ── Mobile panel tab switching ─────────────────────────────
  const PANEL_MAP = { struct: null, deriv: 'panel-deriv', trade: 'panel-trade' };

  function switchMobilePanel(target) {
    document.querySelectorAll('.mpt-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.panel === target);
    });
    Object.entries(PANEL_MAP).forEach(([key, id]) => {
      if (!id) return;
      const el = document.getElementById(id);
      if (!el) return;
      if (key === target) {
        el.classList.add('mobile-active');
        setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      } else {
        el.classList.remove('mobile-active');
      }
    });
    if (target === 'struct') {
      document.getElementById('stage-analysis')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  document.querySelectorAll('.mpt-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMobilePanel(btn.dataset.panel));
    btn.addEventListener('touchend', e => {
      e.preventDefault();
      switchMobilePanel(btn.dataset.panel);
    }, { passive: false });
  });

  switchMobilePanel('struct');

  // UTC Clock
  function tickClock() {
    const el = document.getElementById('atl-clock');
    if (!el) return;
    const now = new Date();
    el.textContent = [
      String(now.getUTCHours()).padStart(2,'0'),
      String(now.getUTCMinutes()).padStart(2,'0'),
      String(now.getUTCSeconds()).padStart(2,'0'),
    ].join(':') + ' UTC';
  }
  tickClock();
  setInterval(tickClock, 1000);

  // Status dot
  function setStatus(state) {
    const dot  = document.getElementById('global-status-dot');
    const text = document.getElementById('global-status-text');
    if (dot)  dot.className    = `status-dot ${state === 'live' ? 'online' : state === 'loading' ? 'scanning' : ''}`;
    if (text) text.textContent = state === 'live' ? 'LIVE' : state === 'loading' ? 'SCANNING' : 'READY';
  }
  window.__atlSetStatus = setStatus;
  window.__atl = { analyze };
}

window.addEventListener('DOMContentLoaded', boot);
export { analyze, formatPrice, formatLarge };
