// ATL · SMC Scanner UI Controller
// Handles rail switching, control state, progress updates, result streaming

import { runScan, abortScan, renderHeatmap, runMultiTFScan, COMMON_TFS } from './smc-scanner.js';

// ── State ──────────────────────────────────────────────────────
let selectedExchange = 'bybit';
let selectedTF       = '1h';
let scanResults      = [];

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function init() {
  // ── Rail switching ───────────────────────────────────────────
  const railAnalysis = $('rail-analysis');
  const railSMC      = $('rail-smc');
  const stageAnalysis = $('stage-analysis');
  const stageSMC      = $('stage-smc');
  const topStrip      = $('top-strip');

  const stageWrap = $('stage');

  const stageFunding  = $('stage-funding');
  const railFunding   = $('rail-funding');
  const stageDeriv    = $('stage-deriv');
  const railDeriv     = $('rail-deriv');

  function showStage(stage) {
    // Hide all stages first
    stageAnalysis.style.display = 'none';
    stageSMC.style.display      = 'none';
    if (stageFunding) stageFunding.style.display = 'none';
    if (stageDeriv)   stageDeriv.style.display   = 'none';
    if (topStrip) topStrip.style.display = 'none';
    if (stageWrap) stageWrap.classList.remove('smc-active');

    // Clear all nav active states
    railAnalysis?.classList.remove('active');
    railSMC?.classList.remove('active');
    railFunding?.classList.remove('active');
    railDeriv?.classList.remove('active');
    document.getElementById('mbr-analysis')?.classList.remove('active');
    document.getElementById('mbr-smc')?.classList.remove('active');
    document.getElementById('mbr-funding')?.classList.remove('active');
    document.getElementById('mbr-deriv')?.classList.remove('active');

    if (stage === 'analysis') {
      stageAnalysis.style.display = '';
      if (topStrip) topStrip.style.display = '';
      railAnalysis?.classList.add('active');
      document.getElementById('mbr-analysis')?.classList.add('active');

    } else if (stage === 'smc') {
      stageSMC.style.display = '';
      if (stageWrap) stageWrap.classList.add('smc-active');
      railSMC?.classList.add('active');
      document.getElementById('mbr-smc')?.classList.add('active');
      if (window.innerWidth <= 1099) {
        stageSMC.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

    } else if (stage === 'funding') {
      if (stageFunding) stageFunding.style.display = '';
      railFunding?.classList.add('active');
      document.getElementById('mbr-funding')?.classList.add('active');
      if (window.innerWidth <= 1099 && stageFunding) {
        stageFunding.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

    } else if (stage === 'deriv') {
      if (stageDeriv) stageDeriv.style.display = '';
      if (stageWrap) stageWrap.classList.add('smc-active');
      railDeriv?.classList.add('active');
      document.getElementById('mbr-deriv')?.classList.add('active');
      if (window.innerWidth <= 1099 && stageDeriv) {
        stageDeriv.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // Expose globally so funding-scanner-ui can call it
  window.__atlShowStage = showStage;

  railAnalysis?.addEventListener('click', () => showStage('analysis'));
  railSMC?.addEventListener('click', () => showStage('smc'));
  railFunding?.addEventListener('click', () => showStage('funding'));

  // ── Mobile bottom rail ──────────────────────────────────────
  document.getElementById('mbr-analysis')?.addEventListener('click', () => showStage('analysis'));
  document.getElementById('mbr-smc')?.addEventListener('click', () => showStage('smc'));
  document.getElementById('mbr-funding')?.addEventListener('click', () => showStage('funding'));

  // ── Exchange toggle ──────────────────────────────────────────
  document.querySelectorAll('#smc-exchange-toggle .smc-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#smc-exchange-toggle .smc-toggle')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedExchange = btn.dataset.val;
    });
  });

  // ── TF toggle ───────────────────────────────────────────────
  document.querySelectorAll('#smc-tf-toggle .smc-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#smc-tf-toggle .smc-toggle')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTF = btn.dataset.val;
    });
  });

  // ── Scan button ──────────────────────────────────────────────
  $('smc-scan-btn')?.addEventListener('click', startScan);
  $('smc-abort-btn')?.addEventListener('click', () => {
    abortScan();
    setStatus('Aborting…');
  });
  $('smc-common-scan-btn')?.addEventListener('click', startCommonScan);
}

