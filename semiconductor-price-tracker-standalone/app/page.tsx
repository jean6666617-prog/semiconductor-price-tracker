"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import trackingConfig from "../config/tracking.json";
import { runCrawler, type PriceResult, type TrackingEntry } from "../lib/crawlers";
import { categorySources, seedItems } from "./data";
import { workbookHistory, workbookItems } from "./workbook-data";
import type { Item, Status } from "./types";

const retainedGroups = new Set(["SOC芯片", "MCU芯片", "PCB", "SGT MOS / MOSFET"]);
const seed: Item[] = [...seedItems.filter((item) => retainedGroups.has(item.group)), ...workbookItems] as Item[];

const statuses: Status[] = ["已更新", "待更新", "待确认", "暂无来源"];
const trendRanges = ["7天", "30天", "90天", "180天", "全部"] as const;
type TrendRange = typeof trendRanges[number];
type TrendMode = "all" | "single";
type UpdateResult = PriceResult & { mode?: "real" | "mock" };
const tablePageSize = 10;
const trackingEntries = trackingConfig as TrackingEntry[];
const trendPalette = ["#8DA3B7", "#86B39D", "#E1B98A", "#B39AC7", "#E59AA3"];
const trendColorByName: Record<string, string> = {
  ABS: "#8DA3B7",
  PVC: "#86B39D",
  PC: "#E1B98A",
  PET: "#B39AC7",
  PP: "#E59AA3",
};

const initialHistory: Record<string, [string, number][]> = { ...workbookHistory };
for (const item of seed.filter((entry) => retainedGroups.has(entry.group))) {
  const value = Number(String(item.price).replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(value) && item.updated) initialHistory[`${item.group}::${item.name}`] = [[item.updated, value]];
}

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function trackingFor(category: string, name: string, mpn?: string) {
  return trackingEntries.find((entry) => entry.enabled
    && normalize(entry.category) === normalize(category)
    && (normalize(entry.name) === normalize(name) || normalize(entry.name) === normalize(mpn)));
}

function formatUtcDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKey(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : formatUtcDate(value);
  if (typeof value === "number") {
    const wholeDays = Math.floor(value);
    const date = new Date(Date.UTC(1899, 11, 30 + wholeDays));
    return Number.isNaN(date.getTime()) ? "" : formatUtcDate(date);
  }

  const text = String(value ?? "").trim();
  const full = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;

  const monthDay = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (monthDay) {
    return `${new Date().getFullYear()}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : formatUtcDate(date);
}

function sortSeries(series: [string, number][] = []) {
  const byDate = new Map<string, number>();
  for (const [rawDate, rawPrice] of series) {
    const date = dateKey(rawDate);
    const price = Number(rawPrice);
    if (date && Number.isFinite(price)) byDate.set(date, price);
  }
  return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])) as [string, number][];
}

function mergeHistory(savedHistory?: Record<string, [string, number][]>) {
  const merged: Record<string, [string, number][]> = {};
  const keys = new Set([...Object.keys(savedHistory ?? {}), ...Object.keys(initialHistory)]);
  keys.forEach((key) => {
    merged[key] = sortSeries([...(initialHistory[key] ?? []), ...(savedHistory?.[key] ?? [])]);
  });
  return merged;
}

function mergeItems(savedItems?: Item[]) {
  if (!savedItems?.length) return seed;
  const sourceByKey = new Map(seed.map((item) => [`${item.group}::${item.name}`, item]));
  const merged = savedItems.map((item) => {
    const source = sourceByKey.get(`${item.group}::${item.name}`);
    return source && dateKey(source.updated) > dateKey(item.updated) ? source : item;
  });

  const savedKeys = new Set(merged.map((item) => `${item.group}::${item.name}`));
  for (const item of seed) {
    if (!savedKeys.has(`${item.group}::${item.name}`)) merged.push(item);
  }
  return merged;
}

function latestDateFromHistory(history: Record<string, [string, number][]>) {
  return Object.values(history).flat().reduce((latest, [date]) => dateKey(date) > latest ? dateKey(date) : latest, "");
}

function dateMs(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function filterTrendRange(series: [string, number][], range: TrendRange, maxDate?: string) {
  if (range === "全部") return series;
  const days = Number(range.replace("天", ""));
  const lastDate = maxDate || series.at(-1)?.[0];
  if (!lastDate || !Number.isFinite(days)) return series;
  const threshold = dateMs(lastDate) - (days - 1) * 86400 * 1000;
  return series.filter(([date]) => dateMs(date) >= threshold);
}

function trendColor(name: string, index: number) {
  return trendColorByName[name] || trendPalette[index % trendPalette.length];
}

function niceStep(rawStep: number) {
  const power = 10 ** Math.floor(Math.log10(rawStep || 1));
  const normalized = rawStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function priceTicks(values: number[]) {
  if (!values.length) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, Math.max(Math.abs(max) * 0.02, 1));
  let step = niceStep(range / 4);
  let start = Math.floor(min / step) * step;
  let end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step * 0.5; value += step) ticks.push(Number(value.toFixed(6)));
  while (ticks.length > 6) {
    step = niceStep(step * 1.5);
    start = Math.floor(min / step) * step;
    end = Math.ceil(max / step) * step;
    ticks.length = 0;
    for (let value = start; value <= end + step * 0.5; value += step) ticks.push(Number(value.toFixed(6)));
  }
  return ticks.length >= 2 ? ticks : [min - range / 2, max + range / 2];
}

function dateTicks(dates: string[]) {
  const uniqueDates = Array.from(new Set(dates.filter((date) => date && date !== "—")));
  if (uniqueDates.length <= 5) return uniqueDates;
  const count = uniqueDates.length <= 7 ? 4 : uniqueDates.length <= 30 ? 6 : 5;
  return Array.from(new Set(Array.from({ length: count }, (_, index) => uniqueDates[Math.round(index * (uniqueDates.length - 1) / (count - 1))])));
}

function tablePageWindow(current: number, total: number) {
  if (total <= 5) return Array.from({ length: total }, (_, index) => index);
  if (current <= 1) return [0, 1, 2, total - 1];
  if (current >= total - 2) return [total - 3, total - 2, total - 1].filter((page) => page >= 0);
  return [current - 1, current, current + 1, total - 1];
}

export default function Home() {
  const [items, setItems] = useState<Item[]>(seed);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("全部品类");
  const [status, setStatus] = useState("全部状态");
  const [trendGroup, setTrendGroup] = useState("塑料件");
  const [trendCommodity, setTrendCommodity] = useState("塑料件::ABS");
  const [trendMode, setTrendMode] = useState<TrendMode>("all");
  const [selectedTrendRange, setSelectedTrendRange] = useState<TrendRange>("全部");
  const [tablePage, setTablePage] = useState(0);
  const [history, setHistory] = useState<Record<string, [string, number][]>>(initialHistory);
  const [importMessage, setImportMessage] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateResults, setUpdateResults] = useState<UpdateResult[]>([]);
  const [updatingPrices, setUpdatingPrices] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastRemaining = useRef(6000);
  const toastStarted = useRef(0);
  const [toastDismissed, setToastDismissed] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ source: "", url: "" });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("semiconductor-price-items-v8");
    if (saved) {
      try { setItems(mergeItems(JSON.parse(saved))); } catch { /* keep defaults */ }
    }
    const savedHistory = localStorage.getItem("semiconductor-price-history-v5");
    if (savedHistory) {
      try { setHistory(mergeHistory(JSON.parse(savedHistory))); } catch { /* keep defaults */ }
    } else {
      setHistory(mergeHistory());
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem("semiconductor-price-items-v8", JSON.stringify(items));
  }, [items, ready]);

  useEffect(() => {
    if (ready) localStorage.setItem("semiconductor-price-history-v5", JSON.stringify(history));
  }, [history, ready]);

  const clearToastTimer = () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
  };

  const startToastTimer = (duration = toastRemaining.current) => {
    clearToastTimer();
    toastRemaining.current = duration;
    toastStarted.current = Date.now();
    toastTimer.current = setTimeout(() => {
      setToastDismissed(true);
      clearToastTimer();
    }, duration);
  };

  const pauseToastTimer = () => {
    if (!toastTimer.current) return;
    toastRemaining.current = Math.max(0, toastRemaining.current - (Date.now() - toastStarted.current));
    clearToastTimer();
  };

  const resumeToastTimer = () => {
    if (!updatingPrices && updateResults.length > 0 && !toastDismissed) startToastTimer(toastRemaining.current);
  };

  const closeToast = () => {
    clearToastTimer();
    setToastDismissed(true);
  };

  useEffect(() => () => clearToastTimer(), []);

  const groups = useMemo(() => ["全部品类", ...Array.from(new Set(items.map((item) => item.group)))], [items]);
  const visible = useMemo(() => items.filter((item) => {
    const hit = `${item.group}${item.name}${item.spec}${item.source}${item.supplier}${item.mpn}`.toLowerCase().includes(query.toLowerCase());
    return hit && (group === "全部品类" || item.group === group) && (status === "全部状态" || item.status === status);
  }), [items, query, group, status]);
  const tablePageCount = Math.max(Math.ceil(visible.length / tablePageSize), 1);
  const currentTablePage = Math.min(tablePage, tablePageCount - 1);
  const pagedVisible = visible.slice(currentTablePage * tablePageSize, (currentTablePage + 1) * tablePageSize);
  const tableStart = visible.length ? currentTablePage * tablePageSize + 1 : 0;
  const tableEnd = Math.min((currentTablePage + 1) * tablePageSize, visible.length);
  const visibleTablePages = tablePageWindow(currentTablePage, tablePageCount);

  const updated = items.filter((item) => item.status === "已更新").length;
  const sourced = items.filter((item) => item.url).length;
  const rate = Math.round((updated / items.length) * 100);
  const latestItemDate = items.reduce((latest, item) => dateKey(item.updated) > latest ? dateKey(item.updated) : latest, "");
  const latestHistoryDate = latestDateFromHistory(history);
  const latestDate = [latestItemDate, latestHistoryDate].reduce((latest, date) => dateKey(date) > latest ? dateKey(date) : latest, "");
  const [latestYear, latestMonth, latestDay] = (latestDate || "---- -- --").split("-");
  const sortedHistory = useMemo(() => mergeHistory(history), [history]);
  const unitByTrendKey = useMemo(() => new Map(items.map((item) => [`${item.group}::${item.name}`, item.unit])), [items]);
  const trendGroups = Array.from(new Set(Object.keys(sortedHistory).map((key) => key.split("::")[0])));
  const trendOptions = Object.keys(sortedHistory).filter((key) => key.startsWith(`${trendGroup}::`));
  const activeTrendKey = trendOptions.includes(trendCommodity) ? trendCommodity : trendOptions[0] || Object.keys(sortedHistory)[0];
  const trendName = activeTrendKey?.split("::").slice(1).join("::") || "暂无数据";
  const unitForTrendKey = (key?: string) => key ? unitByTrendKey.get(key) || "—" : "—";
  const activeTrendUnit = unitForTrendKey(activeTrendKey);
  const allTrendUnits = Array.from(new Set(trendOptions.map(unitForTrendKey).filter((unit) => unit && unit !== "—")));
  const chartUnit = trendMode === "all"
    ? allTrendUnits.length === 1 ? allTrendUnits[0] : activeTrendUnit !== "—" ? activeTrendUnit : allTrendUnits[0] || "—"
    : activeTrendUnit;
  const groupLatestDate = trendOptions.reduce((latest, key) => {
    const seriesLatest = sortedHistory[key]?.at(-1)?.[0] || "";
    return seriesLatest > latest ? seriesLatest : latest;
  }, "");
  const rawTrend = sortedHistory[activeTrendKey] ?? [];
  const filteredTrend = filterTrendRange(rawTrend, selectedTrendRange, groupLatestDate);
  const trend = filteredTrend.length ? filteredTrend : rawTrend.length ? rawTrend : [["—", 0] as [string, number]];
  const allTrendSeries = trendOptions.map((key, index) => {
    const name = key.split("::").slice(1).join("::");
    return { key, name, unit: unitForTrendKey(key), color: trendColor(name, index), points: filterTrendRange(sortedHistory[key] ?? [], selectedTrendRange, groupLatestDate) };
  }).filter((series) => series.points.length);
  const allTrendDates = Array.from(new Set(allTrendSeries.flatMap((series) => series.points.map(([date]) => date)))).sort();
  const allTrendPrices = allTrendSeries.flatMap((series) => series.points.map((point) => point[1]));
  const trendPrices = trend.map((point) => point[1]);
  const activeTrendPrices = trendMode === "all" ? allTrendPrices : trendPrices;
  const yTicks = priceTicks(activeTrendPrices);
  const priceMin = activeTrendPrices.length ? Math.min(...activeTrendPrices) : 0;
  const priceMax = activeTrendPrices.length ? Math.max(...activeTrendPrices) : 1;
  const pricePadding = Math.max((priceMax - priceMin) * 0.08, Math.abs(priceMax) * 0.005, 1);
  const yMin = Math.min(yTicks[0], priceMin - pricePadding);
  const yMax = Math.max(yTicks.at(-1) || yMin + 1, priceMax + pricePadding);
  const yRange = Math.max(yMax - yMin, 1);
  const activeTrendDates = trendMode === "all" ? allTrendDates : trend.map((point) => point[0]);
  const xTicks = dateTicks(activeTrendDates);
  const chartLeft = 18;
  const chartRight = 116;
  const chartTop = 7;
  const chartBottom = 52;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;
  const xForPoint = (index: number) => chartLeft + index * (chartWidth / Math.max(trend.length - 1, 1));
  const yForPrice = (price: number) => chartBottom - ((price - yMin) / yRange) * chartHeight;
  const chartPoints = trend.map((point, index) => `${xForPoint(index)},${yForPrice(point[1])}`).join(" ");
  const xForDate = (date: string) => chartLeft + Math.max(allTrendDates.indexOf(date), 0) * (chartWidth / Math.max(allTrendDates.length - 1, 1));
  const yForAllPrice = (price: number) => chartBottom - ((price - yMin) / yRange) * chartHeight;
  const xForTick = (date: string) => trendMode === "all"
    ? xForDate(date)
    : xForPoint(Math.max(activeTrendDates.indexOf(date), 0));
  const dailyChange = (trendPrices.at(-1)! - trendPrices[0]) / Math.max(trendPrices.length - 1, 1);
  const forecast = trendPrices.at(-1)! + dailyChange;
  const changeRate = ((trendPrices.at(-1)! / trendPrices[0]) - 1) * 100;

  function markUpdated(id: number) {
    const today = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date()).replaceAll("/", "-");
    setItems((current) => current.map((item) => item.id === id ? { ...item, status: "已更新", updated: today } : item));
  }

  function openEditor(item: Item) {
    setEditing(item.id);
    setDraft({ source: item.source, url: item.url });
  }

  function saveReference() {
    setItems((current) => current.map((item) => item.id === editing
      ? { ...item, source: draft.source || "参考来源（占位）", url: draft.url, status: draft.url ? item.status === "暂无来源" ? "待确认" : item.status : "暂无来源" }
      : item));
    setEditing(null);
  }

  function resetData() {
    setItems(seed);
    setHistory(initialHistory);
    localStorage.removeItem("semiconductor-price-latest-date-v3");
    setImportMessage("");
    setUpdateMessage("");
    setQuery(""); setGroup("全部品类"); setStatus("全部状态");
  }

  async function updatePrices() {
    clearToastTimer();
    toastRemaining.current = 6000;
    setToastDismissed(false);
    setUpdatingPrices(true);
    setImportMessage("");
    setUpdateResults([]);
    let nextItems = items;
    let nextHistory = history;
    let successCount = 0;
    const results: UpdateResult[] = [];

    try {
      for (const entry of trackingEntries.filter((item) => item.enabled)) {
        setUpdateMessage(`正在更新 ${entry.name}`);
        const result: PriceResult = entry.crawler === "plastic" || entry.crawler === "sunsirs_plastic"
          ? await fetchPlasticCrawler(entry)
          : await runCrawler(entry);
        const trackedResult = { ...result, mode: entry.mode };
        results.push(trackedResult);
        setUpdateResults([...results]);
        console.log("[Crawler Result]", {
          material: trackedResult.material,
          source: trackedResult.source,
          success: trackedResult.success,
          price: trackedResult.price,
          unit: trackedResult.unit,
          updateDate: trackedResult.updateDate,
          error: trackedResult.error,
          mode: trackedResult.mode,
        });
        if (!result.success || result.price === null) continue;

        const target = nextItems.find((item) => item.group === result.category
          && (normalize(item.name) === normalize(result.material) || normalize(item.mpn) === normalize(result.material)));
        if (!target) continue;

        const key = `${target.group}::${target.name}`;
        nextItems = nextItems.map((item) => item.id === target.id ? {
          ...item,
          price: String(result.price),
          unit: result.unit,
          source: result.source,
          status: "已更新",
          updated: result.updateDate,
        } : item);
        const crawlerHistory = result.history?.length
          ? result.history.map((point) => [point.date, point.price] as [string, number])
          : [[result.updateDate, result.price] as [string, number]];
        nextHistory = { ...nextHistory, [key]: sortSeries([...(nextHistory[key] ?? []), ...crawlerHistory]) };
        successCount += 1;
      }
      setItems(nextItems);
      setHistory(nextHistory);
      setUpdateMessage(`成功更新${successCount}条`);
      if (results.length > 0) startToastTimer(6000);
    } finally {
      setUpdatingPrices(false);
    }
  }

  async function fetchPlasticCrawler(entry: TrackingEntry): Promise<PriceResult> {
    try {
      return await fetch("/api/crawler/plastic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      }).then((response) => response.json() as Promise<PriceResult>);
    } catch (error) {
      return {
        success: false,
        category: entry.category,
        material: entry.name,
        price: null,
        currency: "RMB",
        unit: "RMB/ton",
        source: entry.source,
        updateDate: dateKey(new Date()),
        error: error instanceof Error ? error.message : "Plastic API request failed",
      };
    }
  }

  async function importExcel(file?: File) {
    if (!file) return;
    try {
      setUpdateMessage("");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const findSheet = (expected: string) => {
        const target = normalize(expected);
        const name = workbook.SheetNames.find((candidate) => normalize(candidate) === target)
          || workbook.SheetNames.find((candidate) => normalize(candidate).includes(target) || target.includes(normalize(candidate)));
        return name ? workbook.Sheets[name] : undefined;
      };
      const rows = (sheet: string) => {
        const worksheet = findSheet(sheet);
        return worksheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" }) : [];
      };
      const totals = rows("总表");
      const market = rows("DDR-BATTERY-LCD");
      const plastics = rows("塑料件");
      if (!totals.length && !market.length && !plastics.length) throw new Error("未找到约定工作表");
      console.log("[Excel Import] Sheet解析数量", { 总表: totals.length, DDR: market.length, 塑料件: plastics.length });

      const rowDate = (row: Record<string, unknown>) => dateKey(row.Date || row["日期"] || row["数据日期"]);
      const rowMpn = (row: Record<string, unknown>) => String(row.MPN || row.Mpn || row.mpn || "").trim();
      const rowMaterial = (row: Record<string, unknown>) => String(row.Material || row.Material_Name || row.Item || row.Commodity || "").trim();
      const rawPriceFrom = (row: Record<string, unknown>) => row["Session Average"] || row.Price || row["Latest Price"] || "";
      const itemKeys = (item: Item) => [
        item.mpn && normalize(item.mpn) !== normalize("—") ? `mpn:${normalize(item.group)}|${normalize(item.mpn)}` : "",
        item.name ? `material:${normalize(item.group)}|${normalize(item.name)}` : "",
        item.spec ? `material:${normalize(item.group)}|${normalize(item.spec)}` : "",
      ].filter(Boolean);
      const rowKeys = (groupName: string, row: Record<string, unknown>, fallbackName = "") => [
        rowMpn(row) ? `mpn:${normalize(groupName)}|${normalize(rowMpn(row))}` : "",
        rowMaterial(row) ? `material:${normalize(groupName)}|${normalize(rowMaterial(row))}` : "",
        fallbackName ? `material:${normalize(groupName)}|${normalize(fallbackName)}` : "",
      ].filter(Boolean);
      const allRows = [...totals, ...market, ...plastics];
      const recognizedDates = allRows.map(rowDate).filter(Boolean).sort();
      const workbookLatest = recognizedDates.at(-1) || "";

      const importedHistory: Record<string, [string, number][]> = {};
      const marketGroupName: Record<string, string> = { ddr: "DDR内存", lcd: "LCD屏幕", battery: "电池", nandflash: "NAND Flash" };
      market.forEach((row) => {
        const groupName = marketGroupName[normalize(row.Category)] || String(row.Category || "").trim();
        const name = String(row.Item || "").trim();
        const price = Number(row["Session Average"]);
        const date = rowDate(row);
        if (groupName && name && date && Number.isFinite(price)) (importedHistory[`${groupName}::${name}`] ||= []).push([date, price]);
      });
      plastics.forEach((row) => {
        const name = String(row.Commodity || "").trim();
        const price = Number(row.Price);
        const date = rowDate(row);
        if (name && date && Number.isFinite(price)) (importedHistory[`塑料件::${name}`] ||= []).push([date, price]);
      });
      totals.forEach((row) => {
        const groupName = String(row.Category || "").trim();
        const name = String(row.Material_Name || "").trim();
        const price = Number(String(row["Latest Price"] || row["Session Average"]).replace(/[^0-9.-]/g, ""));
        const date = rowDate(row);
        if (retainedGroups.has(groupName) && name && date && Number.isFinite(price)) (importedHistory[`${groupName}::${name}`] ||= []).push([date, price]);
      });
      Object.values(importedHistory).forEach((series) => series.sort((a, b) => a[0].localeCompare(b[0])));
      if (Object.keys(importedHistory).length) {
        setHistory(importedHistory);
        if (!importedHistory[activeTrendKey]) {
          const first = Object.keys(importedHistory)[0];
          setTrendGroup(first.split("::")[0]);
          setTrendCommodity(first);
        }
      }

      const latestPlastic = new Map<string, Record<string, unknown>>();
      plastics.forEach((row) => {
        const name = String(row.Commodity || "").trim();
        const previous = latestPlastic.get(name);
        if (name && (!previous || rowDate(row) > rowDate(previous))) latestPlastic.set(name, row);
      });

      const latestMarket = new Map<string, Record<string, unknown>>();
      market.forEach((row) => {
        const key = `${normalize(row.Category)}|${normalize(row.Item)}`;
        const previous = latestMarket.get(key);
        if (key !== "|" && (!previous || rowDate(row) > rowDate(previous))) latestMarket.set(key, row);
      });

      const latestTotals = new Map<string, Record<string, unknown>>();
      totals.forEach((row) => {
        const key = normalize(row.Material_Name);
        const previous = latestTotals.get(key);
        if (key && (!previous || rowDate(row) > rowDate(previous))) latestTotals.set(key, row);
      });

      let matched = 0;
      let changed = 0;
      const retainedItems = items.filter((item) => retainedGroups.has(item.group)).map((item) => {
        const row = latestTotals.get(normalize(item.name));
        if (!row) return item;
        matched += 1;
        const rawPrice = rawPriceFrom(row);
        const importedDate = rowDate(row) || item.updated;
        const importedUrl = String(row.Price_Source_URL || "").trim();
        const next = { ...item, price: rawPrice === "" ? item.price : String(rawPrice), updated: importedDate, url: importedUrl || item.url, status: rawPrice === "" ? item.status : "已更新" as Status };
        if (next.price !== item.price || next.updated !== item.updated || next.url !== item.url) changed += 1;
        return next;
      });
      const priorByKey = new Map<string, Item>();
      items.forEach((item) => itemKeys(item).forEach((key) => priorByKey.set(key, item)));
      const findPrior = (groupName: string, row: Record<string, unknown>, name: string) => {
        for (const key of rowKeys(groupName, row, name)) {
          const prior = priorByKey.get(key);
          if (prior) return prior;
        }
        return undefined;
      };
      const addImported = (groupName: string, name: string, row: Record<string, unknown>, source: string, url: string, unit: string, mpn = "—", supplier = String(row.Brand || "—"), cadence = groupName === "塑料件" ? "每日" : "每周") => {
        const prior = findPrior(groupName, row, name);
        const rawPrice = rawPriceFrom(row);
        return { id: prior?.id ?? 10000, group: groupName, name, spec: name,
          supplier, mpn, price: rawPrice === "" ? "—" : String(rawPrice), unit, source, url,
          status: rawPrice === "" ? "待更新" : "已更新" as Status, updated: rowDate(row), cadence };
      };
      const sourceItems: Item[] = [];
      const priorityItems: Item[] = [];
      latestMarket.forEach((row) => {
        const groupName = marketGroupName[normalize(row.Category)] || String(row.Category || "").trim();
        const name = String(row.Item || "").trim();
        if (groupName && name) priorityItems.push(addImported(groupName, name, row, "TrendForce", "https://www.trendforce.com/", String(row.Unit || "—"), rowMpn(row) || "—"));
      });
      const plasticUrls: Record<string, string> = { ABS: "https://www.sunsirs.com/uk/prodetail-713.html", PVC: "https://www.sunsirs.com/uk/prodetail-107.html", PC: "https://www.sunsirs.com/uk/prodetail-172.html", PET: "https://www.sunsirs.com/uk/prodetail-173.html", PP: "https://www.sunsirs.com/uk/prodetail-718.html" };
      latestPlastic.forEach((row, name) => priorityItems.push(addImported("塑料件", name, row, "生意社 Sunsirs", plasticUrls[name] || "", "RMB/吨")));
      const latestSourceRows = new Map<string, Record<string, unknown>>();
      totals.forEach((row) => {
        const mpn = rowMpn(row);
        const groupName = String(row.Category || "").trim();
        const name = String(row.Material_Name || "").trim();
        const date = rowDate(row);
        const rawPrice = rawPriceFrom(row);
        if (!groupName || !name || !date || rawPrice == null || rawPrice === "") return;
        const sourceKey = rowKeys(groupName, row, name)[0];
        if (!sourceKey) return;
        const previous = latestSourceRows.get(sourceKey);
        if (!previous || date > rowDate(previous)) latestSourceRows.set(sourceKey, row);
      });
      latestSourceRows.forEach((row) => {
        const mpn = rowMpn(row);
        const groupName = String(row.Category || "").trim();
        const name = String(row.Material_Name || "").trim();
        const tracking = trackingFor(groupName, name, mpn);
        const source = String(row.Price_Source || row["Price Source"] || row.Source || row.Supplier || row.Brand || tracking?.source || "总表").trim() || "总表";
        const url = String(row.Price_Source_URL || row["Price Source URL"] || "").trim();
        const unit = String(row.Unit || "—").trim() || "—";
        const supplier = String(row.Supplier || row.Brand || "—").trim() || "—";
        sourceItems.push(addImported(groupName, name, row, source, url, unit, mpn || "—", supplier, retainedGroups.has(groupName) ? "每月" : "每周"));
      });
      const mergeLayers = (baseItems: Item[], overlayItems: Item[]) => {
        const merged: Item[] = [];
        const keyToIndex = new Map<string, number>();
        let ddrOverrides = 0;
        let plasticOverrides = 0;
        const put = (item: Item, layer: "source" | "priority") => {
          const keys = itemKeys(item);
          const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index) => index !== undefined);
          if (existingIndex !== undefined) {
            if (layer === "priority") {
              if (item.group === "塑料件") plasticOverrides += 1;
              else ddrOverrides += 1;
            }
            merged[existingIndex] = { ...item, id: merged[existingIndex].id };
            keys.forEach((key) => keyToIndex.set(key, existingIndex));
            return;
          }
          const index = merged.length;
          merged.push({ ...item, id: item.id === 10000 ? 10000 + index : item.id });
          keys.forEach((key) => keyToIndex.set(key, index));
        };
        baseItems.forEach((item) => put(item, "source"));
        overlayItems.forEach((item) => put(item, "priority"));
        return { merged, ddrOverrides, plasticOverrides };
      };
      const { merged: mergedItems, ddrOverrides, plasticOverrides } = mergeLayers([...retainedItems, ...sourceItems], priorityItems);
      const nextItems = mergedItems;
      console.log("[Excel Import] 覆盖数量", { DDR覆盖总表: ddrOverrides, 塑料件覆盖总表: plasticOverrides });
      console.log("[Excel Import] 最终展示数量", { mergedItems: mergedItems.length });
      setItems(nextItems);
      const dateText = workbookLatest ? `，最晚日期 ${workbookLatest}` : "，未识别到有效日期";
      setImportMessage(`已读取 ${file.name}${dateText}；匹配 ${matched} 条，实际变化 ${changed} 条`);
    } catch {
      setImportMessage("导入失败：请确认文件包含“总表”“DDR-BATTERY-LCD”或“塑料件”工作表");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">Si</span><span>半导体价格趋势追踪中心</span></div>
        <div className="header-actions">
          <span className="offline-pill"><span className="pulse" /> 本地维护模式</span>
          <input ref={fileInput} className="file-input" type="file" accept=".xlsx,.xls" onChange={(event) => importExcel(event.target.files?.[0])} />
          <button className="import-button" onClick={() => fileInput.current?.click()}>↑ 导入 Excel</button>
          <button className="ghost-button" onClick={updatePrices} disabled={updatingPrices}>{updatingPrices ? "更新中…" : "更新价格"}</button>
          <button className="ghost-button" onClick={resetData}>恢复示例数据</button>
        </div>
      </header>

      {!toastDismissed && (importMessage || updateMessage || updateResults.length > 0) && <div className="import-toast" role="status" onMouseEnter={pauseToastTimer} onMouseLeave={resumeToastTimer}>
        <button className="toast-close" onClick={closeToast} type="button" aria-label="关闭更新提示">×</button>
        {updateResults.length > 0 ? <div className="update-results">
          {updateMessage && <strong>{updateMessage}</strong>}
          {updateResults.map((result, index) => <span key={`${result.category}-${result.material}-${index}`}>
            {result.success && result.price !== null
              ? result.mode === "mock"
                ? `${result.material} 更新完成（模拟数据）`
                : `${result.material} 更新完成（${result.source}真实抓取）`
              : `${result.material || result.category} 更新失败，原因 ${result.error || "未获取到有效价格"}`}
          </span>)}
        </div> : updateMessage || importMessage}
      </div>}

      <div className="shell">
        <section className="hero">
          <div>
            <p className="eyebrow">SEMICONDUCTOR PRICE INTELLIGENCE</p>
            <h1>看见价格变化，<br /><em>判断下一步趋势。</em></h1>
            <p className="hero-copy">持续沉淀历史价格、识别涨跌方向，并为后续采购判断提供短期趋势参考。数据来源、更新状态与参考链接作为趋势分析的基础留痕。</p>
          </div>
          <div className="progress-panel">
            <div className="progress-head"><span>历史趋势覆盖</span><strong>5</strong></div>
            <div className="progress-track"><span style={{ width: `${rate}%` }} /></div>
            <div className="progress-meta"><span>塑料原料已形成连续序列</span><span>其他品类持续累计中</span></div>
          </div>
        </section>

        <section className="trend-section">
          <div className="section-heading"><div><p className="kicker">PRICE TREND & OUTLOOK</p><h2>历史价格趋势与短期参考</h2></div><p>实线为表格中的真实历史价格；右侧预测值按样本期平均日变化外推，仅用于方向参考。</p></div>
          <div className="trend-layout">
            <div className="trend-chart-card">
              <div className="trend-tabs" role="tablist" aria-label="趋势图模式">
                <button className={trendMode === "all" ? "active" : ""} onClick={() => setTrendMode("all")} type="button" role="tab" aria-selected={trendMode === "all"}>
                  全类别趋势<span>NEW</span>
                </button>
                <button className={trendMode === "single" ? "active" : ""} onClick={() => setTrendMode("single")} type="button" role="tab" aria-selected={trendMode === "single"}>单类别趋势</button>
              </div>
              <div className="trend-toolbar">
                <div className="trend-selectors">
                  <select value={trendGroup} onChange={(event) => { const nextGroup = event.target.value; const first = Object.keys(sortedHistory).find((key) => key.startsWith(`${nextGroup}::`)); setTrendGroup(nextGroup); if (first) setTrendCommodity(first); }} aria-label="选择大品类">
                    {trendGroups.map((name) => <option key={name} value={name}>{trendMode === "all" ? `${name}（全部）` : name}</option>)}
                  </select>
                  {trendMode === "single" && <select value={activeTrendKey} onChange={(event) => setTrendCommodity(event.target.value)} aria-label="选择具体物料">
                    {trendOptions.map((key) => <option key={key} value={key}>{key.split("::").slice(1).join("::")}</option>)}
                  </select>}
                </div>
                <div className="range-buttons" aria-label="选择时间范围">
                  {trendRanges.map((range) => <button key={range} className={selectedTrendRange === range ? "active" : ""} onClick={() => setSelectedTrendRange(range)} type="button">{range}</button>)}
                </div>
              </div>
              <svg className="trend-chart" viewBox="0 0 122 70" role="img" aria-label={trendMode === "all" ? `${trendGroup} 全类别历史价格趋势` : `${trendName} 历史价格趋势`} preserveAspectRatio="xMidYMid meet">
                {yTicks.map((value) => <g key={value}>
                  <line x1={chartLeft} y1={yForPrice(value)} x2={chartRight} y2={yForPrice(value)} className="grid-line" />
                  <text x={chartLeft - 2} y={yForPrice(value)} className="axis-tick y" dominantBaseline="middle">{value.toLocaleString()}</text>
                </g>)}
                <line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} className="axis-line" />
                <line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} className="axis-line" />
                {xTicks.map((date) => <text key={date} x={xForTick(date)} y="63" className="axis-tick x" textAnchor="middle">{date}</text>)}
                {trendMode === "all" ? allTrendSeries.map((series) => <g key={series.key}>
                  <polyline points={series.points.map(([date, price]) => `${xForDate(date)},${yForAllPrice(price)}`).join(" ")} className="trend-line multi" style={{ stroke: series.color }} />
                  {series.points.map(([date, price], index) => <circle key={`${series.key}-${date}-${index}`} cx={xForDate(date)} cy={yForAllPrice(price)} r=".72" className="trend-point filled" style={{ fill: series.color, stroke: series.color }}><title>{series.name} · {date}：{price.toLocaleString()} {series.unit}</title></circle>)}
                </g>) : <>
                  <polyline points={chartPoints} className="trend-line" />
                  {trend.map((point, index) => <circle key={`${point[0]}-${index}`} cx={xForPoint(index)} cy={yForPrice(point[1])} r=".72" className="trend-point filled"><title>{point[0]}：{point[1].toLocaleString()} {chartUnit}</title></circle>)}
                </>}
              </svg>
              <div className="axis-labels"><span>{trendMode === "all" ? allTrendDates[0] || "—" : trend[0][0]}</span><span>{trendMode === "all" ? allTrendDates.at(-1) || "—" : trend.at(-1)![0]}</span></div>
              <div className="trend-legend">
                {trendMode === "all"
                  ? allTrendSeries.map((series) => <span key={series.key}><i style={{ background: series.color }} />{series.name}</span>)
                  : <span><i />{trendName}</span>}
                <span className="chart-unit">{chartUnit}</span>
              </div>
            </div>
            <aside className="trend-insight">
              <span className={`direction ${changeRate >= 0 ? "up" : "down"}`}>{changeRate >= 0 ? "↗ 上行" : "↘ 下行"}</span>
              <p>样本期变化</p><strong>{changeRate >= 0 ? "+" : ""}{changeRate.toFixed(2)}%</strong>
              <dl><div><dt>最新价格</dt><dd>{trendPrices.at(-1)!.toLocaleString()}</dd></div><div><dt>短期参考值</dt><dd>{forecast.toFixed(2)}</dd></div><div><dt>历史样本</dt><dd>{trend.length} 天</dd></div></dl>
              <small>{trend.length > 1 ? "预测值为简单线性外推；历史继续积累后可升级为移动平均或时间序列模型。" : "当前只有一个历史日期，先展示价格点；导入下一期数据后会自动形成趋势线。"}</small>
            </aside>
          </div>
          <div className="coverage-note"><strong>趋势数据状态</strong><span>所有品类均保留 Excel 中的全部日期</span><span>多期数据绘制趋势线；单期数据先显示价格点，后续导入自动延长</span></div>
        </section>

        <section className="stats" aria-label="数据总览">
          <div><span>追踪物料</span><strong>{items.length}</strong><small>覆盖 {groups.length - 1} 个品类</small></div>
          <div><span>本期已更新</span><strong className="green">{updated}</strong><small>{items.length - updated} 项仍需处理</small></div>
          <div><span>已填写链接</span><strong>{sourced}</strong><small>{items.length - sourced} 个链接待补充</small></div>
          <div><span>最新更新日期</span><strong className="date">{latestMonth} · {latestDay}</strong><small>{latestYear} 年</small></div>
        </section>

        <section className="source-section">
          <div className="section-heading"><div><p className="kicker">SOURCE DIRECTORY</p><h2>可系统追踪品类价格来源</h2></div><p>DDR、LCD、电池与塑料原材料的集中入口，点击后在新页面打开。</p></div>
          <div className="source-grid">
            {categorySources.map((source) => <a className="source-card" href={source.url} target="_blank" rel="noreferrer" key={`${source.group}-${source.label}`}>
              <span>{source.group}</span><strong>{source.label}</strong><small>{source.source}</small><i>↗</i>
            </a>)}
          </div>
        </section>

        <section className="workflow-section">
          <div className="section-heading"><div><p className="kicker">MAINTENANCE FLOW</p><h2>价格追踪流程</h2></div><p>建议按顺序完成，每次更新后在清单中标记状态。</p></div>
          <div className="workflow">
            {[
              ["01", "确认追踪范围", "核对品类、规格与更新频率"],
              ["02", "采集参考价格", "访问来源并记录价格与日期"],
              ["03", "校验口径", "确认币种、单位与含税口径"],
              ["04", "更新与留痕", "标记状态并保留参考链接"],
            ].map(([num, title, desc], index) => <div className="flow-step" key={num}>
              <span className="step-num">{num}</span><div><h3>{title}</h3><p>{desc}</p></div>{index < 3 && <span className="arrow">→</span>}
            </div>)}
          </div>
        </section>

        <section className="tracker-section">
          <div className="section-heading tracker-heading"><div><p className="kicker">TRACKING MATRIX</p><h2>品类与更新状态</h2></div><div className="legend">{statuses.map((s) => <span key={s}><i className={`dot ${s}`} />{s}</span>)}</div></div>

          <div className="toolbar">
            <label className="search"><span>⌕</span><input value={query} onChange={(e) => { setQuery(e.target.value); setTablePage(0); }} placeholder="搜索品类、型号、供应商或来源…" /></label>
            <select value={group} onChange={(e) => { setGroup(e.target.value); setTablePage(0); }} aria-label="筛选品类">{groups.map((g) => <option key={g}>{g}</option>)}</select>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setTablePage(0); }} aria-label="筛选状态"><option>全部状态</option>{statuses.map((s) => <option key={s}>{s}</option>)}</select>
          </div>

          <div className="table-wrap">
            <table>
              <thead><tr><th>品类 / 物料</th><th>型号 / 供应商</th><th>当前价格</th><th>数据状态</th><th>最近更新</th><th>参考来源</th><th>操作</th></tr></thead>
              <tbody>{pagedVisible.map((item) => <tr key={item.id}>
                <td><span className="group-label">{item.group}</span><strong>{item.name}</strong></td>
                <td><span className="mpn">{item.mpn}</span><small className="supplier">{item.supplier}</small></td>
                <td><strong className="price">{item.price}</strong><small className="unit">{item.unit}</small></td>
                <td><span className={`status-tag ${item.status}`}><i />{item.status}</span></td>
                <td className="mono">{item.updated}</td>
                <td>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.source} ↗</a> : <button className="text-button" onClick={() => openEditor(item)}>＋ 添加参考链接</button>}</td>
                <td><div className="row-actions"><button onClick={() => markUpdated(item.id)} title="标记为今日已更新">✓</button><button onClick={() => openEditor(item)} title="编辑来源">✎</button></div></td>
              </tr>)}</tbody>
            </table>
            {visible.length === 0 && <div className="empty">没有符合当前筛选条件的品类。</div>}
          </div>
          <div className="table-pagination" aria-label="表格分页">
            <span>显示 {tableStart}-{tableEnd} 条，共{visible.length}条</span>
            <div>
              <button onClick={() => setTablePage(0)} disabled={currentTablePage === 0} type="button">首页</button>
              <button onClick={() => setTablePage((page) => Math.max(page - 1, 0))} disabled={currentTablePage === 0} type="button">‹ 上一页</button>
              {visibleTablePages.map((page, index) => <span className="pager-page" key={page}>
                {index > 0 && page - visibleTablePages[index - 1] > 1 && <span className="pager-gap">…</span>}
                <button className={page === currentTablePage ? "active" : ""} onClick={() => setTablePage(page)} type="button">{page + 1}</button>
              </span>)}
              <button onClick={() => setTablePage((page) => Math.min(page + 1, tablePageCount - 1))} disabled={currentTablePage === tablePageCount - 1} type="button">下一页 ›</button>
              <button onClick={() => setTablePage(tablePageCount - 1)} disabled={currentTablePage === tablePageCount - 1} type="button">末页</button>
            </div>
          </div>
          <p className="local-note">所有修改仅保存在此浏览器中 · 建议定期同步到主价格表</p>
        </section>
      </div>

      {editing !== null && <div className="modal-backdrop" onMouseDown={() => setEditing(null)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
          <button className="modal-close" onClick={() => setEditing(null)}>×</button>
          <p className="kicker">REFERENCE SOURCE</p><h2 id="modal-title">编辑参考来源</h2>
          <label>来源名称<input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="例如：TrendForce" /></label>
          <label>参考链接<input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" /></label>
          <p>链接留空时，该品类会自动标记为“暂无来源”。</p>
          <div className="modal-actions"><button className="ghost-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" onClick={saveReference}>保存来源</button></div>
        </div>
      </div>}
    </main>
  );
}
