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

  // ── Gate strip: fixed above ds-results, never wiped by results rendering ──
  const stageEl = $('stage-deriv');
  let gateStrip = $('ds-gate-strip-fixed');

  // Remove old strip if re-scanning
  if (gateStrip) gateStrip.remove();
  gateStrip = document.createElement('div');
  gateStrip.id = 'ds-gate-strip-fixed';
  gateStrip.className = 'ds-gate-strip-fixed';
  gateStrip.innerHTML = `
    <div class="ds-strip-header">
      <div class="smc-progress-ring" id="ds-progress-ring" style="width:32px;height:32px;flex-shrink:0;border-radius:50%"></div>
      <div style="flex:1;min-width:0">
        <div id="ds-progress-text" class="smc-progress-text">Initialising 3-gate funnel…</div>
        <div id="ds-scan-sub" style="font-size:8px;color:var(--muted);margin-top:2px;font-family:var(--font-mono)">Fetching pairs + funding intervals + insurance fund</div>
      </div>
    </div>
    <div class="ds-gate-rows">
      ${[
        { num: 1, label: 'Gate 1 · SMC Pre-screen',    sub: 'HTF structure · P/D zone · OB proximity' },
        { num: 2, label: 'Gate 2 · Funding Alignment', sub: 'Normalised rate · contrarian imbalance ≥ 0.10%/8h' },
        { num: 3, label: 'Gate 3 · Deriv Score',       sub: 'calcDerivScore ≥ 58 long / ≤ 42 short' },
      ].map(g => `
        <div class="ds-gate-row" id="ds-gate-row-${g.num}">
          <div class="ds-gate-row-left">
            <span class="ds-gate-icon" id="ds-gate-icon-${g.num}">○</span>
            <div>
              <div class="ds-gate-label">${g.label}</div>
              <div class="ds-gate-sub">${g.sub}</div>
            </div>
          </div>
          <div class="ds-gate-row-right">
            <span class="ds-gate-count" id="ds-gate-count-${g.num}">waiting</span>
            <div class="ds-gate-bar-wrap">
              <div class="ds-gate-bar" id="ds-gate-bar-${g.num}" style="width:0%"></div>
            </div>
          </div>
        </div>`).join('')}
    </div>`;

  const resultsEl = $('ds-results');
  if (resultsEl && stageEl) stageEl.insertBefore(gateStrip, resultsEl);

  // ── Results area: show waiting state, separate from gate strip ──
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="ds-empty" id="ds-waiting-msg" style="min-height:120px">
        <div class="ds-empty-glyph" style="font-size:20px;margin-bottom:8px">◈</div>
        <div style="font-size:9px;letter-spacing:0.1em">RUNNING GATE 1 OF 3…</div>
      </div>`;
  }

  setScanningUI(true);
  setStatus(`Scanning ${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'} · ${selectedTF.toUpperCase()} · 3-gate funnel`, '#ffd54f');

  document.querySelectorAll('#ds-filter-row .ds-filter').forEach(b => b.classList.remove('active'));
  document.querySelector('#ds-filter-row .ds-filter[data-filter="all"]')?.classList.add('active');

  let g1Passed = 0, g2Passed = 0, g1Total = 0;

  runDerivScan({
    exchange: selectedExchange,
    tf:       selectedTF,

    onProgress({ phase, done, total, msg }) {
      const textEl = $('ds-progress-text');
      const subEl  = $('ds-scan-sub');
      if (textEl) textEl.textContent = msg;
      setStatus(msg);

      if (phase === 'init') {
        if (subEl) subEl.textContent = 'Fetching pairs + funding intervals + insurance fund…';
        return;
      }

      if (phase === 'start') {
        g1Total = total;
        if (subEl) subEl.textContent = `${total} pairs found — gate 1 starting`;
        activateGateRow(1);
        updateWaiting('Gate 1 · SMC pre-screen running…');
        return;
      }

      if (phase === 'gate1' && done && total) {
        updateRing(Math.round((done / total) * 33));
        setGateBar(1, Math.round((done / total) * 100));
        const m = msg.match(/(\d+) passed/);
        if (m) { g1Passed = parseInt(m[1]); setGateCount(1, `${g1Passed} / ${total} passed`); }
        else { setGateCount(1, `${done} / ${total} scanned`); }
        updateWaiting(`Gate 1 · ${done}/${total} · ${g1Passed} passed SMC`);
        return;
      }

      if (phase === 'gate2') {
        // G1 done — mark complete, activate G2
        completeGateRow(1, g1Passed);
        activateGateRow(2);
        updateRing(38);
        const m = msg.match(/(\d+) passed/);
        if (m) {
          g2Passed = parseInt(m[1]);
          setGateCount(2, `${g2Passed} / ${g1Passed} passed`);
          setGateBar(2, g1Passed > 0 ? Math.round((g2Passed / g1Passed) * 100) : 0);
        }
        completeGateRow(2, g2Passed);
        activateGateRow(3);
        if (subEl) subEl.textContent = `${g2Passed} coins reached gate 3 — scoring derivatives`;
        updateWaiting(`Gate 2 complete · ${g2Passed} reached gate 3 · scoring derivatives…`);
        return;
      }

      if (phase === 'gate3' && done && total) {
        updateRing(38 + Math.round((done / total) * 62));
        setGateBar(3, Math.round((done / total) * 100));
        const m = msg.match(/(\d+) final/);
        const qualified = m ? parseInt(m[1]) : scanResults.length;
        setGateCount(3, `${qualified} / ${total} qualified`);
        updateWaiting(`Gate 3 · ${done}/${total} scored · ${qualified} qualified`);
        return;
      }
    },

    onResult(result) {
      // Accumulate only — do NOT render yet, gate strip must stay visible
      scanResults.push(result);
      updateWaiting(`Gate 3 running · ${scanResults.length} qualified so far`);
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);
      scanResults = results;
      updateRing(100);

      // Mark gate 3 complete with final count
      completeGateRow(3, results.length);

      // Update strip sub-text with final summary
      const subEl = $('ds-scan-sub');
      const textEl = $('ds-progress-text');
      if (textEl) textEl.textContent = aborted ? 'Scan aborted' : 'Scan complete';

      if (subEl) {
        if (aborted) {
          subEl.textContent = `Aborted · ${results.length} coins passed all gates`;
          subEl.style.color = '#ffd54f';
        } else if (!results.length) {
          subEl.textContent = `No coins passed all 3 gates on this scan`;
          subEl.style.color = '#ffd54f';
        } else {
          const longs  = results.filter(r => r.dir === 'bull').length;
          const shorts = results.filter(r => r.dir === 'bear').length;
          const prime  = results.filter(r => r.convLabel === 'PRIME').length;
          subEl.textContent = `${results.length} coins passed all gates · ${prime} PRIME · ${longs}↑ ${shorts}↓`;
          subEl.style.color = '#00e676';
        }
      }

      // Status bar
      if (aborted) {
        setStatus(`Aborted · ${results.length} coins passed all 3 gates`, '#ffd54f');
      } else if (!results.length) {
        setStatus(`Scan complete · ${total} scanned · No coins passed all 3 gates`, '#ffd54f');
      } else {
        const longs  = results.filter(r => r.dir === 'bull').length;
        const shorts = results.filter(r => r.dir === 'bear').length;
        const prime  = results.filter(r => r.convLabel === 'PRIME').length;
        setStatus(`Done · ${total} scanned · ${results.length} passed · ${prime} PRIME · ${longs}↑ ${shorts}↓`, '#00e676');
      }

      // Hold gate strip visible for 2.5s so user can read the summary, then show results
      setTimeout(() => {
        const gs = $('ds-gate-strip-fixed');
        if (gs) gs.classList.add('ds-gate-strip--collapsed');
        setTimeout(() => {
          const gs2 = $('ds-gate-strip-fixed');
          if (gs2) gs2.style.display = 'none';
          if (!results.length) {
            renderEmpty(aborted ? 'Scan aborted' : 'No coins passed all 3 gates on this scan');
          } else {
            renderResults(results, 'all');
          }
        }, 320);
      }, 2500);

      window.__atlSetStatus?.('live');
    },

    onError(msg) {
      setScanningUI(false);
      const gs = $('ds-gate-strip-fixed');
      if (gs) gs.style.display = 'none';
      setStatus(`Error: ${msg}`, '#ff4444');
      renderEmpty(`Error: ${msg}`);
    },
  });
}