// ── Progress / status helpers ──────────────────────────────────
function setStatus(msg, color) {
  const el = $('smc-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--muted)';
}

function setScanningUI(active) {
  const scanBtn       = $('smc-scan-btn');
  const abortBtn      = $('smc-abort-btn');
  const commonScanBtn = $('smc-common-scan-btn');
  if (scanBtn)       scanBtn.style.display       = active ? 'none' : '';
  if (abortBtn)      abortBtn.style.display      = active ? '' : 'none';
  if (commonScanBtn) commonScanBtn.style.display = active ? 'none' : '';

  // Status dot
  if (window.__atlSetStatus) {
    window.__atlSetStatus(active ? 'loading' : 'live');
  }
}

// ── Common Scan entry point ────────────────────────────────────
function startCommonScan() {
  const heatmap       = $('smc-heatmap');
  const commonSection = $('smc-common-results');

  // Reset heatmap area, show multi-TF progress
  if (heatmap) {
    heatmap.innerHTML = `
      <div class="smc-scan-progress">
        <div class="smc-progress-ring" id="smc-common-ring"></div>
        <div id="smc-progress-text" class="smc-progress-text">Starting multi-TF scan…</div>
      </div>`;
  }
  if (commonSection) commonSection.innerHTML = '';

  setScanningUI(true);
  setStatus(`Common Scan · ${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'} · ALL TFs`, '#ffd54f');

  // Track per-TF progress for the 5-bar strip
  const tfProgress = { '15m': 0, '1h': 0, '4h': 0, '1d': 0, '1w': 0 };

  runMultiTFScan({
    exchange: selectedExchange,

    onProgress({ phase, tf, msg, done, total }) {
      const el = $('smc-progress-text');
      if (el) el.textContent = msg;
      setStatus(msg);

      if (phase === 'scanning' && done && total) {
        const pct = Math.round((done / total) * 100);
        if (tf) tfProgress[tf] = pct;

        // Overall progress = average across all TFs
        const overall = Math.round(
          Object.values(tfProgress).reduce((s, v) => s + v, 0) / COMMON_TFS.length
        );
        const ring = $('smc-common-ring');
        if (ring) {
          ring.style.background = `conic-gradient(var(--green) ${overall * 3.6}deg, var(--bg3) 0deg)`;
        }

        // Update TF progress strip if it exists
        if (tf) {
          const bar = $(`smc-tf-bar-${tf}`);
          if (bar) bar.style.width = `${pct}%`;
          const label = $(`smc-tf-pct-${tf}`);
          if (label) label.textContent = `${pct}%`;
        }
      }

      // Build/update the TF progress strip after pairs are fetched
      if (phase === 'tf-start') {
        const strip = $('smc-tf-progress-strip');
        if (!strip && heatmap) {
          const stripEl = document.createElement('div');
          stripEl.id = 'smc-tf-progress-strip';
          stripEl.className = 'smc-tf-strip';
          stripEl.innerHTML = COMMON_TFS.map(t => `
            <div class="smc-tf-strip-row">
              <span class="smc-tf-strip-label">${t.toUpperCase()}</span>
              <div class="smc-tf-strip-track">
                <div class="smc-tf-strip-fill" id="smc-tf-bar-${t}"></div>
              </div>
              <span class="smc-tf-strip-pct" id="smc-tf-pct-${t}">0%</span>
            </div>`).join('');
          // Insert after the progress ring div
          const progressDiv = heatmap.querySelector('.smc-scan-progress');
          if (progressDiv) progressDiv.appendChild(stripEl);
        }
        // Highlight active TF row
        COMMON_TFS.forEach(t => {
          const row = $(`smc-tf-bar-${t}`)?.closest('.smc-tf-strip-row');
          if (row) row.classList.toggle('smc-tf-strip-active', t === tf);
        });
      }
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);

      if (aborted) {
        setStatus(`Aborted · ${results.length} coins common across all TFs`, '#ffd54f');
      } else {
        setStatus(
          `Done · ${total} pairs scanned · ${results.length} coin${results.length !== 1 ? 's' : ''} qualified on ALL 5 TFs`,
          '#00e676'
        );
      }

      if (window.__atlSetStatus) window.__atlSetStatus('live');
      renderCommonHeatmap($('smc-heatmap'), results);
    },

    onError(msg) {
      setScanningUI(false);
      setStatus(`Error: ${msg}`, '#ff4444');
      const heatmap = $('smc-heatmap');
      if (heatmap) {
        heatmap.innerHTML = `
          <div class="smc-empty">
            <div class="smc-empty-glyph">✗</div>
            <div style="color:#ff4444">${msg}</div>
          </div>`;
      }
    },
  });
}

