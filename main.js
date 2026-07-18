// Point ArcGIS assets to the CDN so we don't need to copy them locally
import esriConfig from "@arcgis/core/config.js";
esriConfig.assetsPath = "https://js.arcgis.com/5.1/@arcgis/core/assets/";

// ArcGIS Map Components
import "@arcgis/map-components/components/arcgis-map";
import "@arcgis/map-components/components/arcgis-zoom";
import "@arcgis/map-components/components/arcgis-expand";
import "@arcgis/map-components/components/arcgis-legend";

// ArcGIS AI Components
import "@arcgis/ai-components/components/arcgis-assistant";
import "@arcgis/ai-components/components/arcgis-assistant-navigation-agent";
import "@arcgis/ai-components/components/arcgis-assistant-data-exploration-agent";
import "@arcgis/ai-components/components/arcgis-assistant-help-agent";
import "@arcgis/ai-components/components/arcgis-assistant-agent";

// Calcite UI Components
import "@esri/calcite-components/components/calcite-shell";
import "@esri/calcite-components/components/calcite-shell-panel";
import "@esri/calcite-components/components/calcite-panel";
import "@esri/calcite-components/components/calcite-action";
import "@esri/calcite-components/components/calcite-notice";

// Custom chart agent — static registration, set immediately on startup
import { chartAgentRegistration } from "./chart-agent.js";

// ── Chart rendering ───────────────────────────────────────────────────────────

