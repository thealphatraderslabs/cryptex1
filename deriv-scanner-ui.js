// ATL · Derivatives Confluence Scanner UI (Phase 5)
// New stage: stage-deriv
// Rail icon: rail-deriv
// Mobile button: mbr-deriv
// Result cards: 3-gate breakdown + conviction score + deriv component bars

import { runDerivScan, abortDerivScan, formatDerivPrice } from './deriv-scanner.js';

// ── State ──────────────────────────────────────────────────────
let selectedExchange = 'bybit';
let selectedTF       = '1h';
let scanResults      = [];
let isScanning       = false;

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
function init() {
  // ── Register stage in global router ─────────────────────────
  // Patch showStage to include 'deriv'
  const origShowStage = window.__atlShowStage;
  window.__atlShowStage = function(stage) {
    // Hide deriv stage first, deactivate rail
    const stageDerivEl = $('stage-deriv');
    if (stageDerivEl) stageDerivEl.style.display = 'none';
    $('rail-deriv')?.classList.remove('active');
    $('mbr-deriv')?.classList.remove('active');

    if (stage === 'deriv') {
      // Show deriv, hide others, manage top strip
      $('stage-analysis')  && ($('stage-analysis').style.display  = 'none');
      $('stage-smc')       && ($('stage-smc').style.display       = 'none');
      $('stage-funding')   && ($('stage-funding').style.display   = 'none');
      $('top-strip')       && ($('top-strip').style.display       = 'none');
      $('stage')           && $('stage').classList.add('smc-active');

      if (stageDerivEl) stageDerivEl.style.display = '';
      $('rail-deriv')?.classList.add('active');
      $('mbr-deriv')?.classList.add('active');

      // Mobile scroll
      if (window.innerWidth <= 1099 && stageDerivEl) {
        stageDerivEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      // Let original handler deal with other stages
      origShowStage?.(stage);
    }
  };

  // ── Rail / mobile nav ────────────────────────────────────────
  $('rail-deriv')?.addEventListener('click', () => window.__atlShowStage('deriv'));
  $('mbr-deriv')?.addEventListener('click',  () => window.__atlShowStage('deriv'));

  // ── Exchange toggles ─────────────────────────────────────────
  document.querySelectorAll('#ds-exchange-toggle .smc-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ds-exchange-toggle .smc-toggle')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedExchange = btn.dataset.val;
    });
  });

  // ── TF toggles ───────────────────────────────────────────────
  document.querySelectorAll('#ds-tf-toggle .smc-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ds-tf-toggle .smc-toggle')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTF = btn.dataset.val;
    });
  });

  // ── Scan / abort buttons ─────────────────────────────────────
  $('ds-scan-btn')?.addEventListener('click',  startScan);
  $('ds-abort-btn')?.addEventListener('click', () => {
    abortDerivScan();
    setStatus('Aborting…', '#ffd54f');
  });

  // ── Direction filter pills ───────────────────────────────────
  document.querySelectorAll('#ds-filter-row .ds-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ds-filter-row .ds-filter')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderResults(scanResults, btn.dataset.filter);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  STATUS / UI HELPERS