// ── Common Scan Result Renderer ────────────────────────────────
function renderCommonHeatmap(container, results) {
  if (!results.length) {
    container.innerHTML = `
      <div class="smc-empty">
        <div class="smc-empty-glyph">◎</div>
        <div>No coins qualified on all 5 timeframes</div>
        <div style="font-size:9px;color:var(--muted);margin-top:6px">
          Common scan requires 6+/7 on 15M · 1H · 4H · 1D · 1W simultaneously
        </div>
      </div>`;
    return;
  }

  const scoreColor = s => {
    if (s === 7) return '#00e676';
    if (s === 6) return '#69f0ae';
    return '#ffd54f';
  };

  const totalColor = t => {
    if (t >= 33) return '#00e676';
    if (t >= 30) return '#69f0ae';
    if (t >= 27) return '#ffd54f';
    return '#ff8f00';
  };

  const cells = results.map(r => {
    const col   = totalColor(r.totalScore);
    const bgCol = r.totalScore >= 33 ? 'rgba(0,230,118,0.10)'
                : r.totalScore >= 30 ? 'rgba(105,240,174,0.07)'
                : r.totalScore >= 27 ? 'rgba(255,213,79,0.07)'
                : 'rgba(255,143,0,0.06)';

    // Per-TF score badges
    const tfBadges = COMMON_TFS.map(tf => {
      const d = r.tfData[tf];
      const s = d?.score ?? '—';
      const c = d ? scoreColor(d.score) : '#5a6470';
      return `<div class="smc-common-tf-badge">
        <span class="smc-common-tf-name">${tf.toUpperCase()}</span>
        <span class="smc-common-tf-score" style="color:${c}">${s}/7</span>
      </div>`;
    }).join('');

    // Gate breakdown from 1h (most useful reference TF)
    const refResult = r.tfData['1h'] || r.tfData['4h'] || Object.values(r.tfData)[0];
    const gateRows = refResult?.gates?.map(g => `
      <div class="smc-hover-gate ${g.pass ? 'gate-pass' : 'gate-fail'}">
        <span class="gate-icon">${g.pass ? '✓' : '✗'}</span>
        <span class="gate-label">${g.label}</span>
        <span class="gate-desc">${g.desc}</span>
      </div>`).join('') || '';

    return `
      <div class="smc-cell smc-common-cell" style="--cell-col:${col};--cell-bg:${bgCol}">
        <div class="smc-cell-inner">
          <div class="smc-cell-ticker">${r.symbol}</div>
          <div class="smc-common-badge-row">${tfBadges}</div>
          <div class="smc-cell-score" style="color:${col}">${r.totalScore}/35</div>
          <div class="smc-cell-bias" style="color:${r.biasColor}">${r.biasLabel}</div>
          <div class="smc-cell-price">$${formatScanPrice(r.price)}</div>
        </div>
        <div class="smc-hover-card">
          <div class="smc-hover-header">
            <span class="smc-hover-sym">${r.symbol}/USDT</span>
            <span class="smc-hover-tf">ALL TFs · ${r.exchange === 'bybit' ? 'Bybit' : 'Binance'}</span>
          </div>
          <div class="smc-hover-price">$${formatScanPrice(r.price)}</div>
          <div class="smc-hover-bias" style="color:${r.biasColor}">${r.biasLabel}</div>
          <div class="smc-common-badge-row smc-common-badge-row--hover">${tfBadges}</div>
          <div class="smc-hover-stats">
            <span>Total <b style="color:${col}">${r.totalScore}/35</b></span>
            <span>Funding <b style="color:${r.fundingRate < 0 ? '#00e676' : r.fundingRate > 0.05 ? '#ff4444' : '#ffd54f'}">${r.fundingRate?.toFixed(4) ?? '—'}%</b></span>
            <span>RSI <b>${r.rsi?.toFixed(1) ?? '—'}</b></span>
          </div>
          <div style="font-size:9px;color:var(--muted);margin-bottom:6px;padding:0 12px">1H Gate Breakdown</div>
          <div class="smc-hover-gates">${gateRows}</div>
        </div>
      </div>`;
  }).join('');

  // Header banner explaining the result
  container.innerHTML = `
    <div class="smc-common-header">
      <span class="smc-common-header-label">◈ MULTI-TF CONFLUENCE</span>
      <span class="smc-common-header-sub">${results.length} coin${results.length !== 1 ? 's' : ''} scored 6+/7 on ALL 5 TIMEFRAMES · sorted by total score</span>
      <span class="smc-common-header-tfs">15M · 1H · 4H · 1D · 1W</span>
    </div>
    <div class="smc-grid">${cells}</div>`;
}

