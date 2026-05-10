// ATL · Funding Scanner UI Controller (Phase 4)
// Phase 4 changes:
//   • renderCard() shows raw rate + normalised 8h-equivalent when interval ≠ 8h
//   • renderCommonCard() same — bybit/binance rates + per-8h equivalents
//   • All scan logic, exchange tabs, filter pills unchanged

import {
  runFundingScan,
  runFundingCommonScan,
  abortFundingScan,
  formatFundingRate,
  fundingDirection,
  timeToFunding,
} from './funding-scanner.js';

// ── State ──────────────────────────────────────────────────────
let selectedExchange = 'bybit';
let activeFilter     = 'all';
let allResults       = [];
let isCommonScan     = false;

const $ = id => document.getElementById(id);

// ── Init ───────────────────────────────────────────────────────
function init() {
  // Exchange tabs
  document.querySelectorAll('#fr-exchange-tabs .fr-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#fr-exchange-tabs .fr-tab')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedExchange = btn.dataset.val;
      isCommonScan = selectedExchange === 'common';

      const filterRow = $('fr-filter-row');
      if (filterRow) filterRow.style.display = isCommonScan ? 'none' : '';

      allResults = [];
      renderEmpty();
    });
  });

  // Filter pills
  document.querySelectorAll('#fr-filter-row .fr-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#fr-filter-row .fr-filter')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderResults();
    });
  });

  // Scan button
  $('fr-scan-btn')?.addEventListener('click', () => {
    if (isCommonScan) startCommonScan();
    else              startScan();
  });

  $('fr-abort-btn')?.addEventListener('click', () => {
    abortFundingScan();
    setStatus('Aborting…');
  });

  document.getElementById('mbr-funding')?.addEventListener('click', () => {
    window.__atlShowStage?.('funding');
  });
}

