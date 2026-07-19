import { LLMAgent } from "@arcgis/ai-components/agent-utils/LLMAgent.js";
import { FunctionTool } from "@arcgis/ai-components/agent-utils/tools/FunctionTool.js";
import { sendUXSuggestion } from "@arcgis/ai-components/utils/index.js";
import Extent from "@arcgis/core/geometry/Extent.js";
import z from "zod";

// Actual bounding box of the violations layer (WKID 4326).
// layer.queryExtent() returns world extent due to bad-coordinate features in the dataset.
// This hardcoded extent is used as a reliable fallback for "zoom to all data".
const LAYER_EXTENT = new Extent({
  xmin: 29.80721772700008, ymin: 25.4574948,
  xmax: 34.3023397,        ymax: 31.321251338000025,
  spatialReference: { wkid: 4326 }
});

// ── Layer access at execute-time (no factory, no timing issues) ───────────────
function getFeatureLayer() {
  const view = document.querySelector("arcgis-map")?.view;
  if (!view) return null;
  return (
    view.map?.allLayers?.find(l => l.type === "feature") ??
    view.allLayerViews?.find(lv => lv.layer?.type === "feature")?.layer ??
    null
  );
}

// ── Arabic normalization: handles ة/ه, أإآ/ا, ى/ي, diacritics ────────────────
function normalizeArabic(str) {
  return String(str)
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .trim().toLowerCase();
}

const ARABIC_MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو",
                        "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];

// ── Date field catalogue: name + alias + description so the LLM decides ───────
// No heuristics. The LLM reads field descriptions (set in ArcGIS Online portal)
// and picks the semantically correct field.
function describeDateFields(fields) {
  return fields
    .filter(f => f.type === "date")
    .map(f => {
      const parts = [f.name];
      if (f.alias && f.alias !== f.name) parts.push(`alias: ${f.alias}`);
      if (f.description) parts.push(`description: ${f.description}`);
      return parts.join(", ");
    })
    .join(" | ");
}

// Fallback only when dateFieldOverride is not supplied and there is exactly one date field.
// If multiple date fields exist the LLM must supply dateFieldOverride — no guessing.
function defaultDateField(fields) {
  const dateFields = fields.filter(f => f.type === "date");
  return dateFields.length === 1 ? dateFields[0].name : null;
}

function allDateFields(fields) {
  return fields.filter(f => f.type === "date").map(f => `${f.name} (${f.alias ?? f.name})`).join(", ");
}

// ── Shared: resolve field name + fuzzy-match stored values ────────────────────
function resolveField(fields, name) {
  return fields.find(f => f.name.toLowerCase() === name.toLowerCase())?.name ??
         fields.find(f => (f.alias ?? "").toLowerCase() === name.toLowerCase())?.name ??
         name;
}

async function getMatchedValues(layer, filterField, userValues) {
  if (!filterField || !userValues?.length) return [];
  const dq = layer.createQuery();
  dq.outFields = [filterField];
  dq.returnDistinctValues = true;
  dq.where = "1=1";
  let stored = [];
  try {
    const dr = await layer.queryFeatures(dq);
    stored = dr.features.map(f => f.attributes[filterField]).filter(v => v != null).map(String);
  } catch (_) {}
  return userValues.map(uv => stored.find(sv => normalizeArabic(sv) === normalizeArabic(uv)) ?? uv);
}