// ── Scan entry point ───────────────────────────────────────────
function startScan() {
  scanResults = [];
  const heatmap = $('smc-heatmap');
  if (heatmap) {
    heatmap.innerHTML = `
      <div class="smc-scan-progress">
        <div class="smc-progress-ring"></div>
        <div id="smc-progress-text" class="smc-progress-text">Fetching pairs…</div>
      </div>`;
  }

  setScanningUI(true);
  setStatus(`Scanning ${selectedExchange === 'bybit' ? 'Bybit' : 'Binance'} · ${selectedTF.toUpperCase()}`, '#ffd54f');

  runScan({
    exchange: selectedExchange,
    tf:       selectedTF,

    onProgress({ phase, msg, done, total, partial }) {
      const el = $('smc-progress-text');
      if (el) el.textContent = msg;
      setStatus(msg);

      if (phase === 'scanning' && done && total) {
        const pct = Math.round((done / total) * 100);
        const ring = document.querySelector('.smc-progress-ring');
        if (ring) {
          ring.style.background = `conic-gradient(var(--green) ${pct * 3.6}deg, var(--bg3) 0deg)`;
        }
        if (partial != null) {
          setStatus(`${msg} · ${partial} qualified`, '#ffd54f');
        }
      }
    },

    onResult(result) {
      // Stream result into heatmap as they come in (partial render)
      scanResults.push(result);
      renderHeatmap($('smc-heatmap'), scanResults, selectedTF);
    },

    onDone({ results, total, aborted }) {
      setScanningUI(false);
      const longs  = results.filter(r => r.primaryDir === 'bull').length;
      const shorts = results.filter(r => r.primaryDir === 'bear').length;
      const prime  = results.filter(r => r.score === 7).length;

      if (aborted) {
        setStatus(`Aborted · ${results.length} qualified (6+/7) so far`, '#ffd54f');
      } else {
        setStatus(
          `Done · ${total} scanned · ${results.length} qualified (6+/7) · ${prime} prime · ${longs}↑ ${shorts}↓`,
          '#00e676'
        );
      }

      if (window.__atlSetStatus) window.__atlSetStatus('live');
      renderHeatmap($('smc-heatmap'), results, selectedTF);
    },

    onError(msg) {
      setScanningUI(false);
      setStatus(`Error: ${msg}`, '#ff4444');
      const heatmap = $('smc-heatmap');
      if (heatmap) {
        heatmap.innerHTML = `
          <div class="smc-empty">
            <div class="smc-empty-glyph">✗</div>
            <div style="color:#ff4444">${msg}</div>
          </div>`;
      }
    },
  });
}

// ── Boot ───────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
