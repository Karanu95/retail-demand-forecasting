/* ─────────────────────────────────────────────
   RETAIL FORECAST · app.js
   ───────────────────────────────────────────── */

"use strict";

/* ══ Config ══════════════════════════════════ */
const API = (window.API_BASE_URL || "").replace(/\/$/, "");

/* ══ State ═══════════════════════════════════ */
const state = {
  selectedHorizon: 7,
  forecast7:  null,   // cached 7-day forecast response
  forecast30: null,   // cached 30-day forecast response
  historyRecords: [], // full history from /history?days=730 (for Historical Data table)
  chartRecords:   [], // current chart records (for resize redraws)
  currentChartHorizon: null, // 'history' | 7 | 30
  apiOnline: null,
  lastUpdated: null,

  // Historical table pagination / filter
  histPage: 1,
  histPageSize: 20,
  histSearch: "",
  histFrom: "",
  histTo: "",
};

/* ══ DOM helpers ═════════════════════════════ */
const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const fmtDec = (n, d = 2) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });

/* ══ API fetch wrapper ═══════════════════════ */
async function apiFetch(path, options = {}) {
  if (!API || API.includes("YOUR-RENDER-SERVICE")) {
    throw new Error("Add your Render API URL in frontend/config.js first.");
  }
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `API error ${res.status}`);
  }
  return res.json();
}

/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
const SECTION_TITLES = {
  overview:    "Overview",
  forecast:    "Demand Forecast",
  history:     "Historical Data",
  performance: "Model Performance",
  about:       "About Project",
};

function navigateTo(sectionId, pushHistory = true) {
  // Hide all sections
  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(a => a.classList.remove("active"));

  const section = $(`section-${sectionId}`);
  const navItem = document.querySelector(`.nav-item[data-section="${sectionId}"]`);

  if (!section) return;
  section.classList.add("active");
  if (navItem) navItem.classList.add("active");

  // Update topbar title
  const title = SECTION_TITLES[sectionId] || sectionId;
  $("page-title").textContent = title;
  document.title = `${title} — Retail Forecast`;

  // Push hash
  if (pushHistory) history.replaceState(null, "", `#${sectionId}`);

  // Close mobile sidebar
  closeSidebar();

  // Lazy-load Historical Data table on first visit
  if (sectionId === "history" && state.historyRecords.length === 0 && state.apiOnline) {
    loadFullHistory();
  }

  // Redraw charts on section reveal (canvas needs visible dimensions)
  if (sectionId === "overview" && state.chartRecords.length) {
    requestAnimationFrame(() => drawHistoryChart(state.chartRecords));
  }
  if (sectionId === "forecast") {
    const fc = activeForecast();
    if (fc) requestAnimationFrame(() => drawForecastChart(fc));
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-item[data-section]").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      navigateTo(link.dataset.section);
    });
  });

  // Handle hash on load
  const hash = location.hash.replace("#", "");
  if (hash && SECTION_TITLES[hash]) {
    navigateTo(hash, false);
  } else {
    navigateTo("overview", false);
  }
}

/* ══════════════════════════════════════════════
   MOBILE SIDEBAR
══════════════════════════════════════════════ */
function openSidebar() {
  $("sidebar").classList.add("open");
  $("nav-overlay").classList.add("visible");
  document.body.style.overflow = "hidden";
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("nav-overlay").classList.remove("visible");
  document.body.style.overflow = "";
}

function setupSidebar() {
  $("mobile-menu-btn").addEventListener("click", openSidebar);
  $("sidebar-close").addEventListener("click", closeSidebar);
  $("nav-overlay").addEventListener("click", closeSidebar);
}

/* ══════════════════════════════════════════════
   API STATUS
══════════════════════════════════════════════ */
function setApiStatus(status) {
  // status: 'checking' | 'online' | 'offline'
  state.apiOnline = status === "online";

  const dots   = [$("sidebar-status-dot"), $("topbar-status-dot")];
  const labels = [$("sidebar-api-status"), $("topbar-api-label")];
  const texts  = { checking: "Connecting…", online: "Online", offline: "Offline" };

  dots.forEach(d => {
    if (!d) return;
    d.classList.remove("online", "offline", "checking");
    d.classList.add(status);
  });

  labels.forEach(l => {
    if (l) l.textContent = texts[status];
  });
}