function buildBarChart(title, data, total, fullLabels = false) {
  if (!data?.length) return "<p style='padding:8px'>No data</p>";

  const BAR_H      = fullLabels ? 28  : 24;
  const GAP        = 6;
  const LABEL_W    = fullLabels ? 210 : 160;
  const BAR_MAX_W  = fullLabels ? 185 : 200;
  const PAD_X      = 10;
  const PAD_TOP    = fullLabels ? 42  : 36;
  const PAD_BOTTOM = 12;
  const VALUE_W    = 90;
  const MAX_CHARS  = fullLabels ? 32  : 18;
  const FS_LABEL   = fullLabels ? "12.5" : "11.5";
  const FS_VALUE   = fullLabels ? "11.5" : "11";
  const FS_TITLE   = fullLabels ? "15"   : "13.5";
  const TITLE_Y    = fullLabels ? 27    : 23;

  const vbW = PAD_X + LABEL_W + 8 + BAR_MAX_W + VALUE_W + PAD_X;
  const vbH = PAD_TOP + data.length * (BAR_H + GAP) - GAP + PAD_BOTTOM;
  const maxVal = Math.max(...data.map(d => d.value));

  const bars = data.map((d, i) => {
    const bw  = Math.max(3, Math.round((d.value / maxVal) * BAR_MAX_W));
    const x   = PAD_X + LABEL_W + 8;
    const y   = PAD_TOP + i * (BAR_H + GAP);
    const cy  = y + BAR_H / 2 + 4.5;
    const pct = total ? Math.round((d.value / total) * 100) : 0;
    const lbl = d.label.length > MAX_CHARS ? d.label.slice(0, MAX_CHARS - 2) + "…" : d.label;
    return `
      <rect x="${x}" y="${y}" width="${bw}" height="${BAR_H}" fill="#00b4d8" rx="3" opacity="0.88"/>
      <text x="${PAD_X + LABEL_W}" y="${cy}" text-anchor="end" font-size="${FS_LABEL}" fill="#e0e0e0" font-family="Cairo,sans-serif">${lbl}</text>
      <text x="${x + bw + 6}" y="${cy}" font-size="${FS_VALUE}" fill="#a0a0a0" font-family="sans-serif">${d.value.toLocaleString()} (${pct}%)</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 ${vbW} ${vbH}"
    style="display:block;width:100%;height:auto;background:#1a1a2e;border-radius:8px;">
    <text x="${vbW / 2}" y="${TITLE_Y}" text-anchor="middle" font-size="${FS_TITLE}" font-weight="bold"
      fill="#00b4d8" font-family="Cairo,sans-serif">${title}</text>
    ${bars}
  </svg>`;
}

// ── Line chart (time series trend) ───────────────────────────────────────────

function buildLineChart(title, data, fullLabels = false) {
  if (!data?.length) return "<p style='padding:8px'>No data</p>";

  const PAD_L      = fullLabels ? 52 : 44;
  const PAD_R      = fullLabels ? 20 : 16;
  const PAD_TOP    = fullLabels ? 42 : 36;
  const PAD_BOT    = fullLabels ? 54 : 44;
  const PLOT_W     = fullLabels ? 480 : 340;
  const PLOT_H     = fullLabels ? 200 : 160;
  const FS_TITLE   = fullLabels ? "14" : "12.5";
  const FS_LABEL   = fullLabels ? "10.5" : "9";
  const FS_VAL     = fullLabels ? "10"   : "9";
  const TITLE_Y    = fullLabels ? 27 : 23;
  const MAX_LBL    = fullLabels ? 14 : 9;

  const vbW = PAD_L + PLOT_W + PAD_R;
  const vbH = PAD_TOP + PLOT_H + PAD_BOT;
  const n   = data.length;
  const maxVal = Math.max(...data.map(d => d.value), 1);

  const xs = data.map((_, i) => PAD_L + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W));
  const ys = data.map(d => PAD_TOP + PLOT_H - (d.value / maxVal) * PLOT_H);

  // Y-axis grid (4 lines)
  const grid = [0, 0.33, 0.67, 1].map(pct => {
    const y   = PAD_TOP + PLOT_H - pct * PLOT_H;
    const val = Math.round(pct * maxVal);
    return `
      <line x1="${PAD_L}" y1="${y}" x2="${PAD_L + PLOT_W}" y2="${y}" stroke="#2a2a40" stroke-width="0.8"/>
      <text x="${PAD_L - 5}" y="${y + 4}" text-anchor="end" font-size="${FS_VAL}" fill="#666" font-family="sans-serif">${val}</text>`;
  }).join("");

  // Area fill
  const areaPath = `M ${xs[0]},${PAD_TOP + PLOT_H} ` +
    xs.map((x, i) => `L ${x},${ys[i]}`).join(" ") +
    ` L ${xs[xs.length - 1]},${PAD_TOP + PLOT_H} Z`;

  // Line path
  const linePath = `M ${xs[0]},${ys[0]} ` + xs.slice(1).map((x, i) => `L ${x},${ys[i + 1]}`).join(" ");

  // Dots + value labels above each point
  const dots = xs.map((x, i) => {
    const lbl = String(data[i].value);
    return `
      <circle cx="${x}" cy="${ys[i]}" r="${fullLabels ? 4 : 3.5}" fill="#00b4d8" stroke="#1a1a2e" stroke-width="1.5"/>
      <text x="${x}" y="${ys[i] - 7}" text-anchor="middle" font-size="${FS_VAL}" fill="#00b4d8" font-family="sans-serif">${lbl}</text>`;
  }).join("");

  // X-axis labels (rotated -30°)
  const xLabels = xs.map((x, i) => {
    const lbl = data[i].label.length > MAX_LBL ? data[i].label.slice(0, MAX_LBL - 1) + "…" : data[i].label;
    const labelY = PAD_TOP + PLOT_H + 18;
    return `<text x="${x}" y="${labelY}" text-anchor="end" font-size="${FS_LABEL}" fill="#ccc" font-family="Cairo,sans-serif"
      transform="rotate(-35,${x},${labelY})">${lbl}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 ${vbW} ${vbH}"
    style="display:block;width:100%;height:auto;background:#1a1a2e;border-radius:8px;">
    <text x="${vbW / 2}" y="${TITLE_Y}" text-anchor="middle" font-size="${FS_TITLE}" font-weight="bold"
      fill="#00b4d8" font-family="Cairo,sans-serif">${title}</text>
    ${grid}
    <line x1="${PAD_L}" y1="${PAD_TOP}" x2="${PAD_L}" y2="${PAD_TOP + PLOT_H}" stroke="#444" stroke-width="1"/>
    <line x1="${PAD_L}" y1="${PAD_TOP + PLOT_H}" x2="${PAD_L + PLOT_W}" y2="${PAD_TOP + PLOT_H}" stroke="#444" stroke-width="1"/>
    <path d="${areaPath}" fill="#00b4d8" opacity="0.07"/>
    <path d="${linePath}" fill="none" stroke="#00b4d8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

// ── Comparison chart (one section per group, shared scale) ───────────────────

function buildComparisonChart(title, datasets, fullLabels = false) {
  if (!datasets?.length) return "<p style='padding:8px'>No data</p>";

  const COLORS   = ["#00b4d8", "#f72585", "#7b2ff7", "#fb8500"];
  const BAR_H    = fullLabels ? 22 : 18;
  const GAP      = 4;
  const LABEL_W  = fullLabels ? 200 : 150;
  const BAR_MAX_W = fullLabels ? 185 : 185;
  const PAD_X    = 10;
  const TITLE_H  = fullLabels ? 42 : 34;
  const SEC_HDR  = fullLabels ? 22 : 18;
  const SEC_GAP  = 14;
  const VALUE_W  = 85;
  const MAX_CHARS = fullLabels ? 28 : 15;
  const FS_LBL   = fullLabels ? "11.5" : "10.5";
  const FS_VAL   = fullLabels ? "10.5" : "10";
  const FS_HDR   = fullLabels ? "12.5" : "11";
  const FS_TTL   = fullLabels ? "14"   : "12.5";

  const vbW = PAD_X + LABEL_W + 8 + BAR_MAX_W + VALUE_W + PAD_X;
  const globalMax = Math.max(...datasets.flatMap(ds => ds.chartData.map(d => d.value)), 1);

  let y = TITLE_H;
  const sections = datasets.map((ds, di) => {
    const color = COLORS[di % COLORS.length];
    const rows = ds.chartData.map((d, i) => {
      const bw  = Math.max(2, Math.round((d.value / globalMax) * BAR_MAX_W));
      const barY = y + SEC_HDR + i * (BAR_H + GAP);
      const cy  = barY + BAR_H / 2 + 4;
      const pct = ds.total ? Math.round((d.value / ds.total) * 100) : 0;
      const lbl = d.label.length > MAX_CHARS ? d.label.slice(0, MAX_CHARS - 2) + "…" : d.label;
      return `
        <rect x="${PAD_X + LABEL_W + 8}" y="${barY}" width="${bw}" height="${BAR_H}" fill="${color}" rx="2" opacity="0.85"/>
        <text x="${PAD_X + LABEL_W}" y="${cy}" text-anchor="end" font-size="${FS_LBL}" fill="#e0e0e0" font-family="Cairo,sans-serif">${lbl}</text>
        <text x="${PAD_X + LABEL_W + 8 + bw + 5}" y="${cy}" font-size="${FS_VAL}" fill="#a0a0a0" font-family="sans-serif">${d.value} (${pct}%)</text>`;
    }).join("");

    const dividerY = y;
    const headerCY = y + SEC_HDR / 2 + 4.5;
    const sectionH = SEC_HDR + ds.chartData.length * (BAR_H + GAP) - GAP;
    y += sectionH + SEC_GAP;

    return `
      <line x1="${PAD_X}" y1="${dividerY}" x2="${vbW - PAD_X}" y2="${dividerY}" stroke="${color}" stroke-width="0.6" opacity="0.35"/>
      <text x="${vbW / 2}" y="${headerCY}" text-anchor="middle" font-size="${FS_HDR}" font-weight="bold" fill="${color}" font-family="Cairo,sans-serif">
        ${ds.label} · ${ds.total.toLocaleString()} بلاغ
      </text>
      ${rows}`;
  }).join("\n");

  const vbH = y + 6;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}"
    style="display:block;width:100%;height:auto;background:#1a1a2e;border-radius:8px;">
    <text x="${vbW / 2}" y="${TITLE_H - 10}" text-anchor="middle" font-size="${FS_TTL}" font-weight="bold"
      fill="#e0e0e0" font-family="Cairo,sans-serif">${title}</text>
    ${sections}
  </svg>`;
}

// ── Chart modal (expand on click) ────────────────────────────────────────────

function openChartModal(svgHtml) {
  let modal = document.getElementById("chart-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "chart-modal";
    modal.addEventListener("click", e => { if (e.target === modal) closeChartModal(); });
    document.body.appendChild(modal);
  }

  modal.style.cssText = `
    position:fixed;inset:0;z-index:10000;
    background:rgba(0,0,0,0.82);
    display:flex;align-items:center;justify-content:center;
    cursor:zoom-out;
  `;

  modal.innerHTML = `
    <div style="
      position:relative;width:min(720px,90vw);max-height:92vh;
      overflow-y:auto;background:#1a1a2e;
      border-radius:12px;padding:20px 20px 16px;
      box-shadow:0 12px 40px rgba(0,0,0,0.7);cursor:default;
    ">
      <button id="chart-modal-close" title="إغلاق" style="
        position:absolute;top:8px;right:10px;
        background:none;border:none;color:#888;
        font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;
      ">×</button>
      ${svgHtml}
    </div>`;

  document.getElementById("chart-modal-close").addEventListener("click", closeChartModal);
  document.addEventListener("keydown", onModalKey);
}

function closeChartModal() {
  const modal = document.getElementById("chart-modal");
  if (modal) modal.style.display = "none";
  document.removeEventListener("keydown", onModalKey);
}

function onModalKey(e) {
  if (e.key === "Escape") closeChartModal();
}

// ── Slottable request handler ─────────────────────────────────────────────────

function handleSlottableRequest(e) {
  const { name, slotName, data } = e.detail;

  // The SDK always uses name="block"; our type lives at data.block.type
  if (name !== "block") return;
  const block = data?.block;
  const blockType = block?.type;
  if (blockType !== "violations-chart" && blockType !== "violations-chart-comparison") return;

  const assistant = e.currentTarget;
  const existing = assistant.querySelector(`[slot="${slotName}"]`);
  if (existing) existing.remove();

  const p = block.data;
  if (!p) return;

  try {
    const isComparison = blockType === "violations-chart-comparison";
    const isLine       = !isComparison && p.chartType === "line";

    const svgHtml = isComparison
      ? buildComparisonChart(p.title, p.datasets)
      : isLine
        ? buildLineChart(p.title, p.chartData)
        : buildBarChart(p.title, p.chartData, p.total);
    const svgHtmlFull = isComparison
      ? buildComparisonChart(p.title, p.datasets, true)
      : isLine
        ? buildLineChart(p.title, p.chartData, true)
        : buildBarChart(p.title, p.chartData, p.total, true);

    const wrapper = document.createElement("div");
    wrapper.slot = slotName;
    wrapper.style.cssText = "width:100%;padding:4px 0 2px;";
    wrapper.innerHTML = `
      <div style="position:relative;">
        ${svgHtml}
        <div style="text-align:left;font-size:11px;color:#00b4d8;opacity:0.6;padding:2px 4px;cursor:zoom-in;user-select:none;">⤢ اضغط للتوسيع</div>
      </div>`;

    const svgEl = wrapper.querySelector("svg");
    if (svgEl) svgEl.style.cursor = "zoom-in";
    wrapper.addEventListener("click", () => openChartModal(svgHtmlFull));
    assistant.appendChild(wrapper);
  } catch (err) {
    console.error("[ChartAgent] Chart render error:", err, "data:", p);
  }
}

// ── Agent registration — immediate, no delay ──────────────────────────────────

(async () => {
  // Set .agent BEFORE the component finishes its lifecycle — required by the SDK
  await customElements.whenDefined("arcgis-assistant-agent");
  const agentEl    = document.getElementById("chart-agent-el");
  const assistantEl = document.querySelector("arcgis-assistant");
  if (agentEl) agentEl.agent = chartAgentRegistration;
  if (assistantEl) assistantEl.addEventListener("arcgisSlottableRequest", handleSlottableRequest);
})();