// ── Gate strip helpers ─────────────────────────────────────────
function activateGateRow(num) {
  const row  = $(`ds-gate-row-${num}`);
  const icon = $(`ds-gate-icon-${num}`);
  if (row)  row.classList.add('ds-gate-row--active');
  if (icon) { icon.textContent = '●'; icon.style.color = '#ffd54f'; }
}

function completeGateRow(num, passCount) {
  const row  = $(`ds-gate-row-${num}`);
  const icon = $(`ds-gate-icon-${num}`);
  if (row)  { row.classList.remove('ds-gate-row--active'); row.classList.add('ds-gate-row--done'); }
  if (icon) { icon.textContent = '✓'; icon.style.color = '#00e676'; }
  setGateBar(num, 100);
  if (passCount != null) setGateCount(num, `${passCount} passed`);
}

function setGateBar(num, pct) {
  const bar = $(`ds-gate-bar-${num}`);
  if (bar) bar.style.width = `${pct}%`;
}

function setGateCount(num, text) {
  const cnt = $(`ds-gate-count-${num}`);
  if (cnt) cnt.textContent = text;
}

function updateWaiting(text) {
  const el = $('ds-waiting-msg');
  if (!el) return;
  const sub = el.querySelector('div:last-child');
  if (sub) sub.textContent = text;
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