function updateLastUpdated() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  state.lastUpdated = timeStr;
  const el = $("topbar-updated");
  if (el) el.textContent = `Updated ${timeStr}`;
}

/* ══════════════════════════════════════════════
   CANVAS CHART — HISTORY
══════════════════════════════════════════════ */
function drawHistoryChart(records) {
  const canvas = $("history-chart");
  if (!canvas || !records.length) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return; // not yet visible

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const PAD = { top: 16, right: 20, bottom: 32, left: 56 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);

  const vals = records.map(r => r.actual_units);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const rangePad = (maxV - minV) * 0.08 || 200;
  const lo = Math.max(0, minV - rangePad);
  const hi = maxV + rangePad;

  // ── Gridlines & Y labels ──
  const TICKS = 5;
  ctx.font = `11px Inter, sans-serif`;
  ctx.fillStyle = "#9EA5B3";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.strokeStyle = "#F0F2F7";
  ctx.lineWidth = 1;

  for (let i = 0; i <= TICKS; i++) {
    const t  = i / TICKS;
    const y  = PAD.top + chartH * (1 - t);
    const v  = lo + (hi - lo) * t;
    const lv = v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString();

    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();

    ctx.fillText(lv, PAD.left - 6, y);
  }

  // ── X axis date labels ──
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelStep = Math.max(1, Math.floor(records.length / 6));
  for (let i = 0; i < records.length; i += labelStep) {
    const r = records[i];
    const x = PAD.left + chartW * (records.length === 1 ? 0 : i / (records.length - 1));
    ctx.fillText(r.date.slice(5), x, H - PAD.bottom + 6);
  }
  // Always label last point
  const lastR = records[records.length - 1];
  const lastX = PAD.left + chartW;
  ctx.fillText(lastR.date.slice(5), lastX, H - PAD.bottom + 6);

  // ── Line ──
  const getX = i => PAD.left + chartW * (records.length === 1 ? 0 : i / (records.length - 1));
  const getY = v => PAD.top + chartH * (1 - (v - lo) / (hi - lo));

  // Smooth fill gradient
  const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + chartH);
  grad.addColorStop(0, "rgba(99,91,219,0.12)");
  grad.addColorStop(1, "rgba(99,91,219,0)");

  ctx.beginPath();
  records.forEach((r, i) => {
    if (i === 0) ctx.moveTo(getX(i), getY(r.actual_units));
    else ctx.lineTo(getX(i), getY(r.actual_units));
  });
  // Close fill path
  const fillPath = new Path2D();
  records.forEach((r, i) => {
    if (i === 0) fillPath.moveTo(getX(i), getY(r.actual_units));
    else fillPath.lineTo(getX(i), getY(r.actual_units));
  });
  fillPath.lineTo(getX(records.length - 1), PAD.top + chartH);
  fillPath.lineTo(getX(0), PAD.top + chartH);
  fillPath.closePath();
  ctx.fillStyle = grad;
  ctx.fill(fillPath);

  // Stroke line
  ctx.beginPath();
  records.forEach((r, i) => {
    if (i === 0) ctx.moveTo(getX(i), getY(r.actual_units));
    else ctx.lineTo(getX(i), getY(r.actual_units));
  });
  ctx.strokeStyle = "#635BDB";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // ── Tooltip dots on sparse records ──
  const dotStep = Math.max(1, Math.floor(records.length / 20));
  ctx.fillStyle = "#635BDB";
  records.forEach((r, i) => {
    if (i % dotStep === 0 || i === records.length - 1) {
      ctx.beginPath();
      ctx.arc(getX(i), getY(r.actual_units), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/* ══════════════════════════════════════════════
   CANVAS CHART — FORECAST (history context + predictions)
══════════════════════════════════════════════ */
function drawForecastChart(forecastData) {
  const canvas = $("forecast-chart");
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const PAD = { top: 16, right: 20, bottom: 32, left: 56 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  ctx.clearRect(0, 0, W, H);

  // Last 30 historical points for context + forecast points
  const histContext = state.chartRecords.slice(-30).map(r => ({
    date: r.date, value: r.actual_units, type: "history"
  }));
  const forecastPts = forecastData.predictions.map(p => ({
    date: p.date, value: p.predicted_units, type: "forecast"
  }));
  const all = [...histContext, ...forecastPts];
  if (!all.length) return;

  const vals = all.map(p => p.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const rangePad = (maxV - minV) * 0.1 || 200;
  const lo = Math.max(0, minV - rangePad);
  const hi = maxV + rangePad;

  const getX = i => PAD.left + chartW * (all.length === 1 ? 0 : i / (all.length - 1));
  const getY = v => PAD.top + chartH * (1 - (v - lo) / (hi - lo));

  // ── Gridlines & Y labels ──
  const TICKS = 5;
  ctx.font = `11px Inter, sans-serif`;
  ctx.fillStyle = "#9EA5B3";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.strokeStyle = "#F0F2F7";
  ctx.lineWidth = 1;

  for (let i = 0; i <= TICKS; i++) {
    const t  = i / TICKS;
    const y  = PAD.top + chartH * (1 - t);
    const v  = lo + (hi - lo) * t;
    const lv = v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString();
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.fillText(lv, PAD.left - 6, y);
  }

  // ── Divider between history and forecast ──
  const dividerIdx = histContext.length - 1;
  const dividerX = getX(dividerIdx);
  ctx.beginPath();
  ctx.moveTo(dividerX, PAD.top);
  ctx.lineTo(dividerX, PAD.top + chartH);
  ctx.strokeStyle = "#E8EAF0";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Historical line ──
  ctx.beginPath();
  histContext.forEach((p, i) => {
    if (i === 0) ctx.moveTo(getX(i), getY(p.value));
    else ctx.lineTo(getX(i), getY(p.value));
  });
  ctx.strokeStyle = "#635BDB";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  // ── Forecast line ──
  const fcStart = histContext.length - 1;
  ctx.beginPath();
  for (let i = fcStart; i < all.length; i++) {
    if (i === fcStart) ctx.moveTo(getX(i), getY(all[i].value));
    else ctx.lineTo(getX(i), getY(all[i].value));
  }
  ctx.strokeStyle = "#D69A35";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineDashOffset = 0;
  ctx.stroke();

  // ── Forecast area fill ──
  const fcGrad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + chartH);
  fcGrad.addColorStop(0, "rgba(214,154,53,0.10)");
  fcGrad.addColorStop(1, "rgba(214,154,53,0)");
  const fcFill = new Path2D();
  for (let i = fcStart; i < all.length; i++) {
    if (i === fcStart) fcFill.moveTo(getX(i), getY(all[i].value));
    else fcFill.lineTo(getX(i), getY(all[i].value));
  }
  fcFill.lineTo(getX(all.length - 1), PAD.top + chartH);
  fcFill.lineTo(getX(fcStart), PAD.top + chartH);
  fcFill.closePath();
  ctx.fillStyle = fcGrad;
  ctx.fill(fcFill);

  // ── Forecast dots ──
  ctx.fillStyle = "#D69A35";
  for (let i = fcStart + 1; i < all.length; i++) {
    ctx.beginPath();
    ctx.arc(getX(i), getY(all[i].value), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── X labels (sample) ──
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#9EA5B3";
  const totalPoints = all.length;
  const labelStep = Math.max(1, Math.floor(totalPoints / 8));
  for (let i = 0; i < totalPoints; i += labelStep) {
    ctx.fillText(all[i].date.slice(5), getX(i), H - PAD.bottom + 6);
  }
  ctx.fillText(all[all.length - 1].date.slice(5), getX(all.length - 1), H - PAD.bottom + 6);
}

/* ══════════════════════════════════════════════
   LOAD HISTORY (chart + KPIs)
══════════════════════════════════════════════ */
async function loadHistory() {
  const days = $("history-range").value;

  // Show loading
  $("chart-loading").classList.remove("hidden");
  $("chart-error").classList.add("hidden");
  $("history-chart").style.opacity = "0";

  try {
    const data = await apiFetch(`/history?days=${days}`);
    state.chartRecords = data.records;

    // Fade chart in
    $("history-chart").style.opacity = "1";
    $("chart-loading").classList.add("hidden");
    requestAnimationFrame(() => drawHistoryChart(state.chartRecords));

    // KPI: Avg daily demand (from chart window)
    const avg = state.chartRecords.reduce((s, r) => s + r.actual_units, 0) / state.chartRecords.length;
    $("kpi-avg-daily").textContent = fmt(avg);

    // Also fetch full history once for total + Historical Data table
    if (state.historyRecords.length === 0) {
      loadFullHistory();
    }
  } catch (err) {
    $("chart-loading").classList.add("hidden");
    $("chart-error").classList.remove("hidden");
    $("chart-error-msg").textContent = err.message || "Failed to load history.";
  }
}

/* ══════════════════════════════════════════════
   LOAD FULL HISTORY (for KPI total + table)
══════════════════════════════════════════════ */
async function loadFullHistory() {
  try {
    // Fetch maximum available records (730 days covers 2022-2024)
    const data = await apiFetch("/history?days=730");
    state.historyRecords = data.records;

    // KPI: Total units sold
    const total = state.historyRecords.reduce((s, r) => s + r.actual_units, 0);
    $("kpi-total-sold").textContent = fmt(total);

    // Render table if currently visible
    if (document.querySelector("#section-history.active")) {
      renderHistoryTable();
    }
  } catch (_) {
    $("kpi-total-sold").textContent = "—";
  }
}

/* ══════════════════════════════════════════════
   GENERATE FORECAST
══════════════════════════════════════════════ */
async function generateForecast(horizon) {
  const btn = $("generate-btn");
  const txt = $("generate-btn-text");
  btn.disabled = true;
  txt.textContent = "Generating…";
  $("forecast-status").textContent = "Requesting forecast from API…";

  try {
    const data = await apiFetch(`/forecast/${horizon}-days`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    // Cache
    if (horizon === 7)  state.forecast7  = data;
    if (horizon === 30) state.forecast30 = data;

    renderForecastPanel(data);
    renderForecastTable(data);
    renderForecastChart(data);

    // Update KPI cards
    if (horizon === 7) {
      $("kpi-7day").textContent = fmt(data.total_predicted_units);
      $("kpi-7day-sub").textContent = data.model;
    } else {
      $("kpi-30day").textContent = fmt(data.total_predicted_units);
      $("kpi-30day-sub").textContent = data.model;
    }

    $("forecast-status").textContent =
      `Generated from ${data.history_source === "included_dataset_demo" ? "included historical dataset" : "user-supplied history"}.`;
  } catch (err) {
    $("forecast-status").textContent = err.message || "Failed to generate forecast.";
  } finally {
    btn.disabled = false;
    txt.textContent = "Generate forecast";
  }
}

function activeForecast() {
  return state.selectedHorizon === 7 ? state.forecast7 : state.forecast30;
}

function renderForecastPanel(data) {
  $("fs-total").textContent  = fmt(data.total_predicted_units);
  $("fs-avg").textContent    = `${fmt(data.average_daily_predicted_units)} units / day`;
  $("fs-model").textContent  = data.model;
  $("fs-period").textContent = `${data.forecast_start} → ${data.forecast_end}`;
  $("fc-chart-title").textContent = `${data.horizon_days}-Day Demand Forecast`;
  $("table-title").textContent    = `${data.horizon_days}-Day Forecast Breakdown`;
}

function renderForecastTable(data) {
  $("forecast-rows").innerHTML = data.predictions.map(p => {
    const day = new Date(p.date + "T00:00:00")
      .toLocaleDateString("en-IN", { weekday: "long" });
    return `<tr>
      <td>${p.date}</td>
      <td>${day}</td>
      <td class="num">${fmt(p.predicted_units)}</td>
    </tr>`;
  }).join("");
}

function renderForecastChart(data) {
  const empty = $("fc-empty");
  const legend = $("fc-legend");
  if (empty)  empty.style.display  = "none";
  if (legend) legend.style.display = "flex";
  requestAnimationFrame(() => drawForecastChart(data));
}

/* ══════════════════════════════════════════════
   HISTORICAL DATA TABLE
══════════════════════════════════════════════ */
function getFilteredHistory() {
  let rows = [...state.historyRecords];

  if (state.histSearch) {
    const q = state.histSearch.toLowerCase();
    rows = rows.filter(r => r.date.toLowerCase().includes(q));
  }
  if (state.histFrom) {
    rows = rows.filter(r => r.date >= state.histFrom);
  }
  if (state.histTo) {
    rows = rows.filter(r => r.date <= state.histTo);
  }
  return rows;
}

function renderHistoryTable() {
  const tbody = $("history-rows");
  if (!tbody) return;

  const filtered = getFilteredHistory();
  const total    = filtered.length;
  const pages    = Math.max(1, Math.ceil(total / state.histPageSize));

  // Clamp page
  if (state.histPage > pages) state.histPage = pages;

  const start = (state.histPage - 1) * state.histPageSize;
  const slice = filtered.slice(start, start + state.histPageSize);

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="table-empty">No records match your filter.</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(r => {
      const day = new Date(r.date + "T00:00:00")
        .toLocaleDateString("en-IN", { weekday: "long" });
      return `<tr>
        <td>${r.date}</td>
        <td>${day}</td>
        <td class="num">${fmt(r.actual_units)}</td>
      </tr>`;
    }).join("");
  }

  // Pagination info
  const from = total === 0 ? 0 : start + 1;
  const to   = Math.min(start + state.histPageSize, total);
  $("pagination-info").textContent =
    total === 0 ? "No records" : `${from}–${to} of ${total} records`;

  // Pagination buttons
  $("page-prev").disabled = state.histPage <= 1;
  $("page-next").disabled = state.histPage >= pages;

  // Page number buttons (show up to 7 pages with ellipsis logic)
  const container = $("page-numbers");
  container.innerHTML = "";
  const range = buildPageRange(state.histPage, pages);
  range.forEach(item => {
    if (item === "…") {
      const span = document.createElement("span");
      span.textContent = "…";
      span.style.cssText = "padding: 0 4px; color: var(--text-tertiary); font-size:12px; line-height:28px;";
      container.appendChild(span);
    } else {
      const btn = document.createElement("button");
      btn.className = "page-btn" + (item === state.histPage ? " active" : "");
      btn.textContent = item;
      btn.addEventListener("click", () => {
        state.histPage = item;
        renderHistoryTable();
      });
      container.appendChild(btn);
    }
  });
}

function buildPageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  if (current <= 4) {
    pages.push(1, 2, 3, 4, 5, "…", total);
  } else if (current >= total - 3) {
    pages.push(1, "…", total - 4, total - 3, total - 2, total - 1, total);
  } else {
    pages.push(1, "…", current - 1, current, current + 1, "…", total);
  }
  return pages;
}

function setupHistoryTable() {
  $("history-search").addEventListener("input", e => {
    state.histSearch = e.target.value.trim();
    state.histPage = 1;
    renderHistoryTable();
  });

  $("filter-from").addEventListener("change", e => {
    state.histFrom = e.target.value;
    state.histPage = 1;
    renderHistoryTable();
  });

  $("filter-to").addEventListener("change", e => {
    state.histTo = e.target.value;
    state.histPage = 1;
    renderHistoryTable();
  });

  $("clear-filters").addEventListener("click", () => {
    state.histSearch = "";
    state.histFrom   = "";
    state.histTo     = "";
    state.histPage   = 1;
    $("history-search").value = "";
    $("filter-from").value    = "";
    $("filter-to").value      = "";
    renderHistoryTable();
  });

  $("page-prev").addEventListener("click", () => {
    if (state.histPage > 1) { state.histPage--; renderHistoryTable(); }
  });

  $("page-next").addEventListener("click", () => {
    const pages = Math.ceil(getFilteredHistory().length / state.histPageSize);
    if (state.histPage < pages) { state.histPage++; renderHistoryTable(); }
  });

  $("export-history-csv").addEventListener("click", exportHistoryCSV);
}

/* ══════════════════════════════════════════════
   MODEL PERFORMANCE — rolling metrics table
══════════════════════════════════════════════ */
async function loadModelInfo() {
  try {
    const data = await apiFetch("/model-info");

    // Update selected model names
    if (data.selected_models) {
      const m7  = data.selected_models["7-Day"]  || "Random Forest";
      const m30 = data.selected_models["30-Day"] || "Extra Trees";
      ["pm-model-7", "pm-model-30"].forEach((id, i) => {
        const el = $(id);
        if (el) el.textContent = i === 0 ? m7 : m30;
      });
    }

    // Rolling validation table
    const tbody = $("rolling-metrics-rows");
    if (tbody && data.rolling_validation_metrics) {
      const metrics = data.rolling_validation_metrics;

      // Sort: 7-Day first, then 30-Day; within each horizon sort by Mean_MAE asc
      metrics.sort((a, b) => {
        if (a.Horizon !== b.Horizon) return a.Horizon.localeCompare(b.Horizon);
        return a.Mean_MAE - b.Mean_MAE;
      });

      tbody.innerHTML = metrics.map(m => {
        const isSelected =
          (m.Horizon === "7-Day"  && m.Model === (data.selected_models?.["7-Day"]  || "Random Forest")) ||
          (m.Horizon === "30-Day" && m.Model === (data.selected_models?.["30-Day"] || "Extra Trees"));

        const r2Class = m.Mean_R2 < 0 ? "negative-val" : "positive";
        const selectedMark = isSelected ? ' <span style="font-size:10px;color:var(--accent);font-weight:600;">★ selected</span>' : "";

        return `<tr ${isSelected ? 'style="background:#FAFBFE;"' : ""}>
          <td>${m.Horizon}</td>
          <td>${m.Model}${selectedMark}</td>
          <td class="num">${fmtDec(m.Mean_MAE)}</td>
          <td class="num">${fmtDec(m.Mean_RMSE)}</td>
          <td class="num ${r2Class}">${fmtDec(m.Mean_R2, 3)}</td>
        </tr>`;
      }).join("");
    }
  } catch (_) {
    // Non-critical — static values in HTML are still correct
  }
}

/* ══════════════════════════════════════════════
   CSV EXPORTS
══════════════════════════════════════════════ */
function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportForecastCSV() {
  const fc = activeForecast();
  if (!fc) {
    $("forecast-status").textContent = "Generate a forecast before exporting.";
    return;
  }
  const rows = [
    ["Date", "Day", "Predicted Units"],
    ...fc.predictions.map(p => {
      const day = new Date(p.date + "T00:00:00")
        .toLocaleDateString("en-IN", { weekday: "long" });
      return [p.date, day, p.predicted_units];
    }),
  ];
  downloadCSV(rows, `retail-demand-${fc.horizon_days}-day-forecast.csv`);
}

function exportHistoryCSV() {
  const rows = getFilteredHistory();
  if (rows.length === 0) return;
  const csv = [
    ["Date", "Day of Week", "Units Sold"],
    ...rows.map(r => {
      const day = new Date(r.date + "T00:00:00")
        .toLocaleDateString("en-IN", { weekday: "long" });
      return [r.date, day, r.actual_units];
    }),
  ];
  downloadCSV(csv, "retail-demand-historical.csv");
}

/* ══════════════════════════════════════════════
   REFRESH BUTTON
══════════════════════════════════════════════ */
function setupRefresh() {
  $("refresh-btn").addEventListener("click", async () => {
    const icon = $("refresh-btn");
    icon.classList.add("spinning");
    try { await boot(); } finally { icon.classList.remove("spinning"); }
  });
}

/* ══════════════════════════════════════════════
   RESIZE — redraw charts
══════════════════════════════════════════════ */
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.chartRecords.length) {
      drawHistoryChart(state.chartRecords);
    }
    const fc = activeForecast();
    if (fc && document.querySelector("#section-forecast.active")) {
      drawForecastChart(fc);
    }
  }, 100);
});

/* ══════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════ */
async function boot() {
  setApiStatus("checking");

  try {
    // Health check (wakes Render cold-start)
    await apiFetch("/health");
    setApiStatus("online");
    updateLastUpdated();

    // Parallel: history chart + both forecasts + model info
    const [, fc7, fc30] = await Promise.all([
      loadHistory(),
      apiFetch("/forecast/7-days",  { method: "POST", body: JSON.stringify({}) }),
      apiFetch("/forecast/30-days", { method: "POST", body: JSON.stringify({}) }),
      loadModelInfo(),
    ]);

    // Cache forecasts
    state.forecast7  = fc7;
    state.forecast30 = fc30;

    // KPI cards
    $("kpi-7day").textContent    = fmt(fc7.total_predicted_units);
    $("kpi-7day-sub").textContent = fc7.model;
    $("kpi-30day").textContent   = fmt(fc30.total_predicted_units);
    $("kpi-30day-sub").textContent = fc30.model;

    // Forecast panel — show currently selected horizon
    const active = activeForecast();
    if (active) {
      renderForecastPanel(active);
      renderForecastTable(active);
      renderForecastChart(active);
    }

    $("forecast-status").textContent =
      `Forecasts generated from included historical dataset.`;

  } catch (err) {
    setApiStatus("offline");
    $("forecast-status").textContent = err.message || "API unavailable. Retrying…";

    // Show cold-start hint for Render
    const hint = document.createElement("p");
    hint.style.cssText = "font-size:12px;color:var(--text-tertiary);text-align:center;padding:var(--sp-3) var(--sp-5) 0;line-height:1.5;";
    hint.textContent = "The API may be starting up (Render free tier). Refresh in 30–60 seconds.";
    const hintParent = $("forecast-status").parentNode;
    if (!$("cold-start-hint")) {
      hint.id = "cold-start-hint";
      hintParent.appendChild(hint);
    }

    // Clear KPI skeletons
    ["kpi-total-sold", "kpi-avg-daily", "kpi-7day", "kpi-30day"].forEach(id => {
      const el = $(id);
      if (el && el.querySelector(".kpi-skeleton")) el.textContent = "—";
    });
  }
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
function init() {
  setupNavigation();
  setupSidebar();
  setupRefresh();
  setupHistoryTable();

  // History range selector
  $("history-range").addEventListener("change", () => {
    loadHistory().catch(err => {
      $("chart-error").classList.remove("hidden");
      $("chart-error-msg").textContent = err.message;
    });
  });

  // Forecast horizon segment buttons
  document.querySelectorAll(".segment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".segment-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedHorizon = Number(btn.dataset.horizon);

      // If we already have this forecast cached, show it immediately
      const cached = activeForecast();
      if (cached) {
        renderForecastPanel(cached);
        renderForecastTable(cached);
        renderForecastChart(cached);
        $("forecast-status").textContent = "Showing cached forecast.";
      } else {
        // Reset panel to empty state
        $("fs-total").textContent  = "—";
        $("fs-avg").textContent    = "—";
        $("fs-model").textContent  = "—";
        $("fs-period").textContent = "—";
        $("forecast-rows").innerHTML =
          `<tr><td colspan="3" class="table-empty">Generate a forecast to view daily predictions.</td></tr>`;
        const empty = $("fc-empty");
        const legend = $("fc-legend");
        if (empty)  empty.style.display  = "flex";
        if (legend) legend.style.display = "none";
        $("forecast-status").textContent = "Select a horizon and generate a forecast.";
      }
    });
  });

  // Generate forecast button
  $("generate-btn").addEventListener("click", () => generateForecast(state.selectedHorizon));

  // CSV export buttons
  $("download-csv").addEventListener("click", exportForecastCSV);

  // Boot
  boot();
}

document.addEventListener("DOMContentLoaded", init);