// ── Map response: called after data queries complete ──────────────────────────
// filterWhere = SQL string  → zoom to those features + dim others
// filterWhere = null        → clear any previous dimming; zoom to all data only if zoomToAllData=true
// zoomToAllData = true      → call layer.queryExtent() and zoom to actual feature extent
//                             (only pass true when intentionally querying ALL data, not on intermediate calls)
async function syncMapToQuery(layer, filterWhere, zoomToAllData = false) {
  const view = document.querySelector("arcgis-map")?.view;
  if (!view || !layer) return;
  try {
    const lv = await view.whenLayerView(layer);
    if (filterWhere) {
      // Location-specific: zoom in + dim non-matching
      const q = layer.createQuery();
      q.where = filterWhere;
      q.returnGeometry = true;
      q.outSpatialReference = view.spatialReference;
      q.num = 1000;
      const { features } = await layer.queryFeatures(q);
      const geo = features.filter(f => f.geometry);
      if (geo.length) await view.goTo(geo, { animate: true });
      try {
        lv.featureEffect = {
          filter: { where: filterWhere },
          includedEffect: "opacity(1)",
          excludedEffect: "grayscale(100%) opacity(0.3)"
        };
      } catch (_) {}
    } else {
      // No location filter: clear dimming
      try { lv.featureEffect = null; } catch (_) {}
      // Only zoom to full extent when the tool is intentionally querying all data.
      // Guard: skip if queryExtent returns a world-scale extent (e.g. layer metadata default).
      // In Web Mercator (EPSG:3857), Egypt is ~1.6M metres wide; world is ~40M metres wide.
      if (zoomToAllData) {
        let zoomed = false;
        try {
          const { extent } = await layer.queryExtent();
          if (extent) {
            // Threshold depends on CRS units:
            //   Geographic (degrees): Egypt ≈12°×9°, world ≈360°×180° → limit at 50°
            //   Projected (metres):   Egypt ≈1.6M×1.1M, world ≈40M×20M → limit at 20M
            const limit = extent.spatialReference?.isGeographic ? 50 : 20_000_000;
            if (extent.width < limit && extent.height < limit) {
              await view.goTo(extent, { animate: true });
              zoomed = true;
            }
          }
        } catch (_) {}
        // Fallback: queryExtent returned world-scale (bad feature coordinates in the layer).
        // Use the known correct data extent until bad data is fixed.
        if (!zoomed) {
          try { await view.goTo(LAYER_EXTENT, { animate: true }); } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error("[ChartAgent] syncMapToQuery:", err);
  }
}

function fieldCatalogue(layer) {
  return (layer?.fields ?? [])
    .filter(f => !["oid","global-id"].includes(f.type))
    .map(f => {
      let entry = `${f.name} (alias: ${f.alias ?? f.name}, type: ${f.type}`;
      if (f.description) entry += `, description: "${f.description}"`;
      return entry + ")";
    })
    .join("; ");
}

// ── Tool 1: grouped statistics bar chart ──────────────────────────────────────
const queryChartTool = new FunctionTool({
  name: "query_violations_chart",
  description: `Query grouped statistics and optionally render a bar chart.
MUST use for: رسم بياني, مخطط, chart, graph, rankings, distributions, comparisons, "أكثر", "ترتيب", "توزيع", "قارن", "مقارنة".
compareMode=true → separate query per filterValue, side-by-side on shared scale.
Spelling variants in filterValues are handled automatically.`,
  inputSchema: z.object({
    groupByField:  z.string().describe("Exact field name from the layer to group by"),
    title:         z.string().describe("Chart/result title in the user's language"),
    showChart:    z.boolean().describe("true = render bar chart; false = return text only"),
    compareMode:  z.boolean().optional().describe("true = run one query PER filterValue and show side-by-side. groupByField must be the BREAKDOWN dimension (e.g. violation type), NOT the filter dimension (e.g. governorate)"),
    filterField:  z.string().optional().describe("Field to filter before grouping"),
    filterValues: z.array(z.string()).optional().describe("Values to filter to (user spelling OK, fuzzy-matched automatically)"),
    startDate:    z.string().optional().describe('ISO date to filter records from, e.g. "2024-01-01"'),
    endDate:      z.string().optional().describe('ISO date to filter records until, e.g. "2024-12-31"')
  }),
  resultMode: "continue",
  execute: async ({ groupByField, title, showChart, compareMode, filterField, filterValues, startDate, endDate }, config) => {
    const layer = getFeatureLayer();
    if (!layer) return "Map not loaded yet — try again in a moment.";

    const fields    = layer.fields ?? [];
    const oidField  = layer.objectIdField || "OBJECTID";
    const dateField = defaultDateField(fields);

    const actualGroup  = resolveField(fields, groupByField);
    const actualFilter = filterField ? resolveField(fields, filterField) : null;

    // Verify groupByField exists
    if (!fields.find(f => f.name === actualGroup)) {
      return `Field "${groupByField}" not found. Available fields: ${fieldCatalogue(layer)}`;
    }

    function buildDateWhere() {
      const p = [];
      if (dateField && startDate) p.push(`${dateField} >= DATE '${startDate}'`);
      if (dateField && endDate)   p.push(`${dateField} <= DATE '${endDate}'`);
      return p.join(" AND ") || null;
    }

    async function runGroupQuery(additionalWhere) {
      const parts = [];
      if (additionalWhere) parts.push(additionalWhere);
      const dw = buildDateWhere();
      if (dw) parts.push(dw);

      const q = layer.createQuery();
      q.outStatistics = [{ statisticType:"count", onStatisticField:oidField, outStatisticFieldName:"cnt" }];
      q.groupByFieldsForStatistics = [actualGroup];
      q.orderByFields = ["cnt DESC"];
      q.num = 15;
      if (parts.length) q.where = parts.join(" AND ");

      const r = await layer.queryFeatures(q);
      return r.features
        .map(f => ({ label: String(f.attributes[actualGroup] ?? "Unknown"), value: Number(f.attributes["cnt"]) }))
        .filter(d => d.value > 0);
    }

    // ── compareMode: one query per named group ──────────────────────────────
    if (compareMode && actualFilter && filterValues?.length > 1) {
      const matched = await getMatchedValues(layer, actualFilter, filterValues);
      const datasets = [];
      for (const mv of matched) {
        const where = `${actualFilter} = '${mv.replace(/'/g,"''")}'`;
        try {
          const data = await runGroupQuery(where);
          datasets.push({ label: mv, chartData: data, total: data.reduce((s,d)=>s+d.value,0) });
        } catch (_) {
          datasets.push({ label: mv, chartData: [], total: 0 });
        }
      }
      const combinedIn = matched.map(v => `'${v.replace(/'/g,"''")}'`).join(", ");
      void syncMapToQuery(layer, `${actualFilter} IN (${combinedIn})`);
      if (showChart && datasets.some(ds => ds.chartData.length)) {
        try {
          await sendUXSuggestion({ type:"violations-chart-comparison", data:{ title, datasets } }, config);
        } catch (err) {
          console.error("[ChartAgent] sendUXSuggestion comparison error:", err);
        }
      }
      return datasets.map(ds => `${ds.label}: ${ds.total.toLocaleString()} بلاغ`).join(" | ");
    }

    // ── standard mode ───────────────────────────────────────────────────────
    let filterWhere = null;
    if (actualFilter && filterValues?.length) {
      const matched = await getMatchedValues(layer, actualFilter, filterValues);
      const inList  = matched.map(v => `'${v.replace(/'/g,"''")}'`).join(", ");
      filterWhere   = `${actualFilter} IN (${inList})`;
    }

    let chartData;
    try {
      chartData = await runGroupQuery(filterWhere);
    } catch (err) {
      return `Query failed on field "${actualGroup}". Available: ${fieldCatalogue(layer)}. Error: ${err.message}`;
    }

    if (!chartData.length) return "No data found for this query.";
    void syncMapToQuery(layer, filterWhere, filterWhere == null);

    const total   = chartData.reduce((s,d)=>s+d.value, 0);
    const topItem = chartData[0];
    const summary = `الأعلى: ${topItem.label} بـ ${topItem.value.toLocaleString()} بلاغ من إجمالي ${total.toLocaleString()}.`;

    if (showChart) {
      try {
        await sendUXSuggestion({ type:"violations-chart", data:{ title, chartData, total } }, config);
      } catch (err) {
        console.error("[ChartAgent] sendUXSuggestion error:", err);
      }
      return `Chart rendered. ${summary}`;
    }
    return summary;
  }
});

// ── Tool 2: time series by month / year ───────────────────────────────────────
const timeSeriesTool = new FunctionTool({
  name: "query_time_series",
  description: `Show violations count grouped by month or year.
Use for: "تطور البلاغات", "هذا الشهر", "هذه السنة", "متى ذروة البلاغات", "الاتجاه", trend questions.
showChart=true renders a chart; false returns the text data.
Use chartType="line" when user asks for a line chart or trend visualization (default is "bar").
Use limit=N to return only the N most recent time periods (e.g. limit=5 for last 5 months).
Use breakdownField to split trend by a category (e.g. violation type) — produces one line per category.
If multiple date fields exist and you know which one to use, pass it as dateFieldOverride.`,
  inputSchema: z.object({
    groupBy:           z.enum(["month","year"]),
    title:             z.string(),
    showChart:  z.boolean().describe("true = render chart; false = return text list of periods and counts"),
    chartType:  z.enum(["bar","line"]).optional().describe('Use "line" for trend visualization, "bar" (default) for comparison'),
    limit:             z.number().int().optional().describe("Return only the N most recent time periods. This is a SINGLE parameter — do not call the tool multiple times for different periods."),
    breakdownField:    z.string().optional().describe("Field name to split the time series by category (e.g. violation type). Each unique value becomes a separate line. Use when user asks for trend BY a category."),
    dateFieldOverride: z.string().optional().describe("Override the auto-detected date field with this exact field name"),
    filterField:       z.string().optional(),
    filterValues:      z.array(z.string()).optional(),
    startDate:         z.string().optional(),
    endDate:           z.string().optional()
  }),
  resultMode: "continue",
  execute: async ({ groupBy, title, showChart, chartType, limit, breakdownField, dateFieldOverride, filterField, filterValues, startDate, endDate }, config) => {
    const layer = getFeatureLayer();
    if (!layer) return "Map not loaded yet.";

    const fields    = layer.fields ?? [];
    const oidField  = layer.objectIdField || "OBJECTID";
    const availableDates = describeDateFields(fields);
    const dateField = dateFieldOverride
      ? resolveField(fields, dateFieldOverride)
      : defaultDateField(fields);
    if (!dateField) {
      return `Multiple date fields found. Call this tool again with dateFieldOverride set to the correct field.\nDate fields and their descriptions:\n${availableDates}`;
    }

    const actualFilter = filterField ? resolveField(fields, filterField) : null;
    const parts = [];
    if (dateField && startDate) parts.push(`${dateField} >= DATE '${startDate}'`);
    if (dateField && endDate)   parts.push(`${dateField} <= DATE '${endDate}'`);
    let locationWhere = null;
    if (actualFilter && filterValues?.length) {
      const matched = await getMatchedValues(layer, actualFilter, filterValues);
      const inList  = matched.map(v => `'${v.replace(/'/g,"''")}'`).join(", ");
      locationWhere = `${actualFilter} IN (${inList})`;
      parts.push(locationWhere);
    }

    // ── Multi-series path: one line per category ─────────────────────────────
    if (breakdownField) {
      const actualBreakdown = resolveField(fields, breakdownField);
      if (!fields.find(f => f.name === actualBreakdown)) {
        return `Breakdown field "${breakdownField}" not found. Available: ${fieldCatalogue(layer)}`;
      }

      // Get top 6 categories by total count within the current filter scope
      const topQ = layer.createQuery();
      topQ.outStatistics = [{ statisticType:"count", onStatisticField:oidField, outStatisticFieldName:"cnt" }];
      topQ.groupByFieldsForStatistics = [actualBreakdown];
      topQ.orderByFields = ["cnt DESC"];
      topQ.num = 6;
      topQ.where = parts.length ? parts.join(" AND ") : "1=1";

      let categories;
      try {
        const topResult = await layer.queryFeatures(topQ);
        categories = topResult.features.map(f => f.attributes[actualBreakdown]).filter(v => v != null).map(String);
      } catch (err) {
        return `Failed to get categories for breakdown: ${err.message}`;
      }
      if (!categories.length) return "No category data found.";

      // For each category run a time series query
      const allPeriods = new Map(); // sortKey → label
      const rawDatasets = [];
      for (const cat of categories) {
        const catWhere = `${actualBreakdown} = '${cat.replace(/'/g,"''")}'`;
        const catWhereFull = [...parts, catWhere].join(" AND ");
        const cq = layer.createQuery();
        cq.outFields = [dateField];
        cq.where = catWhereFull || "1=1";
        cq.num = 5000;
        const catBuckets = new Map(); // sortKey → count
        try {
          const { features: cf } = await layer.queryFeatures(cq);
          for (const f of cf) {
            const raw = f.attributes[dateField];
            if (!raw) continue;
            const d = new Date(raw);
            const key = groupBy === "year"
              ? String(d.getFullYear())
              : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
            const lbl = groupBy === "year"
              ? String(d.getFullYear())
              : `${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
            allPeriods.set(key, lbl);
            catBuckets.set(key, (catBuckets.get(key) ?? 0) + 1);
          }
        } catch (_) {}
        rawDatasets.push({ label: cat, catBuckets });
      }

      if (!allPeriods.size) return "No time data found for the requested breakdown.";

      // Sort periods and apply limit
      const sortedKeys   = [...allPeriods.keys()].sort();
      const limitedKeys  = (limit && limit > 0) ? sortedKeys.slice(-limit) : sortedKeys;

      const datasets = rawDatasets.map(ds => ({
        label: ds.label,
        chartData: limitedKeys.map(k => ({ label: allPeriods.get(k), value: ds.catBuckets.get(k) ?? 0 }))
      })).filter(ds => ds.chartData.some(d => d.value > 0));

      if (!datasets.length) return "No data found for the requested breakdown.";

      void syncMapToQuery(layer, locationWhere, locationWhere == null);

      const resolvedType = chartType ?? "line";
      if (showChart) {
        try {
          await sendUXSuggestion({ type:"violations-chart", data:{ title, datasets, chartType: resolvedType } }, config);
        } catch (err) {
          console.error("[ChartAgent] multi-series suggestion error:", err);
        }
        return `Multi-line chart rendered: ${datasets.length} categories over ${limitedKeys.length} periods. ` +
          datasets.map(ds => `${ds.label}: ${ds.chartData.reduce((s,d)=>s+d.value,0)} بلاغ`).join(" | ");
      }
      return datasets.map(ds =>
        `${ds.label}: ${ds.chartData.map(d => `${d.label}=${d.value}`).join(", ")}`
      ).join("\n");
    }

    // ── Single-series path ────────────────────────────────────────────────────
    const q = layer.createQuery();
    q.outFields = [dateField];
    q.where     = parts.length ? parts.join(" AND ") : "1=1";
    q.num       = 5000;

    let features;
    try {
      const r = await layer.queryFeatures(q);
      features = r.features;
    } catch (err) {
      return `Time series query failed: ${err.message}`;
    }

    if (!features.length) return "No data found for the requested time range.";
    void syncMapToQuery(layer, locationWhere, locationWhere == null);

    const buckets = new Map();
    for (const f of features) {
      const raw = f.attributes[dateField];
      if (!raw) continue;
      const d   = new Date(raw);
      const key = groupBy === "year"
        ? String(d.getFullYear())
        : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      const lbl = groupBy === "year"
        ? String(d.getFullYear())
        : `${ARABIC_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      if (!buckets.has(key)) buckets.set(key, { label: lbl, value: 0 });
      buckets.get(key).value++;
    }

    const sorted = [...buckets.entries()]
      .sort((a,b) => a[0].localeCompare(b[0]))
      .map(([,v]) => v);

    // Apply limit: take last N periods (most recent)
    const chartData = (limit && limit > 0) ? sorted.slice(-limit) : sorted;

    const total = chartData.reduce((s,d)=>s+d.value, 0);
    const peak  = chartData.reduce((a,b)=>b.value>a.value?b:a);
    const resolvedType = chartType ?? "bar";

    if (showChart) {
      try {
        await sendUXSuggestion({ type:"violations-chart", data:{ title, chartData, total, chartType: resolvedType } }, config);
      } catch (err) {
        console.error("[ChartAgent] time series suggestion error:", err);
      }
      return `${resolvedType === "line" ? "Line" : "Bar"} chart rendered (${chartData.length} periods, field: ${dateField}). Peak: ${peak.label} (${peak.value} بلاغ). Total: ${total.toLocaleString()}.`;
    }

    // Text mode: return the actual data list
    const lines = chartData.map(d => `${d.label}: ${d.value} بلاغ`).join("\n");
    return `Time series data (${chartData.length} periods, field: ${dateField}):\n${lines}\nTotal: ${total.toLocaleString()}. Peak: ${peak.label} (${peak.value} بلاغ).`;
  }
});

// ── Tool 3: quick text summary ────────────────────────────────────────────────
const summaryTool = new FunctionTool({
  name: "get_violations_summary",
  description: `Return a concise text summary: total count, top violation type, top governorate, date range.
Use for: "لخصلي", "نظرة عامة", "ما الوضع الحالي", "كم عدد البلاغات", "ملخص", "overview".
Supply typeField and govField using the exact field names from your knowledge of the layer schema.
If a first call returns "Fields not resolved", read the fieldCatalogue in the response and call again with correct names.`,
  inputSchema: z.object({
    filterField:  z.string().optional(),
    filterValues: z.array(z.string()).optional(),
    typeField:    z.string().optional().describe("Exact field name for violation type / category. Read from fieldCatalogue if unsure."),
    govField:     z.string().optional().describe("Exact field name for governorate / region. Read from fieldCatalogue if unsure.")
  }),
  resultMode: "continue",
  execute: async ({ filterField, filterValues, typeField, govField }) => {
    const layer = getFeatureLayer();
    if (!layer) return "Map not loaded yet.";

    const fields    = layer.fields ?? [];
    const oidField  = layer.objectIdField || "OBJECTID";
    const dateField = defaultDateField(fields);
    const actualFilter = filterField ? resolveField(fields, filterField) : null;

    let where = null;
    if (actualFilter && filterValues?.length) {
      const matched = await getMatchedValues(layer, actualFilter, filterValues);
      const inList  = matched.map(v => `'${v.replace(/'/g,"''")}'`).join(", ");
      where = `${actualFilter} IN (${inList})`;
    }

    const resolvedTypeField = typeField ? resolveField(fields, typeField) : null;
    const resolvedGovField  = govField  ? resolveField(fields, govField)  : null;

    async function topOf(groupField) {
      if (!groupField) return null;
      const q = layer.createQuery();
      q.outStatistics = [{ statisticType:"count", onStatisticField:oidField, outStatisticFieldName:"cnt" }];
      q.groupByFieldsForStatistics = [groupField];
      q.orderByFields = ["cnt DESC"];
      q.num = 1;
      if (where) q.where = where;
      try {
        const r = await layer.queryFeatures(q);
        if (r.features[0])
          return { label: r.features[0].attributes[groupField], value: r.features[0].attributes["cnt"] };
      } catch (_) {}
      return null;
    }

    async function countAll() {
      const q = layer.createQuery();
      q.where = where ?? "1=1";
      try { return await layer.queryFeatureCount(q); } catch (_) { return null; }
    }

    async function dateRange() {
      if (!dateField) return null;
      const q = layer.createQuery();
      q.outStatistics = [
        { statisticType:"min", onStatisticField:dateField, outStatisticFieldName:"min_d" },
        { statisticType:"max", onStatisticField:dateField, outStatisticFieldName:"max_d" }
      ];
      if (where) q.where = where;
      try {
        const r = await layer.queryFeatures(q);
        const a = r.features[0]?.attributes;
        if (a?.min_d && a?.max_d)
          return { from: new Date(a.min_d).toLocaleDateString("ar-EG"), to: new Date(a.max_d).toLocaleDateString("ar-EG") };
      } catch (_) {}
      return null;
    }

    const [total, topType, topGov, range] = await Promise.all([
      countAll(), topOf(resolvedTypeField), topOf(resolvedGovField), dateRange()
    ]);
    void syncMapToQuery(layer, where);

    const lines = [];
    if (total  != null) lines.push(`• إجمالي البلاغات: ${total.toLocaleString()}`);
    if (topType)        lines.push(`• أكثر نوع مخالفة: ${topType.label} (${topType.value} بلاغ)`);
    if (topGov)         lines.push(`• أكثر محافظة: ${topGov.label} (${topGov.value} بلاغ)`);
    if (range)          lines.push(`• الفترة الزمنية: من ${range.from} إلى ${range.to}`);
    if (!topType && !topGov) lines.push(`Fields not resolved. Available: ${fieldCatalogue(layer)}`);
    if (!lines.length)  lines.push("No data available.");
    return lines.join("\n");
  }
});

// ── Static registration — set immediately on startup, no timing issues ────────
export const chartAgentRegistration = new LLMAgent({
  name: "ChartAgent",
  description: `Use this agent ONLY when the user explicitly requests a chart, statistic, ranking, comparison, trend, or summary.
The query MUST contain at least one of these signals to route here:
  رسم بياني, مخطط, مقارنة, قارن, ترتيب, توزيع, إحصاء, إحصائية, تحليل, ملخص, لخص, تطور, كم عدد, كم بلاغ, chart, graph, compare, rank, statistics, trend, summary, distribution.
Do NOT use for queries that mention only a location, topic, or type without any of the above signals (e.g. "المخالفات في القاهرة", "بلاغات الإنارة", "عرض على الخريطة"). Those go to navigation or data-exploration agents.`,
  prompt: `You are a data analyst for عين المواطن (Citizen Eye), an Egyptian citizen violation tracking system.

## Fields
Field names are discovered at runtime — the tools validate them and return the full catalogue on error.
For get_violations_summary you MUST pass typeField and govField using the exact field name from the layer.
If you don't know the field names yet, call the tool without them — it will return the full field catalogue so you can call again with correct names.
Common patterns: violation type (Category, ViolationType, نوع, فئه, SubType), governorate (Governorate, محافظه, Province), date (CreatedDate, Date, تاريخ).

## Clarification rule — CRITICAL
If you need to ask the user a clarifying question:
- Write ONE short sentence in Arabic. No lists, no bullet points, no sub-options.
- Do NOT call any tool in the same turn. No chart, no data query.
- NEVER ask a question whose answer is already in the user's message. Re-read the prompt before asking.
- If genuinely unsure, ask ONE question per turn maximum — never ask multiple questions across consecutive turns for the same request.

## Never do this
- Never write placeholder text like [أدخل ...] or [insert ...] in responses. If data is missing from the tool result, say so in plain Arabic.
- Never ask about time period interpretation when the user said "متوفرة في البيانات" or "متاحة في الداتا" — that is already the answer.

## Tool selection
- Rankings / distributions / comparisons / charts → query_violations_chart
- Trends over time / monthly/yearly evolution → query_time_series
- Quick overview / single total / text summary → get_violations_summary

## When to show a chart (showChart)
Both query_violations_chart and query_time_series have showChart. Same rules for both:
Show chart (showChart=true) when data involves ranking, distribution, comparison, or time trend — even without explicit "رسم بياني".
Show text only (showChart=false) when:
  - User explicitly asks for text ("قائمة نصية", "هات النتيجة text", "بدون رسم")
  - User asks for a single number only
  - Summary overview → use get_violations_summary instead

## Line chart
For query_time_series: use chartType="line" when user asks for "line chart", "مخطط خطي", or a trend visualization.
Default is chartType="bar".

## Limit (last N periods)
Use limit=N in a SINGLE tool call — never call the tool N times for N periods.
"آخر 5 أشهر" → limit=5, groupBy="month" in ONE call.
"آخر N شهور/سنوات متوفرة في البيانات" or "متاحة في الداتا" → always limit=N directly. NEVER ask if the user means "from today" vs "in the database" — "متوفرة/متاحة في البيانات" already answers that question.

## Breakdown by category
"مع بيان أنواع المخالفات" / "مقسّم حسب النوع" / "حسب فئة المخالفة" → use breakdownField=<violation type field> in query_time_series.
This produces one line per violation type. Use chartType="line" with it.
Do NOT ask which categories to include — use all top categories (the tool picks the top 6 automatically).

## compareMode — CRITICAL RULES
compareMode=true = one query PER named group, side-by-side chart on a SHARED scale.
  - groupByField = the BREAKDOWN dimension inside each group (e.g. violation type, نوع المخالفة)
  - filterField  = the dimension you SPLIT BY (e.g. governorate)
  - filterValues = the list of named groups (e.g. ["القاهره","الاسكندريه"])

Example: "قارن أنواع المخالفات في القاهره والاسكندريه" or "مقارنه بين القاهره والاسكندريه"
  → compareMode=true, groupByField=<violation type field>, filterField=<governorate field>, filterValues=["القاهره","الاسكندريه"], showChart=true
  ✗ WRONG: groupByField=<governorate field> — never group BY the same field you filter on

Example: "أكثر المحافظات بلاغاً" (ranking all governorates, no comparison)
  → compareMode=false, groupByField=<governorate field>, showChart=true

## Map behavior (automatic)
Every tool automatically syncs the map: location-specific queries zoom to those features and dim others; whole-dataset queries zoom to full extent and clear any previous dimming. You do not control this — just set filterField/filterValues correctly.

## Default behavior for missing context
If no location is mentioned in the query, default to ALL data — do not ask which governorate.
Only ask when a location was explicitly named in a previous turn AND the current query is ambiguous about whether to continue that scope.

## Clarify only when genuinely ambiguous
Ask ONE short question in the user's language when intent is unclear. Otherwise act immediately.

## After the tool runs
Write 2-3 sentences of analytical insight in the user's language:
- What is the main finding (highest, lowest, most significant)?
- Compare groups if multiple are present (use percentages or ratios)
- Add one practical observation ("هذا يشير إلى..." / "يلاحظ أن...")`,
  tools: [queryChartTool, timeSeriesTool, summaryTool]
}).registration;