// ── Status helpers ─────────────────────────────────────────────
function setStatus(msg, color) {
  const el = $('fr-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--muted)';
}

function setScanningUI(active) {
  const scanBtn  = $('fr-scan-btn');
  const abortBtn = $('fr-abort-btn');
  if (scanBtn)  scanBtn.style.display  = active ? 'none' : '';
  if (abortBtn) abortBtn.style.display = active ? '' : 'none';
  if (window.__atlSetStatus) window.__atlSetStatus(active ? 'loading' : 'live');
}

function renderEmpty(msg) {
  const grid = $('fr-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="fr-empty">
      <div class="fr-empty-glyph">◎</div>
      <div>${msg || 'SELECT EXCHANGE AND PRESS SCAN'}</div>
      <div style="font-size:9px;color:var(--muted);margin-top:6px">
        Pairs with funding ≥ +0.05% or ≤ −0.05% will appear here
      </div>
    </div>`;
}

// ── Single exchange scan ───────────────────────────────────────
function startScan() {
  allResults = [];
  const grid = $('fr-grid');
  if (grid) {
    grid.innerHTML = `
      <div class="smc-scan-progress">
        <div class="smc-progress-ring" id="fr-progress-ring"></div>
        <div id="fr-progress-text" class="smc-progress-text">Fetching pairs + funding intervals…</div>
      </div>`;
  }

  setScanningUI(true);
  setStatus(`Scanning ${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'}…`, '#ffd54f');

  runFundingScan({
    exchange: selectedExchange,

    onProgress({ done, total, msg }) {
      const el = $('fr-progress-text');
      if (el) el.textContent = msg;
      if (done && total) {
        const pct  = Math.round((done / total) * 100);
        const ring = $('fr-progress-ring');
        if (ring) ring.style.background = `conic-gradient(var(--green) ${pct * 3.6}deg, var(--bg3) 0deg)`;
      }
      setStatus(msg);
    },

    onResult(item) {
      allResults.push(item);
      renderResults();
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);
      allResults = results;
      renderResults();

      const pos = results.filter(r => r.rate >= 0.0005).length;
      const neg = results.filter(r => r.rate <= -0.0005).length;

      if (aborted) {
        setStatus(`Aborted · ${results.length} found`, '#ffd54f');
      } else {
        setStatus(
          `Done · ${total} scanned · ${results.length} qualified · ${pos} positive · ${neg} negative`,
          '#00e676'
        );
      }
      if (window.__atlSetStatus) window.__atlSetStatus('live');
    },

    onError(msg) {
      setScanningUI(false);
      setStatus(`Error: ${msg}`, '#ff4444');
      renderEmpty(`Error: ${msg}`);
    },
  });
}

// ── Common scan (both exchanges) ───────────────────────────────
function startCommonScan() {
  allResults = [];
  const grid = $('fr-grid');
  if (grid) {
    grid.innerHTML = `
      <div class="smc-scan-progress">
        <div class="smc-progress-ring" id="fr-progress-ring"></div>
        <div id="fr-progress-text" class="smc-progress-text">Fetching pairs from both exchanges…</div>
      </div>`;
  }

  setScanningUI(true);
  setStatus('Common scan · Bybit + Binance…', '#ffd54f');

  runFundingCommonScan({
    onProgress({ done, total, msg }) {
      const el = $('fr-progress-text');
      if (el) el.textContent = msg;
      if (done && total) {
        const pct  = Math.round((done / total) * 100);
        const ring = $('fr-progress-ring');
        if (ring) ring.style.background = `conic-gradient(var(--green) ${pct * 3.6}deg, var(--bg3) 0deg)`;
      }
      setStatus(msg);
    },

    onResult(item) {
      allResults.push(item);
      renderCommonResults();
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);
      allResults = results;
      renderCommonResults();

      const pos = results.filter(r => r.direction === 'positive').length;
      const neg = results.filter(r => r.direction === 'negative').length;

      if (aborted) {
        setStatus(`Aborted · ${results.length} common pairs found`, '#ffd54f');
      } else {
        setStatus(
          `Done · ${total} common pairs · ${results.length} qualified both · ${pos} positive · ${neg} negative`,
          '#00e676'
        );
      }
      if (window.__atlSetStatus) window.__atlSetStatus('live');
    },

    onError(msg) {
      setScanningUI(false);
      setStatus(`Error: ${msg}`, '#ff4444');
      renderEmpty(`Error: ${msg}`);
    },
  });
}

// ── Render: single exchange results ───────────────────────────
function renderResults() {
  const grid = $('fr-grid');
  if (!grid) return;

  let filtered = allResults;
  if (activeFilter === 'positive') filtered = allResults.filter(r => r.rate >= 0.0005);
  if (activeFilter === 'negative') filtered = allResults.filter(r => r.rate <= -0.0005);

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="fr-empty">
        <div class="fr-empty-glyph">◎</div>
        <div>No pairs match the current filter</div>
      </div>`;
    return;
  }

  // Update live counts in filter pills
  const totalPos = allResults.filter(r => r.rate >= 0.0005).length;
  const totalNeg = allResults.filter(r => r.rate <= -0.0005).length;
  const pillAll  = document.querySelector('.fr-filter[data-filter="all"] .fr-pill-count');
  const pillPos  = document.querySelector('.fr-filter[data-filter="positive"] .fr-pill-count');
  const pillNeg  = document.querySelector('.fr-filter[data-filter="negative"] .fr-pill-count');
  if (pillAll) pillAll.textContent = allResults.length;
  if (pillPos) pillPos.textContent = totalPos;
  if (pillNeg) pillNeg.textContent = totalNeg;

  grid.innerHTML = `<div class="fr-card-grid">${filtered.map(r => renderCard(r)).join('')}</div>`;
}

// ── Card renderer (Phase 4 — normalised rate line) ─────────────
function renderCard(r) {
  const dir       = fundingDirection(r.rate);
  const ratePct   = (r.rate * 100).toFixed(4);
  const timeStr   = timeToFunding(r.nextFundingTime);
  const priceStr  = r.price >= 1
    ? '$' + r.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '$' + r.price.toFixed(6);
  const arrow     = r.rate >= 0.0005 ? '▲' : '▼';

  // Phase 4: normalised rate line — only shown when interval ≠ 8h
  const hrs       = r.intervalHours || 8;
  const normLine  = hrs !== 8
    ? `<div class="fr-card-norm">
         ${(r.normRate * 100).toFixed(4)}% per 8h
         <span class="fr-card-interval">${hrs}h</span>
       </div>`
    : '';

  return `
    <div class="fr-card" style="--fr-col:${dir.color};--fr-bg:${dir.bg}">
      <div class="fr-card-ticker">${r.symbol}</div>
      <div class="fr-card-rate" style="color:${dir.color}">${arrow} ${ratePct}%</div>
      ${normLine}
      <div class="fr-card-label" style="color:${dir.color}">${dir.label}</div>
      <div class="fr-card-desc">${dir.desc}</div>
      <div class="fr-card-meta">
        <span class="fr-card-price">${priceStr}</span>
        <span class="fr-card-timer">⏱ ${timeStr}</span>
      </div>
    </div>`;
}

// ── Render: common scan results ────────────────────────────────
function renderCommonResults() {
  const grid = $('fr-grid');
  if (!grid || !allResults.length) return;

  const pos = allResults.filter(r => r.direction === 'positive');
  const neg = allResults.filter(r => r.direction === 'negative');

  grid.innerHTML = `
    <div class="fr-common-header">
      <span class="fr-common-title">◈ COMMON FUNDING IMBALANCE</span>
      <span class="fr-common-sub">${allResults.length} pair${allResults.length !== 1 ? 's' : ''} qualified on BOTH exchanges</span>
    </div>

    ${neg.length ? `
    <div class="fr-section-label" style="color:var(--green)">
      ▼ NEGATIVE FUNDING <span class="fr-section-count">${neg.length}</span>
      <span class="fr-section-note">Shorts paying longs · Bullish pressure</span>
    </div>
    <div class="fr-card-grid">${neg.map(r => renderCommonCard(r)).join('')}</div>` : ''}

    ${pos.length ? `
    <div class="fr-section-label" style="color:var(--red)">
      ▲ POSITIVE FUNDING <span class="fr-section-count">${pos.length}</span>
      <span class="fr-section-note">Longs paying shorts · Bearish pressure</span>
    </div>
    <div class="fr-card-grid">${pos.map(r => renderCommonCard(r)).join('')}</div>` : ''}
  `;
}

// ── Common card renderer (Phase 4 — normalised rates) ─────────
function renderCommonCard(r) {
  const col    = r.direction === 'positive' ? '#ff4444' : '#00e676';
  const bg     = r.direction === 'positive' ? 'rgba(255,68,68,0.08)' : 'rgba(0,230,118,0.08)';
  const arrow  = r.direction === 'positive' ? '▲' : '▼';
  const bRate  = (r.bybitRate   * 100).toFixed(4);
  const nRate  = (r.binanceRate * 100).toFixed(4);
  const avgRaw = (r.avgRate     * 100).toFixed(4);
  const btTime = timeToFunding(r.bybitNextTime);
  const bnTime = timeToFunding(r.binanceNextTime);
  const price  = r.bybitPrice >= 1
    ? '$' + r.bybitPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '$' + r.bybitPrice.toFixed(6);

  const hrs = r.intervalHours || 8;

  // Phase 4: normalised rate sub-rows — only when interval ≠ 8h
  const bNormStr = hrs !== 8
    ? `<span style="font-size:7px;color:var(--muted)">${(r.bybitNorm * 100).toFixed(4)}% /8h</span>`
    : '';
  const nNormStr = hrs !== 8
    ? `<span style="font-size:7px;color:var(--muted)">${(r.binanceNorm * 100).toFixed(4)}% /8h</span>`
    : '';
  const avgNormStr = hrs !== 8
    ? `<span style="font-size:8px;color:var(--muted);margin-left:6px">(${(r.avgNorm * 100).toFixed(4)}% per 8h <span class="fr-card-interval">${hrs}h</span>)</span>`
    : '';

  return `
    <div class="fr-card fr-card--common" style="--fr-col:${col};--fr-bg:${bg}">
      <div class="fr-card-ticker">${r.symbol}</div>
      <div class="fr-card-rate" style="color:${col}">${arrow} avg ${avgRaw}% ${avgNormStr}</div>
      <div class="fr-common-row">
        <div class="fr-common-exch">
          <span class="fr-common-exch-label">BYBIT</span>
          <span class="fr-common-exch-rate" style="color:${col}">${bRate}%</span>
          ${bNormStr}
          <span class="fr-common-exch-time">⏱ ${btTime}</span>
        </div>
        <div class="fr-common-divider"></div>
        <div class="fr-common-exch">
          <span class="fr-common-exch-label">BINANCE</span>
          <span class="fr-common-exch-rate" style="color:${col}">${nRate}%</span>
          ${nNormStr}
          <span class="fr-common-exch-time">⏱ ${bnTime}</span>
        </div>
      </div>
      <div class="fr-card-meta" style="margin-top:4px">
        <span class="fr-card-price">${price}</span>
      </div>
    </div>`;
}

// ── Boot ───────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
