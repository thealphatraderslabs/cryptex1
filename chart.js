// ATL Ticker Analyzer — Chart Module
// Main chart: Candlesticks + Volume + EMA (20 / 50 / 200) only

let chart = null, candleSeries = null, volumeSeries = null;
let ema20Series = null, ema50Series = null, ema200Series = null;

// ── Init Main Chart ─────────────────────────────────────────
function initChart(container) {
  container.innerHTML = '';

  chart = LightweightCharts.createChart(container, {
    layout: {
      background:  { color: '#080b0f' },
      textColor:   '#5a6470',
      fontSize:    11,
      fontFamily:  "'Share Tech Mono', monospace",
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(0,230,118,0.3)', labelBackgroundColor: '#0d1117' },
      horzLine: { color: 'rgba(0,230,118,0.3)', labelBackgroundColor: '#0d1117' },
    },
    rightPriceScale: {
      borderColor:  'rgba(255,255,255,0.07)',
      scaleMargins: { top: 0.06, bottom: 0.06 },
    },
    timeScale: {
      borderColor:    'rgba(255,255,255,0.07)',
      timeVisible:    true,
      secondsVisible: false,
    },
    width:  container.offsetWidth,
    height: container.offsetHeight || 420,
  });

  // Candlesticks
  candleSeries = chart.addCandlestickSeries({
    upColor:         '#00e676',
    downColor:       '#ff4444',
    borderUpColor:   '#00e676',
    borderDownColor: '#ff4444',
    wickUpColor:     '#00e676',
    wickDownColor:   '#ff4444',
  });

  // Volume histogram removed — visual only, maths unaffected

  // Resize observer
  const ro = new ResizeObserver(() => {
    chart.applyOptions({ width: container.offsetWidth, height: container.offsetHeight || 420 });
  });
  ro.observe(container);

  return chart;
}

// ── Load Candles + Volume ────────────────────────────────────
function loadCandles(candles) {
  if (!candleSeries || !candles.length) return;

  candleSeries.setData(candles);

  // Volume data kept in candles object — not rendered visually

  chart.timeScale().fitContent();
}

// ── EMA Lines (20 / 50 / 200) ───────────────────────────────
function drawEMAs(candles, emas) {
  if (ema20Series)  { chart.removeSeries(ema20Series);  ema20Series  = null; }
  if (ema50Series)  { chart.removeSeries(ema50Series);  ema50Series  = null; }
  if (ema200Series) { chart.removeSeries(ema200Series); ema200Series = null; }

  ema20Series  = chart.addLineSeries({ color: 'rgba(0,230,118,0.7)',  lineWidth: 1,   priceLineVisible: false, lastValueVisible: false });
  ema50Series  = chart.addLineSeries({ color: 'rgba(255,213,79,0.6)', lineWidth: 1,   priceLineVisible: false, lastValueVisible: false });
  ema200Series = chart.addLineSeries({ color: 'rgba(255,68,68,0.6)',  lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });

  const toSeries = arr => candles
    .map((c, i) => arr[i] != null ? { time: c.time, value: arr[i] } : null)
    .filter(Boolean);

  ema20Series.setData(toSeries(emas.ema20));
  ema50Series.setData(toSeries(emas.ema50));
  ema200Series.setData(toSeries(emas.ema200));
}

// ── Master Render ─────────────────────────────────────────────
function renderAll(analysis) {
  loadCandles(analysis.candles);
  drawEMAs(analysis.candles, analysis.emas);
}

// ── Sub-panel stubs (kept so app.js imports don't break) ─────
function initRSIChart()       {}
function initMACDChart()      {}
function setupOverlayCanvas() {}
function redrawOverlay()      {}
function drawVolumeProfile()  {}
function drawFundingChart()   {}
function drawOIChart()        {}
function drawLiquidationBar() {}

export {
  initChart, initRSIChart, initMACDChart,
  setupOverlayCanvas, renderAll, redrawOverlay,
  drawVolumeProfile, drawFundingChart, drawOIChart, drawLiquidationBar,
};