// ═══════════════════════════════════════════════════════════════
function setStatus(msg, color) {
  const el = $('ds-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--muted)';
}

function setScanningUI(active) {
  isScanning = active;
  const scanBtn  = $('ds-scan-btn');
  const abortBtn = $('ds-abort-btn');
  if (scanBtn)  scanBtn.style.display  = active ? 'none' : '';
  if (abortBtn) abortBtn.style.display = active ? ''     : 'none';
  window.__atlSetStatus?.(active ? 'loading' : 'live');
}

function renderEmpty(msg) {
  const el = $('ds-results');
  if (!el) return;
  el.innerHTML = `
    <div class="ds-empty">
      <div class="ds-empty-glyph">◈</div>
      <div>${msg || 'SELECT EXCHANGE + TIMEFRAME AND PRESS SCAN'}</div>
      <div style="font-size:9px;color:var(--muted);margin-top:6px;max-width:320px;text-align:center">
        Coins passing all 3 gates: HTF Structure · Funding Alignment · Derivatives Confluence
      </div>
    </div>`;
}

// Progress ring update
function updateRing(pct) {
  const ring = $('ds-progress-ring');
  if (ring) ring.style.background = `conic-gradient(var(--green) ${pct * 3.6}deg, var(--bg3) 0deg)`;
}

// ═══════════════════════════════════════════════════════════════
//  SCAN FLOW
// ═══════════════════════════════════════════════════════════════
function startScan() {
  scanResults = [];

  const resultsEl = $('ds-results');
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="smc-scan-progress">
        <div class="smc-progress-ring" id="ds-progress-ring"></div>
        <div id="ds-progress-text" class="smc-progress-text">Initialising 3-gate funnel…</div>
      </div>
      <div id="ds-gate-strip" class="ds-gate-strip">
        ${['Gate 1 · SMC Pre-screen', 'Gate 2 · Funding Alignment', 'Gate 3 · Deriv Score'].map((label, i) => `
          <div class="ds-gate-row" id="ds-gate-row-${i + 1}">
            <span class="ds-gate-num">${i + 1}</span>
            <span class="ds-gate-label">${label}</span>
            <span class="ds-gate-count" id="ds-gate-count-${i + 1}">—</span>
            <div class="ds-gate-bar-wrap">
              <div class="ds-gate-bar" id="ds-gate-bar-${i + 1}" style="width:0%"></div>
            </div>
          </div>`).join('')}
      </div>`;
  }

  setScanningUI(true);
  setStatus(`Scanning ${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'} · ${selectedTF.toUpperCase()} · 3-gate funnel`, '#ffd54f');

  // Reset filter pills
  document.querySelectorAll('#ds-filter-row .ds-filter').forEach(b => b.classList.remove('active'));
  document.querySelector('#ds-filter-row .ds-filter[data-filter="all"]')?.classList.add('active');

  let g1Total = 0, g2Total = 0, g3Total = 0;

  runDerivScan({
    exchange: selectedExchange,
    tf:       selectedTF,

    onProgress({ phase, done, total, msg }) {
      const textEl = $('ds-progress-text');
      if (textEl) textEl.textContent = msg;
      setStatus(msg);

      if (phase === 'gate1' && done && total) {
        const pct = Math.round((done / total) * 33);
        updateRing(pct);
        const bar = $('ds-gate-bar-1');
        if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
        // Extract passed count from msg
        const m = msg.match(/(\d+) passed/);
        if (m) {
          g1Total = parseInt(m[1]);
          const cnt = $('ds-gate-count-1');
          if (cnt) cnt.textContent = `${g1Total} passed`;
        }
        const row = $('ds-gate-row-1');
        if (row) row.classList.add('ds-gate-row--active');
      }

      if (phase === 'gate2') {
        updateRing(40);
        const m = msg.match(/(\d+) passed/);
        if (m) {
          g2Total = parseInt(m[1]);
          const cnt = $('ds-gate-count-2');
          if (cnt) cnt.textContent = `${g2Total} passed`;
          const bar = $('ds-gate-bar-2');
          if (bar && g1Total > 0) bar.style.width = `${Math.round((g2Total / g1Total) * 100)}%`;
        }
        const row = $('ds-gate-row-2');
        if (row) row.classList.add('ds-gate-row--active');
      }

      if (phase === 'gate3' && done && total) {
        const pct = 40 + Math.round((done / total) * 60);
        updateRing(pct);
        const m = msg.match(/(\d+) final/);
        if (m) {
          g3Total = parseInt(m[1]);
          const cnt = $('ds-gate-count-3');
          if (cnt) cnt.textContent = `${g3Total} qualified`;
          const bar = $('ds-gate-bar-3');
          if (bar && g2Total > 0) bar.style.width = `${Math.round((g3Total / g2Total) * 100)}%`;
        }
        const row = $('ds-gate-row-3');
        if (row) row.classList.add('ds-gate-row--active');
      }
    },

    onResult(result) {
      scanResults.push(result);
      // Stream into results as they arrive — replace gate strip area
      if (!$('ds-live-grid')) {
        const resultsEl = $('ds-results');
        if (resultsEl) {
          // Keep gate strip, add live grid below
          const liveGrid = document.createElement('div');
          liveGrid.id = 'ds-live-grid';
          liveGrid.className = 'ds-result-grid';
          resultsEl.appendChild(liveGrid);
        }
      }
      const grid = $('ds-live-grid');
      if (grid) {
        const card = document.createElement('div');
        card.innerHTML = buildResultCard(result);
        grid.appendChild(card.firstElementChild);
      }
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);
      scanResults = results;
      updateRing(100);

      const longs  = results.filter(r => r.dir === 'bull').length;
      const shorts = results.filter(r => r.dir === 'bear').length;
      const prime  = results.filter(r => r.convLabel === 'PRIME').length;

      if (aborted) {
        setStatus(`Aborted · ${results.length} coins passed all 3 gates`, '#ffd54f');
      } else if (!results.length) {
        setStatus(`Scan complete · ${total} pairs scanned · No coins passed all 3 gates`, '#ffd54f');
        renderEmpty('No coins passed all 3 gates on this scan');
      } else {
        setStatus(
          `Done · ${total} scanned · ${results.length} passed all gates · ${prime} PRIME · ${longs}↑ ${shorts}↓`,
          '#00e676'
        );
        renderResults(results, 'all');
      }

      window.__atlSetStatus?.('live');
    },

    onError(msg) {
      setScanningUI(false);
      setStatus(`Error: ${msg}`, '#ff4444');
      renderEmpty(`Error: ${msg}`);
    },
  });
}

// ═══════════════════════════════════════════════════════════════
//  RENDER RESULTS
// ═══════════════════════════════════════════════════════════════
function renderResults(results, filter = 'all') {
  const el = $('ds-results');
  if (!el) return;

  let filtered = results;
  if (filter === 'long')  filtered = results.filter(r => r.dir === 'bull');
  if (filter === 'short') filtered = results.filter(r => r.dir === 'bear');
  if (filter === 'prime') filtered = results.filter(r => r.convLabel === 'PRIME');

  // Update pill counts
  const pillAll   = document.querySelector('.ds-filter[data-filter="all"] .ds-pill-count');
  const pillLong  = document.querySelector('.ds-filter[data-filter="long"] .ds-pill-count');
  const pillShort = document.querySelector('.ds-filter[data-filter="short"] .ds-pill-count');
  const pillPrime = document.querySelector('.ds-filter[data-filter="prime"] .ds-pill-count');
  if (pillAll)   pillAll.textContent   = results.length;
  if (pillLong)  pillLong.textContent  = results.filter(r => r.dir === 'bull').length;
  if (pillShort) pillShort.textContent = results.filter(r => r.dir === 'bear').length;
  if (pillPrime) pillPrime.textContent = results.filter(r => r.convLabel === 'PRIME').length;

  if (!filtered.length) {
    el.innerHTML = `<div class="ds-empty"><div class="ds-empty-glyph">◎</div><div>No results for this filter</div></div>`;
    return;
  }

  // Summary header
  const longs  = results.filter(r => r.dir === 'bull').length;
  const shorts = results.filter(r => r.dir === 'bear').length;
  const prime  = results.filter(r => r.convLabel === 'PRIME').length;

  el.innerHTML = `
    <div class="ds-summary-bar">
      <div class="ds-summary-item">
        <span class="ds-summary-label">TOTAL QUALIFIED</span>
        <span class="ds-summary-val">${results.length}</span>
      </div>
      <div class="ds-summary-item">
        <span class="ds-summary-label">LONG SETUPS</span>
        <span class="ds-summary-val" style="color:var(--green)">${longs}</span>
      </div>
      <div class="ds-summary-item">
        <span class="ds-summary-label">SHORT SETUPS</span>
        <span class="ds-summary-val" style="color:var(--red)">${shorts}</span>
      </div>
      <div class="ds-summary-item">
        <span class="ds-summary-label">PRIME SETUPS</span>
        <span class="ds-summary-val" style="color:var(--green)">${prime}</span>
      </div>
    </div>
    <div class="ds-result-grid">${filtered.map(r => buildResultCard(r)).join('')}</div>`;
}

// ═══════════════════════════════════════════════════════════════
//  RESULT CARD
//  Each card shows:
//    • Symbol + bias + price + conviction badge
//    • 3-gate status row (pass/fail with reason)
//    • Deriv score bar + component breakdown
//    • Funding display (raw + normalised)
//    • OI trend + basis direction + spread
// ═══════════════════════════════════════════════════════════════
function buildResultCard(r) {
  const isLong   = r.dir === 'bull';
  const accentCol = isLong ? '#00e676' : '#ff4444';
  const bgAccent  = isLong ? 'rgba(0,230,118,0.06)' : 'rgba(255,68,68,0.06)';

  // Gate rows
  const gateRows = [
    { label: 'SMC',       pass: r.g1.pass, detail: r.g1.reason,  extra: `SMC ${r.g1.smcScore}/3` },
    { label: 'FUNDING',   pass: r.g2.pass, detail: r.g2.reason,  extra: r.fundingStr },
    { label: 'DERIV',     pass: r.g3.pass, detail: r.g3.reason,  extra: `Score ${r.derivScore}/100` },
  ].map(g => `
    <div class="ds-card-gate ${g.pass ? 'ds-gate-pass' : 'ds-gate-fail'}">
      <span class="ds-gate-icon">${g.pass ? '✓' : '✗'}</span>
      <span class="ds-gate-name">${g.label}</span>
      <span class="ds-gate-extra">${g.extra}</span>
      <span class="ds-gate-detail">${g.desc || g.detail}</span>
    </div>`).join('');

  // Deriv score bar
  const dsCol   = r.derivColor || '#ffd54f';
  const dsWidth = r.derivScore;

  // Component bars (compact)
  const compRows = r.components
    ? Object.entries(r.components).map(([k, c]) => {
        const col = c.score >= 60 ? '#00e676' : c.score <= 40 ? '#ff4444' : '#ffd54f';
        return `<div class="ds-comp-row">
          <span class="ds-comp-label">${c.label}</span>
          <div class="ds-comp-bar-wrap">
            <div class="ds-comp-bar" style="width:${c.score}%;background:${col}"></div>
          </div>
          <span class="ds-comp-score" style="color:${col}">${c.score}</span>
        </div>`;
      }).join('')
    : '';

  // OI trend tag
  const oiTag = r.oiTrend === 'rising'
    ? `<span class="ds-tag ds-tag--green">OI ▲</span>`
    : r.oiTrend === 'falling'
    ? `<span class="ds-tag ds-tag--red">OI ▼</span>`
    : '';

  // Basis tag
  const basisTag = r.basisDir === 'contracting'
    ? `<span class="ds-tag ds-tag--green">BASIS ↘</span>`
    : r.basisDir === 'expanding'
    ? `<span class="ds-tag ds-tag--red">BASIS ↗</span>`
    : `<span class="ds-tag ds-tag--muted">BASIS —</span>`;

  // Insurance stress
  const insStress = r.insuranceTrend?.stressed
    ? `<span class="ds-tag ds-tag--red">⚠ INSUR STRESS</span>`
    : '';

  // Spread tag
  const spreadTag = r.spread != null
    ? `<span class="ds-tag ds-tag--muted">SPR ${r.spread.toFixed(3)}%</span>`
    : '';

  return `
    <div class="ds-card" style="--ds-accent:${accentCol};--ds-bg:${bgAccent}">

      <!-- Card header -->
      <div class="ds-card-header">
        <div class="ds-card-left">
          <span class="ds-card-ticker">${r.symbol}</span>
          <span class="ds-card-bias" style="color:${accentCol}">${r.biasLabel}</span>
        </div>
        <div class="ds-card-right">
          <span class="ds-conv-badge" style="color:${r.convColor};border-color:${r.convColor}20;background:${r.convColor}12">
            ${r.convLabel} ${r.conviction}
          </span>
          <span class="ds-card-price">$${formatDerivPrice(r.price)}</span>
        </div>
      </div>

      <!-- Funding row -->
      <div class="ds-card-funding">
        <span class="ds-funding-label">FUNDING</span>
        <span class="ds-funding-val" style="color:${r.fundingDir === 'negative' ? '#00e676' : r.fundingDir === 'positive' ? '#ff4444' : '#ffd54f'}">
          ${r.fundingStr}
        </span>
      </div>

      <!-- 3-gate breakdown -->
      <div class="ds-card-gates">${gateRows}</div>

      <!-- Deriv score gauge -->
      <div class="ds-card-deriv">
        <div class="ds-deriv-header">
          <span class="ds-deriv-label">DERIV SCORE</span>
          <span class="ds-deriv-val" style="color:${dsCol}">${r.derivScore}/100 · ${r.derivLabel}</span>
        </div>
        <div class="ds-deriv-bar-wrap">
          <div class="ds-deriv-bar" style="width:${dsWidth}%;background:${dsCol}"></div>
        </div>
        <div class="ds-comp-grid">${compRows}</div>
      </div>

      <!-- Signal tags row -->
      <div class="ds-card-tags">
        ${oiTag}${basisTag}${insStress}${spreadTag}
      </div>

    </div>`;
}

// ── Boot ───────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
