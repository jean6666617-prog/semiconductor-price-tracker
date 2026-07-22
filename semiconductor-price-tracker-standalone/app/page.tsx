"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as XLSX from "xlsx";
import keyComponentsConfig from "../config/key-components.json";
import trackingConfig from "../config/tracking.json";
import { runCrawler, type PriceResult, type TrackingEntry } from "../lib/crawlers";
import type { KeyComponentEntry } from "../lib/crawlers/cytech";
import { exportAllPriceData, exportLatestUpdateData, type PriceExportRow } from "../lib/exportExcel";
import { categorySources, seedItems } from "./data";
import { workbookHistory, workbookItems } from "./workbook-data";
import type { Item, Status } from "./types";

const retainedGroups = new Set(["SOC芯片", "MCU芯片", "PCB", "SGT MOS / MOSFET"]);
const seed: Item[] = [...seedItems.filter((item) => retainedGroups.has(item.group)), ...workbookItems] as Item[];
const obsoleteMpns = new Set(["MCIMX515DVM10AC"]);

const statuses: Status[] = ["已更新", "待更新", "待确认", "暂无来源", "已追踪", "待验证", "待接入"];
const trendRanges = ["7天", "30天", "90天", "180天", "全部"] as const;
type TrendRange = typeof trendRanges[number];
type TrendMode = "all" | "single" | "key";
type UpdateResult = PriceResult & { mode?: "real" | "mock" };
type KeyComponentResult = PriceResult & { id: string };
type KeyComponentTableItem = Omit<Item, "id"> & {
  id: string;
  isKeyComponent: true;
};
type TableItem = (Item & { isKeyComponent?: false }) | KeyComponentTableItem;
type TrendTooltipEntry = {
  name: string;
  price: number;
  unit: string;
  source?: string;
  color: string;
};
type TrendTooltip = {
  date: string;
  x: number;
  y: number;
  entries: TrendTooltipEntry[];
} | null;
type UpdateScope = {
  label: string;
  trackingFilter?: (entry: TrackingEntry) => boolean;
  keyFilter?: (entry: KeyComponentEntry) => boolean;
};
const tablePageSize = 10;
const trackingEntries = trackingConfig as TrackingEntry[];
const keyComponentEntries = keyComponentsConfig as KeyComponentEntry[];
const cytechUpdateIds = new Set(["key-nxp-mcimx515djm8c", "key-nxp-tja1042t-3", "key-nxp-tja1055t-3"]);
const lcscUpdateIds = new Set(["key-nxp-mcimx9352cvvxmac", "key-nxp-pca9451ahny", "key-memory-femdrm032g-a3a55"]);
const keyComponentResultsStorageKey = "semiconductor-key-component-results-v1";
const trendPalette = ["#8DA3B7", "#86B39D", "#E1B98A", "#B39AC7", "#E59AA3"];
const trendColorByName: Record<string, string> = {
  ABS: "#8DA3B7",
  PVC: "#86B39D",
  PC: "#E1B98A",
  PET: "#B39AC7",
  PP: "#E59AA3",
};

const updateMenuGroups: { title: string; options: { label: string; scope: UpdateScope }[] }[] = [
  {
    title: "半导体器件",
    options: [
      {
        label: "NXP",
        scope: {
          label: "NXP",
          trackingFilter: (entry) => normalize(entry.category) === normalize("SOC芯片") || normalize(entry.name).includes("nxp"),
          keyFilter: (entry) => entry.category === "NXP",
        },
      },
      {
        label: "Memory",
        scope: {
          label: "Memory",
          keyFilter: (entry) => entry.category === "Memory",
        },
      },
    ],
  },
  {
    title: "市场指数",
    options: [
      { label: "DDR", scope: { label: "DDR", trackingFilter: (entry) => entry.category === "DDR内存" } },
      { label: "LCD", scope: { label: "LCD", trackingFilter: (entry) => entry.category === "LCD屏幕" } },
      { label: "电池", scope: { label: "电池", trackingFilter: (entry) => entry.category === "电池" } },
    ],
  },
  {
    title: "原材料",
    options: ["ABS", "PC", "PP", "PVC", "PET"].map((material) => ({
      label: material,
      scope: {
        label: material,
        trackingFilter: (entry) => entry.category === "塑料件" && entry.name === material,
      },
    })),
  },
];

const initialHistory: Record<string, [string, number][]> = { ...workbookHistory };
for (const item of seed.filter((entry) => retainedGroups.has(entry.group))) {
  const value = Number(String(item.price).replace(/[^0-9.-]/g, ""));
  if (Number.isFinite(value) && item.updated) initialHistory[`${item.group}::${item.name}`] = [[item.updated, value]];
}

function normalize(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function isObsoleteItem(item: Pick<Item, "mpn" | "name">) {
  return obsoleteMpns.has(String(item.mpn ?? "").trim().toUpperCase())
    || obsoleteMpns.has(String(item.name ?? "").trim().toUpperCase());
}

function filterObsoleteHistory(history?: Record<string, [string, number][]>) {
  if (!history) return undefined;
  return Object.fromEntries(Object.entries(history).filter(([key]) => {
    const material = key.split("::").slice(1).join("::").trim().toUpperCase();
    return !obsoleteMpns.has(material);
  }));
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

function mergeKeyComponentResult(current: KeyComponentResult | undefined, result: KeyComponentResult) {
  if (!result.success || result.price === null) return current ?? result;

  const resultHistory = result.history?.length
    ? result.history.map((point) => [point.date, point.price] as [string, number])
    : [[result.updateDate, result.price] as [string, number]];

  const currentHistory = current?.source === "LCSC" && (current.currency !== result.currency || current.unit !== result.unit)
    ? []
    : current?.history?.map((point) => [point.date, point.price] as [string, number]) ?? [];
  return {
    ...result,
    history: sortSeries([...currentHistory, ...resultHistory]).map(([date, price]) => ({ date, price })),
  };
}

function latestKeyComponentPoint(result?: KeyComponentResult) {
  if (!result?.success || result.price === null) return null;
  const price = Number(result.price);
  const series = result.history?.length
    ? result.history.map((point) => [point.date, point.price] as [string, number])
    : [[result.updateDate, price] as [string, number]];
  return sortSeries(series).at(-1) ?? null;
}

function keyComponentStatus(status?: string): Status {
  return status === "已追踪" || status === "待验证" || status === "待接入" ? status : "待确认";
}

function normalizeKeyComponentResults(saved?: Record<string, KeyComponentResult>) {
  const normalized: Record<string, KeyComponentResult> = {};
  if (!saved) return normalized;

  for (const [id, result] of Object.entries(saved)) {
    if (!result || result.id !== id || !result.success || result.price === null) continue;
    const price = Number(result.price);
    if (!Number.isFinite(price)) continue;
    const resultHistory = result.history?.length
      ? result.history.map((point) => [point.date, point.price] as [string, number])
      : [[result.updateDate, price] as [string, number]];
    normalized[id] = {
      ...result,
      price,
      history: sortSeries(resultHistory).map(([date, pointPrice]) => ({ date, price: pointPrice })),
    };
  }

  return normalized;
}

function mergeHistory(savedHistory?: Record<string, [string, number][]>) {
  const merged: Record<string, [string, number][]> = {};
  const filteredHistory = filterObsoleteHistory(savedHistory);
  const keys = new Set([...Object.keys(filteredHistory ?? {}), ...Object.keys(initialHistory)]);
  keys.forEach((key) => {
    merged[key] = sortSeries([...(initialHistory[key] ?? []), ...(filteredHistory?.[key] ?? [])]);
  });
  return merged;
}

function mergeItems(savedItems?: Item[]) {
  if (!savedItems?.length) return seed;
  const filteredItems = savedItems.filter((item) => !isObsoleteItem(item));
  const sourceByKey = new Map(seed.map((item) => [`${item.group}::${item.name}`, item]));
  const merged = filteredItems.map((item) => {
    const source = sourceByKey.get(`${item.group}::${item.name}`);
    return source && dateKey(source.updated) > dateKey(item.updated) ? source : item;
  });

  const savedKeys = new Set(merged.map((item) => `${item.group}::${item.name}`));
  for (const item of seed) {
    if (!savedKeys.has(`${item.group}::${item.name}`)) merged.push(item);
  }
  return merged;
}

type DashboardSnapshot = {
  items: Item[];
  history: Record<string, [string, number][]>;
};

type StateUpdate<T> = T | ((current: T) => T);

const serverDashboardSnapshot: DashboardSnapshot = { items: seed, history: initialHistory };

function applyStateUpdate<T>(update: StateUpdate<T>, current: T) {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function createDashboardStore() {
  let snapshot = serverDashboardSnapshot;
  let initialized = false;
  const listeners = new Set<() => void>();

  const initialize = () => {
    if (initialized || typeof window === "undefined") return;
    initialized = true;

    let savedItems: Item[] | undefined;
    let savedHistory: Record<string, [string, number][]> | undefined;
    try {
      const storedItems = localStorage.getItem("semiconductor-price-items-v8");
      if (storedItems) savedItems = JSON.parse(storedItems) as Item[];
    } catch { /* keep deterministic defaults */ }
    try {
      const storedHistory = localStorage.getItem("semiconductor-price-history-v5");
      if (storedHistory) savedHistory = JSON.parse(storedHistory) as Record<string, [string, number][]>;
    } catch { /* keep deterministic defaults */ }

    snapshot = { items: mergeItems(savedItems), history: mergeHistory(savedHistory) };
    try {
      localStorage.setItem("semiconductor-price-items-v8", JSON.stringify(snapshot.items));
      localStorage.setItem("semiconductor-price-history-v5", JSON.stringify(snapshot.history));
    } catch { /* storage can be unavailable in private contexts */ }
  };

  const notify = () => listeners.forEach((listener) => listener());
  const persist = () => {
    try {
      localStorage.setItem("semiconductor-price-items-v8", JSON.stringify(snapshot.items));
      localStorage.setItem("semiconductor-price-history-v5", JSON.stringify(snapshot.history));
    } catch { /* storage can be unavailable in private contexts */ }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const previousSnapshot = snapshot;
      initialize();
      if (snapshot !== previousSnapshot) listener();
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverDashboardSnapshot,
    setItems(update: StateUpdate<Item[]>) {
      initialize();
      snapshot = { ...snapshot, items: applyStateUpdate(update, snapshot.items) };
      persist();
      notify();
    },
    setHistory(update: StateUpdate<Record<string, [string, number][]>>) {
      initialize();
      snapshot = { ...snapshot, history: applyStateUpdate(update, snapshot.history) };
      persist();
      notify();
    },
  };
}

const dashboardStore = createDashboardStore();
const serverKeyComponentSnapshot: Record<string, KeyComponentResult> = {};

function createKeyComponentStore() {
  let snapshot: Record<string, KeyComponentResult> = {};
  let initialized = false;
  const listeners = new Set<() => void>();

  const initialize = () => {
    if (initialized || typeof window === "undefined") return;
    initialized = true;

    try {
      const storedResults = localStorage.getItem(keyComponentResultsStorageKey);
      if (storedResults) snapshot = normalizeKeyComponentResults(JSON.parse(storedResults) as Record<string, KeyComponentResult>);
    } catch { /* keep deterministic defaults */ }
  };

  const notify = () => listeners.forEach((listener) => listener());
  const persist = () => {
    try {
      localStorage.setItem(keyComponentResultsStorageKey, JSON.stringify(snapshot));
    } catch { /* storage can be unavailable in private contexts */ }
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      const previousSnapshot = snapshot;
      initialize();
      if (snapshot !== previousSnapshot) listener();
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverKeyComponentSnapshot,
    setResults(update: StateUpdate<Record<string, KeyComponentResult>>) {
      initialize();
      snapshot = normalizeKeyComponentResults(applyStateUpdate(update, snapshot));
      persist();
      notify();
    },
  };
}

const keyComponentStore = createKeyComponentStore();

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

function formatTrendPrice(price: number) {
  return Number.isFinite(price) ? price.toLocaleString(undefined, { maximumFractionDigits: 10 }) : "—";
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

function displayUnit(value?: Pick<PriceResult, "currency" | "unit">) {
  const unit = value?.unit || "—";
  if (!unit || unit === "—") return "—";
  if (unit.includes("/")) return unit;
  if (value?.currency === "CNY") return `¥/${unit}`;
  if (value?.currency === "USD") return `$/${unit}`;
  return value?.currency ? `${value.currency}/${unit}` : unit;
}

function isSuccessfulUpdate(result: UpdateResult) {
  return result.success && result.price !== null;
}

function updateResultText(result: UpdateResult) {
  if (!isSuccessfulUpdate(result)) {
    return `${result.material || result.category} 更新失败（${result.source}）`;
  }
  if (result.mode === "mock") return `${result.material} 更新完成（模拟数据）`;
  if (result.source === "LCSC") {
    return `${result.material} 更新完成（LCSC · ${result.price} ${displayUnit(result)} · ${result.updateDate}）`;
  }
  if (result.quantity === 1 && result.mpn) {
    return `${result.material} 更新完成（${result.mpn} · 单件价格 · ${result.price} ${displayUnit(result)} · ${result.updateDate}）`;
  }
  return `${result.material} 更新完成（${result.source}真实抓取）`;
}

async function fetchCytechCrawler(ids: string[]) {
  if (!ids.length) return [];
  let response: Response;
  try {
    response = await fetch("/api/crawler/cytech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error(`[Cytech API Request Failed] ${JSON.stringify({
        ids,
        errorName: error instanceof Error ? error.name : "",
        errorMessage: error instanceof Error ? error.message : String(error),
      })}`);
    }
    throw error;
  }

  const responseText = await response.text();
  let payload: { success?: boolean; error?: string; results?: KeyComponentResult[] };
  try {
    payload = JSON.parse(responseText) as { success?: boolean; error?: string; results?: KeyComponentResult[] };
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      console.error(`[Cytech API Invalid Response] ${JSON.stringify({
        ids,
        status: response.status,
        statusText: response.statusText,
        responseText,
        errorMessage: error instanceof Error ? error.message : String(error),
      })}`);
    }
    throw new Error(`Cytech API returned invalid JSON: ${response.status}`);
  }

  if (process.env.NODE_ENV === "development") {
    console.log(`[Cytech API Response] ${JSON.stringify({
      ids,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      payload,
    })}`);
  }

  if (!response.ok || !payload.success || !Array.isArray(payload.results)) {
    throw new Error(payload.error || `Cytech API request failed: ${response.status}`);
  }
  return payload.results.filter((result) => cytechUpdateIds.has(result.id));
}

async function fetchLcscCrawler(ids: string[]) {
  if (!ids.length) return [];
  const response = await fetch("/api/crawler/lcsc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const payload = await response.json() as { success?: boolean; error?: string; results?: KeyComponentResult[] };
  if (!response.ok || !payload.success || !Array.isArray(payload.results)) {
    throw new Error(payload.error || `LCSC API request failed: ${response.status}`);
  }
  return payload.results.filter((result) => lcscUpdateIds.has(result.id));
}

export default function Home() {
  const { items, history } = useSyncExternalStore(
    dashboardStore.subscribe,
    dashboardStore.getSnapshot,
    dashboardStore.getServerSnapshot,
  );
  const keyComponentResults = useSyncExternalStore(
    keyComponentStore.subscribe,
    keyComponentStore.getSnapshot,
    keyComponentStore.getServerSnapshot,
  );
  const setItems = dashboardStore.setItems;
  const setHistory = dashboardStore.setHistory;
  const setKeyComponentResults = keyComponentStore.setResults;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("全部品类");
  const [status, setStatus] = useState("全部状态");
  const [trendGroup, setTrendGroup] = useState("塑料件");
  const [trendCommodity, setTrendCommodity] = useState("塑料件::ABS");
  const [trendMode, setTrendMode] = useState<TrendMode>("all");
  const [selectedTrendRange, setSelectedTrendRange] = useState<TrendRange>("全部");
  const [trendTooltip, setTrendTooltip] = useState<TrendTooltip>(null);
  const [keyCategory, setKeyCategory] = useState("全部");
  const [selectedKeyRange, setSelectedKeyRange] = useState<TrendRange>("全部");
  const [keyTooltip, setKeyTooltip] = useState<TrendTooltip>(null);
  const [updatingKeyComponents, setUpdatingKeyComponents] = useState(false);
  const [tablePage, setTablePage] = useState(0);
  const [importMessage, setImportMessage] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateResults, setUpdateResults] = useState<UpdateResult[]>([]);
  const [latestUpdateRows, setLatestUpdateRows] = useState<PriceExportRow[]>([]);
  const [updatingPrices, setUpdatingPrices] = useState(false);
  const [showAllMovers, setShowAllMovers] = useState(false);
  const [updateMenuOpen, setUpdateMenuOpen] = useState(false);
  const [expandedUpdateMenuGroup, setExpandedUpdateMenuGroup] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const updateMenuRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastRemaining = useRef(6000);
  const toastStarted = useRef(0);
  const [toastDismissed, setToastDismissed] = useState(false);
  const [toastExpanded, setToastExpanded] = useState(false);
  const toastExpandedRef = useRef(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ source: "", url: "" });
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
    if (!toastExpandedRef.current && !updatingPrices && updateResults.length > 0 && !toastDismissed) {
      startToastTimer(toastRemaining.current);
    }
  };

  const setToastDetailsExpanded = (expanded: boolean) => {
    toastExpandedRef.current = expanded;
    setToastExpanded(expanded);
  };

  const toggleToastDetails = () => {
    const nextExpanded = !toastExpandedRef.current;
    setToastDetailsExpanded(nextExpanded);
    if (nextExpanded) {
      pauseToastTimer();
    } else {
      resumeToastTimer();
    }
  };

  const closeToast = () => {
    clearToastTimer();
    setToastDismissed(true);
  };

  const fetchKeyComponentPrices = useCallback(async (ids?: string[]) => {
    const cytechTargetIds = ids ?? keyComponentEntries
      .filter((entry) => entry.enabled && entry.crawler === "cytech" && cytechUpdateIds.has(entry.id))
      .map((entry) => entry.id);
    const lcscTargetIds = ids ?? keyComponentEntries
      .filter((entry) => entry.enabled && entry.crawler === "lcsc" && lcscUpdateIds.has(entry.id))
      .map((entry) => entry.id);
    const allowedCytechIds = cytechTargetIds.filter((id) => cytechUpdateIds.has(id));
    const allowedLcscIds = lcscTargetIds.filter((id) => lcscUpdateIds.has(id));
    if (!allowedCytechIds.length && !allowedLcscIds.length) return;
    setUpdatingKeyComponents(true);
    try {
      const results = [
        ...(await fetchCytechCrawler(allowedCytechIds)),
        ...(await fetchLcscCrawler(allowedLcscIds)),
      ];
      setKeyComponentResults((current) => {
        const next = { ...current };
        for (const result of results) next[result.id] = mergeKeyComponentResult(next[result.id], result);
        return next;
      });
    } finally {
      setUpdatingKeyComponents(false);
    }
  }, [setKeyComponentResults]);

  useEffect(() => () => clearToastTimer(), []);

  useEffect(() => {
    if (!updateMenuOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (updateMenuRef.current?.contains(event.target as Node)) return;
      setUpdateMenuOpen(false);
      setExpandedUpdateMenuGroup(null);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [updateMenuOpen]);

  const keyComponentTableItems = useMemo<KeyComponentTableItem[]>(() => keyComponentEntries
    .filter((entry) => entry.category === "NXP")
    .map((entry) => {
      const result = keyComponentResults[entry.id];
      const latestPoint = latestKeyComponentPoint(result);
      return {
        id: `key-table-${entry.id}`,
        isKeyComponent: true,
        group: entry.category,
        name: entry.name || entry.mpn,
        spec: entry.description,
        supplier: entry.category,
        mpn: entry.mpn,
        price: latestPoint ? formatTrendPrice(latestPoint[1]) : "—",
        unit: result ? displayUnit(result) : "USD/pcs",
        source: entry.source,
        url: entry.sourceUrl,
        status: keyComponentStatus(entry.status),
        updated: latestPoint?.[0] || "",
        cadence: "每日",
      };
    }), [keyComponentResults]);
  const tableItems = useMemo<TableItem[]>(() => [...items, ...keyComponentTableItems], [items, keyComponentTableItems]);
  const groups = useMemo(() => ["全部品类", ...Array.from(new Set(tableItems.map((item) => item.group)))], [tableItems]);
  const visible = useMemo(() => tableItems.filter((item) => {
    const hit = `${item.group}${item.name}${item.spec}${item.source}${item.supplier}${item.mpn}`.toLowerCase().includes(query.toLowerCase());
    return hit && (group === "全部品类" || item.group === group) && (status === "全部状态" || item.status === status);
  }), [tableItems, query, group, status]);
  const tablePageCount = Math.max(Math.ceil(visible.length / tablePageSize), 1);
  const currentTablePage = Math.min(tablePage, tablePageCount - 1);
  const pagedVisible = visible.slice(currentTablePage * tablePageSize, (currentTablePage + 1) * tablePageSize);
  const tableStart = visible.length ? currentTablePage * tablePageSize + 1 : 0;
  const tableEnd = Math.min((currentTablePage + 1) * tablePageSize, visible.length);
  const visibleTablePages = tablePageWindow(currentTablePage, tablePageCount);

  const updated = items.filter((item) => item.status === "已更新").length;
  const latestItemDate = items.reduce((latest, item) => dateKey(item.updated) > latest ? dateKey(item.updated) : latest, "");
  const latestHistoryDate = latestDateFromHistory(history);
  const latestDate = [latestItemDate, latestHistoryDate].reduce((latest, date) => dateKey(date) > latest ? dateKey(date) : latest, "");
  const sortedHistory = useMemo(() => mergeHistory(history), [history]);
  const unitByTrendKey = useMemo(() => new Map(items.map((item) => [`${item.group}::${item.name}`, item.unit])), [items]);
  const sourceByTrendKey = useMemo(() => new Map(items.map((item) => [`${item.group}::${item.name}`, item.source])), [items]);
  const dailyInsights = useMemo(() => {
    const series = Object.entries(sortedHistory).map(([key, points]) => {
      const sorted = sortSeries(points);
      const latest = sorted.at(-1);
      if (!latest) return null;
      const average = sorted.reduce((sum, [, price]) => sum + price, 0) / sorted.length;
      const [group, ...nameParts] = key.split("::");
      const name = nameParts.join("::");
      return { key, group, name, source: sourceByTrendKey.get(key) || "—", unit: unitByTrendKey.get(key) || "—", points: sorted, latest, average };
    }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const seriesByMaterial = new Map(series.map((entry) => [normalize(`${entry.group}${entry.name}`), entry]));
    const seriesByName = new Map(series.map((entry) => [normalize(entry.name), entry]));
    const updatedKeys = new Set<string>();
    const updatedEntries = updateResults.filter((result) => isSuccessfulUpdate(result) && result.price !== null).flatMap((result) => {
      const match = seriesByMaterial.get(normalize(`${result.category}${result.material}`)) || seriesByName.get(normalize(result.material));
      if (!match || updatedKeys.has(match.key)) return [];
      updatedKeys.add(match.key);
      return [match];
    });
    const insightDate = updatedEntries.length
      ? updatedEntries.reduce((latest, entry) => entry.latest[0] > latest ? entry.latest[0] : latest, "")
      : series.reduce((latest, entry) => entry.latest[0] > latest ? entry.latest[0] : latest, "");
    const calculationBase = updatedEntries.length ? updatedEntries : series.filter((entry) => entry.latest[0] === insightDate);
    const movers = calculationBase.flatMap((entry) => {
      const latestIndex = entry.points.findIndex(([date, price]) => date === entry.latest[0] && price === entry.latest[1]);
      const previous = latestIndex > 0 ? entry.points[latestIndex - 1] : undefined;
      if (!previous || previous[1] === 0) return [];
      const change = entry.latest[1] - previous[1];
      const changeRate = (change / previous[1]) * 100;
      if (changeRate === 0) return [];
      let risingStreak = 0;
      for (let index = latestIndex; index > 0; index -= 1) {
        if (entry.points[index][1] > entry.points[index - 1][1]) risingStreak += 1;
        else break;
      }
      const averageGapRate = entry.average ? ((entry.latest[1] / entry.average) - 1) * 100 : 0;
      return [{
        key: entry.key,
        group: entry.group,
        name: entry.name,
        source: entry.source,
        unit: entry.unit,
        date: entry.latest[0],
        price: entry.latest[1],
        previousPrice: previous[1],
        change,
        changeRate,
        average: entry.average,
        averageGapRate,
        risingStreak,
      }];
    }).sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate));
    const todaySeries = movers;
    const emptyEntry = {
      group: "—",
      name: "暂无可比价格变化",
      source: "—",
      unit: "—",
      date: insightDate || "—",
      price: 0,
      previousPrice: 0,
      changeRate: 0,
      averageGapRate: 0,
      average: 0,
      risingStreak: 0,
    };
    const riskCandidates = todaySeries
      .map((entry) => {
        const keyCategoryScore = /芯片|NXP|DDR|Memory|SOC|MCU/i.test(`${entry.group}${entry.name}`) ? 2 : 0;
        const score = Math.max(entry.changeRate, 0) * 2 + Math.max(entry.averageGapRate, 0) + entry.risingStreak * 1.5 + keyCategoryScore;
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score);
    const risk = riskCandidates[0]?.score > 0 ? riskCandidates[0].entry : emptyEntry;
    const riskLevel = risk === emptyEntry ? "低" : risk.changeRate >= 3 || risk.risingStreak >= 3 || risk.averageGapRate >= 5 ? "高" : risk.changeRate > 0 || risk.averageGapRate > 2 ? "中" : "低";
    const riskReason = risk === emptyEntry
      ? "暂无显著价格风险"
      : [
        risk.risingStreak >= 2 ? `连续上涨${risk.risingStreak}天` : risk.changeRate > 0 ? `单日上涨${risk.changeRate.toFixed(2)}%` : "",
        risk.averageGapRate > 0 ? `较历史均值上涨${risk.averageGapRate.toFixed(2)}%` : "",
      ].filter(Boolean).join("，");
    return {
      date: insightDate || "—",
      movers,
      risk: {
        entry: risk,
        level: riskLevel,
        reason: riskReason,
        averageTooltip: `计算方式：\n(当前价格 - 历史平均价格) / 历史平均价格 × 100%\n\n历史均价：${formatTrendPrice(risk.average)} ${risk.unit}\n当前价格：${formatTrendPrice(risk.price)} ${risk.unit}\n结果：${risk.averageGapRate >= 0 ? "+" : ""}${risk.averageGapRate.toFixed(2)}%`,
      },
    };
  }, [sortedHistory, sourceByTrendKey, unitByTrendKey, updateResults]);
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
  const showTrendTooltip = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const dates = activeTrendDates.filter((date) => date && date !== "—");
    if (!dates.length) {
      setTrendTooltip(null);
      return;
    }
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * 122;
    const svgY = ((clientY - rect.top) / rect.height) * 70;
    const candidates = trendMode === "all"
      ? allTrendSeries.flatMap((series) => series.points.map(([date, price]) => ({
        date,
        x: xForDate(date),
        y: yForAllPrice(price),
        entry: {
          name: series.name,
          price,
          unit: series.unit,
          source: sourceByTrendKey.get(series.key),
          color: series.color,
        },
      })))
      : trend.map(([date, price], index) => ({
        date,
        x: xForPoint(index),
        y: yForPrice(price),
        entry: {
          name: trendName,
          price,
          unit: chartUnit,
          source: sourceByTrendKey.get(activeTrendKey),
          color: trendColor(trendName, 0),
        },
      }));
    const nearest = candidates.reduce((closest, current) => {
      const currentDistance = Math.hypot((current.x - svgX) * 1.15, current.y - svgY);
      const closestDistance = Math.hypot((closest.x - svgX) * 1.15, closest.y - svgY);
      return currentDistance < closestDistance ? current : closest;
    }, candidates[0]);
    if (!nearest) {
      setTrendTooltip(null);
      return;
    }
    setTrendTooltip({ date: nearest.date, x: nearest.x, y: nearest.y, entries: [nearest.entry] });
  };
  const keyFilteredEntries = keyComponentEntries.filter((entry) => keyCategory === "全部" || entry.category === keyCategory);
  const keyChartSeries = keyFilteredEntries.flatMap((entry, index) => {
    const result = keyComponentResults[entry.id];
    const points = result?.success && result.price !== null
      ? filterTrendRange(result.history?.length ? result.history.map((point) => [point.date, point.price] as [string, number]) : [[result.updateDate, result.price]], selectedKeyRange, result.updateDate)
      : [];
    return points.length ? [{
      key: entry.id,
      name: entry.mpn,
      unit: result ? displayUnit(result) : "USD/pcs",
      source: result?.source || entry.source,
      color: trendColor(entry.mpn, index),
      points,
    }] : [];
  });
  const keyTrendDates = Array.from(new Set(keyChartSeries.flatMap((series) => series.points.map(([date]) => date)))).sort();
  const keyTrendPrices = keyChartSeries.flatMap((series) => series.points.map((point) => point[1]));
  const keyYTicks = priceTicks(keyTrendPrices);
  const keyPriceMin = keyTrendPrices.length ? Math.min(...keyTrendPrices) : 0;
  const keyPriceMax = keyTrendPrices.length ? Math.max(...keyTrendPrices) : 1;
  const keyPricePadding = Math.max((keyPriceMax - keyPriceMin) * 0.08, Math.abs(keyPriceMax) * 0.005, 1);
  const keyYMin = Math.min(keyYTicks[0], keyPriceMin - keyPricePadding);
  const keyYMax = Math.max(keyYTicks.at(-1) || keyYMin + 1, keyPriceMax + keyPricePadding);
  const keyYRange = Math.max(keyYMax - keyYMin, 1);
  const keyXTicks = dateTicks(keyTrendDates);
  const keyXForDate = (date: string) => chartLeft + Math.max(keyTrendDates.indexOf(date), 0) * (chartWidth / Math.max(keyTrendDates.length - 1, 1));
  const keyYForPrice = (price: number) => chartBottom - ((price - keyYMin) / keyYRange) * chartHeight;
  const showKeyTooltip = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    if (!keyTrendDates.length) {
      setKeyTooltip(null);
      return;
    }
    const rect = svg.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * 122;
    const svgY = ((clientY - rect.top) / rect.height) * 70;
    const candidates = keyChartSeries.flatMap((series) => series.points.map(([date, price]) => ({
      date,
      x: keyXForDate(date),
      y: keyYForPrice(price),
      entry: {
        name: series.name,
        price,
        unit: series.unit,
        source: series.source,
        color: series.color,
      },
    })));
    const nearest = candidates.reduce((closest, current) => {
      const currentDistance = Math.hypot((current.x - svgX) * 1.15, current.y - svgY);
      const closestDistance = Math.hypot((closest.x - svgX) * 1.15, closest.y - svgY);
      return currentDistance < closestDistance ? current : closest;
    }, candidates[0]);
    if (!nearest) {
      setKeyTooltip(null);
      return;
    }
    setKeyTooltip({ date: nearest.date, x: nearest.x, y: nearest.y, entries: [nearest.entry] });
  };
  const dailyChange = (trendPrices.at(-1)! - trendPrices[0]) / Math.max(trendPrices.length - 1, 1);
  const forecast = trendPrices.at(-1)! + dailyChange;
  const changeRate = ((trendPrices.at(-1)! / trendPrices[0]) - 1) * 100;
  const failedUpdateResults = updateResults.filter((result) => !isSuccessfulUpdate(result));
  const successfulUpdateResults = updateResults.filter(isSuccessfulUpdate);
  const updateSourceSummary = Array.from(updateResults.reduce((counts, result) => {
    counts.set(result.source, (counts.get(result.source) || 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()).map(([source, count]) => `${source} ${count}`).join(" · ");
  const hasOnlyFailedUpdates = updateResults.length > 0 && failedUpdateResults.length === updateResults.length;

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
    setLatestUpdateRows([]);
    setQuery(""); setGroup("全部品类"); setStatus("全部状态");
  }

  async function updatePrices(scope?: UpdateScope) {
    setUpdateMenuOpen(false);
    setExpandedUpdateMenuGroup(null);
    clearToastTimer();
    toastRemaining.current = 6000;
    setToastDismissed(false);
    setToastDetailsExpanded(false);
    setUpdatingPrices(true);
    setImportMessage("");
    setUpdateResults([]);
    setLatestUpdateRows([]);
    let nextItems = items;
    let nextHistory = history;
    let nextKeyComponentResults = keyComponentResults;
    let successCount = 0;
    const results: UpdateResult[] = [];
    const changedRows: PriceExportRow[] = [];
    const enabledEntries = trackingEntries.filter((entry) => entry.enabled && (!scope?.trackingFilter || scope.trackingFilter(entry)));
    const realTrendForceEntries = enabledEntries.filter((entry) => entry.crawler === "trendforce" && entry.mode === "real");
    const realDigiKeyEntries = enabledEntries.filter((entry) => entry.crawler === "digikey" && entry.mode === "real");
    const enabledKeyEntries = keyComponentEntries.filter((entry) => entry.enabled && (!scope?.keyFilter || scope.keyFilter(entry)));
    const cytechKeyEntries = enabledKeyEntries.filter((entry) => entry.crawler === "cytech" && cytechUpdateIds.has(entry.id));
    const lcscKeyEntries = enabledKeyEntries.filter((entry) => entry.crawler === "lcsc" && lcscUpdateIds.has(entry.id));

    let shouldStartToastTimer = false;
    try {
      if (!enabledEntries.length && !cytechKeyEntries.length && !lcscKeyEntries.length) {
        setUpdateMessage(scope ? `${scope.label} 暂无可更新条目` : "暂无可更新条目");
        return;
      }
      const trendForceResults = realTrendForceEntries.length
        ? await fetchTrendForceCrawler(realTrendForceEntries)
        : new Map<string, PriceResult>();
      const digiKeyResults = realDigiKeyEntries.length
        ? await fetchDigiKeyCrawler(realDigiKeyEntries)
        : new Map<string, PriceResult>();
      const cytechResults = await fetchCytechKeyResults(cytechKeyEntries);
      const lcscResults = await fetchLcscKeyResults(lcscKeyEntries);
      for (const entry of enabledEntries) {
        setUpdateMessage(`正在更新 ${entry.name}`);
        const result: PriceResult = entry.crawler === "trendforce" && entry.mode === "real"
          ? trendForceResults.get(entry.id || "") || failedTrendForceResult(entry, "Missing TrendForce API result")
          : entry.crawler === "digikey" && entry.mode === "real"
            ? digiKeyResults.get(entry.id || "") || failedDigiKeyResult(entry, "Missing DigiKey API result")
          : entry.crawler === "plastic" || entry.crawler === "sunsirs_plastic"
            ? await fetchPlasticCrawler(entry)
            : await runCrawler(entry);
        const trackedResult = { ...result, mode: entry.mode };
        results.push(trackedResult);
        setUpdateResults([...results]);
        if (!isSuccessfulUpdate(trackedResult)) setToastDetailsExpanded(true);
        if (process.env.NODE_ENV === "development") {
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
        }
        if (!result.success || result.price === null) continue;

        const target = nextItems.find((item) => item.group === result.category
          && (normalize(item.name) === normalize(result.material) || normalize(item.mpn) === normalize(result.material)));
        if (!target) continue;

        const key = `${target.group}::${target.name}`;
        const previousByDate = new Map((nextHistory[key] ?? []).map(([date, price]) => [date, price]));
        nextItems = nextItems.map((item) => item.id === target.id ? {
          ...item,
          price: String(result.price),
          unit: result.unit,
          source: result.source,
          url: result.sourceUrl || item.url,
          status: "已更新",
          updated: result.updateDate,
        } : item);
        const crawlerHistory = result.history?.length
          ? result.history.map((point) => [point.date, point.price] as [string, number])
          : [[result.updateDate, result.price] as [string, number]];
        crawlerHistory.forEach(([date, price]) => {
          if (previousByDate.get(date) === price) return;
          changedRows.push({
            Date: date,
            Category: target.group,
            Sub_Category: target.group,
            Material_Name: target.name,
            Model_Spec: target.spec,
            Supplier_Brand: target.supplier,
            MPN: target.mpn,
            Unit: result.unit,
            "Latest Price": price,
            "Session Average": price,
            Source: result.source,
            Price_Source: result.source,
            Price_Source_URL: result.sourceUrl || target.url,
          });
        });
        nextHistory = { ...nextHistory, [key]: sortSeries([...(nextHistory[key] ?? []), ...crawlerHistory]) };
        successCount += 1;
      }
      for (const entry of cytechKeyEntries) {
        setUpdateMessage(`正在更新 ${entry.mpn}`);
        const result = cytechResults.get(entry.id) || failedKeyComponentResult(entry, "Missing Cytech API result");
        const trackedResult: UpdateResult = { ...result, mode: "real" };
        results.push(trackedResult);
        setUpdateResults([...results]);
        if (!isSuccessfulUpdate(trackedResult)) setToastDetailsExpanded(true);
        if (process.env.NODE_ENV === "development") {
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
        }
        if (!result.success || result.price === null) continue;
        nextKeyComponentResults = {
          ...nextKeyComponentResults,
          [entry.id]: mergeKeyComponentResult(nextKeyComponentResults[entry.id], result),
        };
        successCount += 1;
      }
      for (const entry of lcscKeyEntries) {
        setUpdateMessage(`正在更新 ${entry.mpn}`);
        const result = lcscResults.get(entry.id) || failedKeyComponentResult(entry, "Missing LCSC API result");
        const trackedResult: UpdateResult = { ...result, mode: "real" };
        results.push(trackedResult);
        setUpdateResults([...results]);
        if (!isSuccessfulUpdate(trackedResult)) setToastDetailsExpanded(true);
        if (process.env.NODE_ENV === "development") {
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
        }
        if (!result.success || result.price === null) continue;
        nextKeyComponentResults = {
          ...nextKeyComponentResults,
          [entry.id]: mergeKeyComponentResult(nextKeyComponentResults[entry.id], result),
        };
        successCount += 1;
      }
      setItems(nextItems);
      setHistory(nextHistory);
      setKeyComponentResults(nextKeyComponentResults);
      setLatestUpdateRows(changedRows);
      setUpdateMessage(`成功更新${successCount}条`);
      shouldStartToastTimer = results.length > 0;
    } finally {
      setUpdatingPrices(false);
      if (shouldStartToastTimer && !toastExpandedRef.current) startToastTimer(6000);
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

  function failedTrendForceResult(entry: TrackingEntry, error: string): PriceResult {
    return {
      success: false,
      category: entry.category,
      material: entry.name,
      materialName: entry.name,
      price: null,
      currency: "USD",
      unit: entry.unit || "USD",
      source: entry.source,
      sourceUrl: entry.url,
      updateDate: dateKey(new Date()),
      crawlTime: new Date().toISOString(),
      mode: "real",
      error,
    };
  }

  function failedDigiKeyResult(entry: TrackingEntry, error: string): PriceResult {
    return {
      success: false,
      category: entry.category,
      material: entry.name,
      materialName: entry.name,
      manufacturer: entry.manufacturer,
      mpn: entry.mpn,
      quantity: entry.quantity,
      price: null,
      currency: "USD",
      unit: entry.unit || "USD/pcs",
      source: entry.source,
      sourceUrl: entry.url,
      updateDate: dateKey(new Date()),
      crawlTime: new Date().toISOString(),
      mode: "real",
      error,
    };
  }

  function failedKeyComponentResult(entry: KeyComponentEntry, error: string): KeyComponentResult {
    const currency = "USD";
    const unit = entry.source === "LCSC" || entry.crawler === "lcsc" ? "pcs" : "USD/pcs";
    return {
      id: entry.id,
      success: false,
      category: entry.category,
      material: entry.mpn,
      materialName: entry.name,
      mpn: entry.mpn,
      price: null,
      currency,
      unit,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      updateDate: dateKey(new Date()),
      crawlTime: new Date().toISOString(),
      mode: "real",
      error,
    };
  }

  async function fetchTrendForceCrawler(entries: TrackingEntry[]) {
    const ids = entries.map((entry) => entry.id).filter((id): id is string => Boolean(id));
    const fallback = new Map(entries.map((entry) => [entry.id || entry.name, failedTrendForceResult(entry, "Missing TrendForce tracking id")]));
    if (!ids.length) return fallback;
    try {
      const response = await fetch("/api/crawler/trendforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload = await response.json() as { success?: boolean; error?: string; results?: Array<PriceResult & { id: string }> };
      if (!response.ok || !payload.success || !Array.isArray(payload.results)) {
        throw new Error(payload.error || `TrendForce API request failed: ${response.status}`);
      }
      payload.results.forEach((result) => fallback.set(result.id, result));
      return fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : "TrendForce API request failed";
      entries.forEach((entry) => fallback.set(entry.id || entry.name, failedTrendForceResult(entry, message)));
      return fallback;
    }
  }

  async function fetchDigiKeyCrawler(entries: TrackingEntry[]) {
    const ids = entries.map((entry) => entry.id).filter((id): id is string => Boolean(id));
    const fallback = new Map(entries.map((entry) => [entry.id || entry.name, failedDigiKeyResult(entry, "Missing DigiKey tracking id")]));
    if (!ids.length) return fallback;
    try {
      const response = await fetch("/api/crawler/digikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const payload = await response.json() as { success?: boolean; error?: string; results?: Array<PriceResult & { id: string }> };
      if (!response.ok || !payload.success || !Array.isArray(payload.results)) {
        throw new Error(payload.error || `DigiKey API request failed: ${response.status}`);
      }
      payload.results.forEach((result) => fallback.set(result.id, result));
      return fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : "DigiKey API request failed";
      entries.forEach((entry) => fallback.set(entry.id || entry.name, failedDigiKeyResult(entry, message)));
      return fallback;
    }
  }

  async function fetchCytechKeyResults(entries: KeyComponentEntry[]) {
    const fallback = new Map(entries.map((entry) => [entry.id, failedKeyComponentResult(entry, "Missing Cytech tracking id")]));
    const ids = entries.map((entry) => entry.id).filter((id) => cytechUpdateIds.has(id));
    if (!ids.length) return fallback;
    try {
      const results = await fetchCytechCrawler(ids);
      results.forEach((result) => fallback.set(result.id, result));
      return fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cytech API request failed";
      entries.forEach((entry) => fallback.set(entry.id, failedKeyComponentResult(entry, message)));
      return fallback;
    }
  }

  async function fetchLcscKeyResults(entries: KeyComponentEntry[]) {
    const fallback = new Map(entries.map((entry) => [entry.id, failedKeyComponentResult(entry, "Missing LCSC tracking id")]));
    const ids = entries.map((entry) => entry.id).filter((id) => lcscUpdateIds.has(id));
    if (!ids.length) return fallback;
    try {
      const results = await fetchLcscCrawler(ids);
      results.forEach((result) => fallback.set(result.id, result));
      return fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : "LCSC API request failed";
      entries.forEach((entry) => fallback.set(entry.id, failedKeyComponentResult(entry, message)));
      return fallback;
    }
  }

  async function handleExportAll() {
    try {
      setToastDismissed(false);
      const { result, rowCount } = await exportAllPriceData(items, history);
      if (result === "canceled") {
        setImportMessage("已取消导出");
      } else {
        setImportMessage(result === "saved" ? `已导出全部数据，共 ${rowCount} 条` : `已下载全部数据，共 ${rowCount} 条`);
      }
    } catch (error) {
      setImportMessage(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
    }
  }

  async function handleExportLatestUpdate() {
    try {
      setToastDismissed(false);
      const { result, rowCount } = await exportLatestUpdateData(latestUpdateRows, updateResults);
      if (result === "canceled") {
        setImportMessage("已取消导出");
      } else {
        setImportMessage(result === "saved" ? `已导出本次更新，共 ${rowCount} 条` : `已下载本次更新，共 ${rowCount} 条`);
      }
    } catch (error) {
      setImportMessage(`导出失败：${error instanceof Error ? error.message : "请稍后重试"}`);
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
          <span className="offline-pill"><span className="pulse" /> 价格追踪模式</span>
          <input ref={fileInput} className="file-input" type="file" accept=".xlsx,.xls" onChange={(event) => importExcel(event.target.files?.[0])} />
          <div className="update-menu" ref={updateMenuRef}>
            <button className="import-button update-menu-trigger" onClick={() => { setExpandedUpdateMenuGroup(null); setUpdateMenuOpen((open) => !open); }} disabled={updatingPrices} type="button" aria-haspopup="menu" aria-expanded={updateMenuOpen}>{updatingPrices ? "更新中…" : "更新价格"} <span>▼</span></button>
            {updateMenuOpen && <div className="update-menu-panel" role="menu" aria-label="更新价格分类">
              <button className="update-menu-all" onClick={() => updatePrices()} type="button" role="menuitem">全部更新</button>
              {updateMenuGroups.map((menuGroup) => <div className={`update-menu-group ${expandedUpdateMenuGroup === menuGroup.title ? "open" : ""}`} key={menuGroup.title}>
                <button className="update-menu-parent" onClick={() => setExpandedUpdateMenuGroup((current) => current === menuGroup.title ? null : menuGroup.title)} type="button" aria-expanded={expandedUpdateMenuGroup === menuGroup.title}>{menuGroup.title}<span>›</span></button>
                <div className="update-menu-children">{menuGroup.options.map((option) => <button key={option.label} onClick={() => updatePrices(option.scope)} type="button" role="menuitem">{option.label}</button>)}</div>
              </div>)}
            </div>}
          </div>
          <button className="ghost-button" onClick={handleExportLatestUpdate}>导出本次更新</button>
          <button className="ghost-button" onClick={handleExportAll}>导出全部</button>
          <button className="ghost-button" onClick={() => fileInput.current?.click()}>↑ 导入 Excel</button>
          <button className="ghost-button" onClick={resetData}>恢复示例数据</button>
        </div>
      </header>

      {!toastDismissed && (importMessage || updateMessage || updateResults.length > 0) && <div className={`import-toast${updateResults.length ? " update-toast" : ""}${hasOnlyFailedUpdates ? " update-toast-failed" : ""}${toastExpanded ? " expanded" : ""}`} role="status" onMouseEnter={pauseToastTimer} onMouseLeave={resumeToastTimer}>
        {updateResults.length === 0 && <button className="toast-close" onClick={closeToast} type="button" aria-label="关闭更新提示">×</button>}
        {updateResults.length > 0 ? <div className="update-results">
          <div className="toast-summary">
            <div>
              {hasOnlyFailedUpdates ? <strong className="toast-summary-title toast-summary-failed">更新失败（<span className="toast-summary-counts"><span className="toast-success-count">0 成功</span><span className="toast-summary-separator">·</span><span className="toast-failure-count">{failedUpdateResults.length} 失败</span></span>）</strong>
                : failedUpdateResults.length > 0 ? <strong className="toast-summary-title">更新完成：<span className="toast-summary-counts"><span className="toast-success-count">{successfulUpdateResults.length} 成功</span><span className="toast-summary-separator">·</span><span className="toast-failure-count">{failedUpdateResults.length} 失败</span></span></strong>
                  : <strong>成功更新 {successfulUpdateResults.length} 条</strong>}
              {updateSourceSummary && <span className="toast-source-summary">{updateSourceSummary}</span>}
            </div>
            <div className="toast-actions">
              <button className="toast-toggle" onClick={toggleToastDetails} type="button" aria-label={toastExpanded ? "收起更新详情" : "展开更新详情"} aria-expanded={toastExpanded}>
                <span aria-hidden="true">⌄</span>
              </button>
              <button className="toast-close" onClick={closeToast} type="button" aria-label="关闭更新提示">×</button>
            </div>
          </div>
          <div className={`toast-details-wrapper${toastExpanded ? " expanded" : ""}`} aria-hidden={!toastExpanded}>
            <div className="toast-details-inner">
              <div className="toast-details">
                {failedUpdateResults.length > 0 && <section className="toast-group toast-group-failed">
                  <h4>失败（{failedUpdateResults.length}）</h4>
                  <div className="toast-result-list">
                    {failedUpdateResults.map((result, index) => <div className="toast-result failure" key={`failed-${result.category}-${result.material}-${index}`}>
                      <strong className="toast-failure-title"><span className="toast-failure-icon" aria-hidden="true">×</span>{updateResultText(result)}</strong>
                      <p className="toast-failure-message">{result.error || "未获取到有效价格"}</p>
                    </div>)}
                  </div>
                </section>}
                {successfulUpdateResults.length > 0 && <section className={`toast-group toast-group-success${failedUpdateResults.length > 0 ? " after-failure" : ""}`}>
                  <h4>成功（{successfulUpdateResults.length}）</h4>
                  <div className="toast-result-list">
                    {successfulUpdateResults.map((result, index) => <div className="toast-result success" key={`success-${result.category}-${result.material}-${index}`}>
                      <strong><span aria-hidden="true">✓</span>{updateResultText(result)}</strong>
                    </div>)}
                  </div>
                </section>}
              </div>
            </div>
          </div>
        </div> : updateMessage || importMessage}
      </div>}

      <div className="shell">
        <section className="hero">
          <div>
            <p className="eyebrow">SEMICONDUCTOR PRICE INTELLIGENCE</p>
            <h1>看见价格变化，<br /><em>判断下一步趋势。</em></h1>
            <p className="hero-copy">持续沉淀历史价格、识别涨跌方向，并为后续采购判断提供短期趋势参考。数据来源、更新状态与参考链接作为趋势分析的基础留痕。</p>
          </div>
          <div className="progress-panel system-navigation">
            <p>SYSTEM NAVIGATION</p>
            <h2>网站导航</h2>
            <nav aria-label="网站核心模块导航">
              <a href="#daily-price-insight"><span>01</span><strong>今日价格洞察<small>Daily Price Insight</small></strong><i>→</i></a>
              <a href="#price-trend"><span>02</span><strong>历史价格趋势<small>Historical Price Trend</small></strong><i>→</i></a>
              <a href="#price-trend" onClick={() => setTrendMode("key")}><span>03</span><strong>重点追踪对象<small>Key Components</small></strong><i>→</i></a>
              <a href="#source-directory"><span>04</span><strong>数据来源<small>Source Directory</small></strong><i>→</i></a>
            </nav>
          </div>
        </section>

        <section className="workflow-section" id="daily-price-insight">
          <div className="section-heading"><div><p className="kicker">DAILY PRICE INSIGHT</p><h2>今日价格洞察</h2></div><p>根据每日价格更新结果自动生成采购信息总结和提醒。</p></div>
          <div className="daily-insight-panel">
            <div className="price-mover-board">
              <div className="price-mover-list">
                <div className="insight-block-head"><span>价格涨跌榜<em>TOP 5 Price Movement</em></span><small>今日变化 {dailyInsights.movers.length} 项 · {dailyInsights.date}</small></div>
                {dailyInsights.movers.length ? dailyInsights.movers.slice(0, showAllMovers ? dailyInsights.movers.length : 5).map((entry) => {
                  const isUp = entry.changeRate > 0;
                  return <div className={`price-mover-row ${isUp ? "up" : "down"}`} key={entry.key}>
                    <span className="mover-direction">{isUp ? "↑" : "↓"}</span>
                    <div className="mover-name"><strong>{entry.name}</strong><small>{entry.group}</small></div>
                    <strong className="mover-rate" title={`计算方式：\n(今日价格 - 昨日价格) / 昨日价格 × 100%\n\n数据：\n昨日价格：${formatTrendPrice(entry.previousPrice || 0)} ${entry.unit}\n今日价格：${formatTrendPrice(entry.price)} ${entry.unit}\n\n结果：${entry.changeRate >= 0 ? "+" : ""}${entry.changeRate.toFixed(2)}%`}>{entry.changeRate >= 0 ? "+" : ""}{entry.changeRate.toFixed(2)}%</strong>
                    <small className="mover-price">{formatTrendPrice(entry.price)} {entry.unit}</small>
                  </div>;
                }) : <div className="price-mover-empty">今日暂无发生价格变化的追踪对象。</div>}
                {dailyInsights.movers.length > 5 && <button className="mover-expand-button" onClick={() => setShowAllMovers((expanded) => !expanded)} type="button">{showAllMovers ? "收起变化 ↑" : "查看全部变化 ↓"}</button>}
              </div>
              <aside className={`risk-alert-card level-${dailyInsights.risk.level}`}>
                <div className="insight-block-head"><span>风险提示</span><small>Risk Alert</small></div>
                <div className="risk-level"><span>风险等级</span><strong>{dailyInsights.risk.level}</strong></div>
                <strong className="risk-name">{dailyInsights.risk.entry.name}</strong>
                <dl>
                  <div><dt>当前价格</dt><dd>{formatTrendPrice(dailyInsights.risk.entry.price)} {dailyInsights.risk.entry.unit}</dd></div>
                  <div><dt>历史偏离</dt><dd title={dailyInsights.risk.averageTooltip}>{dailyInsights.risk.entry.averageGapRate >= 0 ? "+" : ""}{dailyInsights.risk.entry.averageGapRate.toFixed(2)}%</dd></div>
                </dl>
                <p>{dailyInsights.risk.reason}</p>
              </aside>
            </div>
          </div>
        </section>

        <section className="trend-section" id="price-trend">
          <div className="section-heading trend-heading"><div><p className="kicker">PRICE TREND & OUTLOOK</p><h2>历史价格趋势与短期参考</h2></div><div className="trend-status-bar" aria-label="趋势更新状态"><div className="trend-status-card"><span>本期已更新</span><strong>{updated}</strong></div><div className="trend-status-card"><span>最新更新日期</span><strong>{latestDate || "—"}</strong></div></div></div>
          <div className="trend-layout">
            <div className="trend-chart-card">
              <div className="trend-tabs" role="tablist" aria-label="趋势图模式">
                <button className={trendMode === "all" ? "active" : ""} onClick={() => setTrendMode("all")} type="button" role="tab" aria-selected={trendMode === "all"}>
                  全类别趋势<span>NEW</span>
                </button>
                <button className={trendMode === "single" ? "active" : ""} onClick={() => setTrendMode("single")} type="button" role="tab" aria-selected={trendMode === "single"}>单类别趋势</button>
                <button className={trendMode === "key" ? "active" : ""} onClick={() => { setTrendMode("key"); void fetchKeyComponentPrices(); }} type="button" role="tab" aria-selected={trendMode === "key"}>重点追踪对象</button>
              </div>
              {trendMode === "key" ? <>
                <div className="key-trend-heading">
                  <h3>重点追踪对象价格趋势</h3>
                  <p>针对车型 BOM 中关键芯片及存储器件进行独立价格追踪</p>
                </div>
                <div className="trend-toolbar key-trend-toolbar">
                  <div className="key-filter-tabs" aria-label="重点追踪对象分类">
                    {["全部", "NXP", "Memory"].map((name) => <button key={name} className={keyCategory === name ? "active" : ""} onClick={() => { setKeyCategory(name); setKeyTooltip(null); }} type="button">{name}</button>)}
                  </div>
                  <div className="range-buttons" aria-label="选择重点追踪时间范围">
                    {trendRanges.map((range) => <button key={range} className={selectedKeyRange === range ? "active" : ""} onClick={() => { setSelectedKeyRange(range); setKeyTooltip(null); }} type="button">{range}</button>)}
                  </div>
                </div>
                <div className="trend-chart-wrap">
                  {keyChartSeries.length ? <svg
                    className="trend-chart"
                    viewBox="0 0 122 70"
                    role="img"
                    aria-label="重点追踪对象价格趋势"
                    preserveAspectRatio="xMidYMid meet"
                    onMouseMove={(event) => showKeyTooltip(event.currentTarget, event.clientX, event.clientY)}
                    onMouseLeave={() => setKeyTooltip(null)}
                  >
                    {keyYTicks.map((value) => <g key={value}>
                      <line x1={chartLeft} y1={keyYForPrice(value)} x2={chartRight} y2={keyYForPrice(value)} className="grid-line" />
                      <text x={chartLeft - 2} y={keyYForPrice(value)} className="axis-tick y" dominantBaseline="middle">{value.toLocaleString()}</text>
                    </g>)}
                    <line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} className="axis-line" />
                    <line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} className="axis-line" />
                    {keyXTicks.map((date) => <text key={date} x={keyXForDate(date)} y="63" className="axis-tick x" textAnchor="middle">{date}</text>)}
                    {keyTooltip && <line x1={keyTooltip.x} y1={chartTop} x2={keyTooltip.x} y2={chartBottom} className="tooltip-guide" />}
                    {keyChartSeries.map((series) => <g key={series.key}>
                      <polyline points={series.points.map(([date, price]) => `${keyXForDate(date)},${keyYForPrice(price)}`).join(" ")} className="trend-line multi" style={{ stroke: series.color }} />
                      {series.points.map(([date, price], index) => <circle key={`${series.key}-${date}-${index}`} cx={keyXForDate(date)} cy={keyYForPrice(price)} r=".72" className="trend-point filled" style={{ fill: series.color, stroke: series.color }} aria-label={`${series.name} · ${date}：${formatTrendPrice(price)} ${series.unit}`} />)}
                    </g>)}
                  </svg> : <div className="key-chart-empty">{updatingKeyComponents ? "正在读取重点追踪对象价格" : "暂无可绘制的真实价格数据"}</div>}
                  {keyTooltip && <div
                    className={`trend-tooltip ${keyTooltip.x < 32 ? "edge-left" : keyTooltip.x > 104 ? "edge-right" : ""} ${keyTooltip.y < 24 ? "below" : ""}`}
                    style={{
                      left: `${(keyTooltip.x / 122) * 100}%`,
                      top: `${(keyTooltip.y / 70) * 100}%`,
                    }}
                  >
                    <strong>{keyTooltip.date}</strong>
                    {keyTooltip.entries.map((entry) => <div className="trend-tooltip-row" key={`${entry.name}-${entry.price}-${entry.unit}`}>
                      <span><i style={{ background: entry.color }} />{entry.name}</span>
                      <b>{formatTrendPrice(entry.price)} {entry.unit}</b>
                      {entry.source && entry.source !== "—" && <small>{entry.source}</small>}
                    </div>)}
                  </div>}
                </div>
                <div className="axis-labels"><span>{keyTrendDates[0] || "—"}</span><span>{keyTrendDates.at(-1) || "—"}</span></div>
                <div className="trend-legend">
                  {keyChartSeries.map((series) => <span key={series.key}><i style={{ background: series.color }} />{series.name}</span>)}
                  <span className="chart-unit">{keyChartSeries[0]?.unit || "USD/pcs"}</span>
                </div>
                <div className="key-component-table-wrap">
                  <table className="key-component-table">
                    <thead><tr><th>型号(MPN)</th><th>描述</th><th>类别</th><th>数据源</th><th>状态</th><th>最新价格</th><th>价格链接</th><th>操作</th></tr></thead>
                    <tbody>
                      {keyFilteredEntries.map((entry) => {
                        const result = keyComponentResults[entry.id];
                        const hasPrice = Boolean(result?.success && result.price !== null);
                        return <tr key={entry.id}>
                          <td><span className="mpn">{entry.mpn}</span></td>
                          <td>{entry.description}</td>
                          <td>{entry.category}</td>
                          <td>{entry.source}</td>
                          <td><span className={`key-status ${entry.status}`}>{entry.status}</span></td>
                          <td>{hasPrice ? <span className="price">{formatTrendPrice(result.price!)}<small className="unit">{displayUnit(result)}</small></span> : "--"}</td>
                          <td><a href={entry.sourceUrl} target="_blank" rel="noreferrer">查看</a></td>
                          <td>{entry.enabled && entry.crawler === "cytech"
                            ? <button className="text-button" type="button" onClick={() => fetchKeyComponentPrices([entry.id])} disabled={updatingKeyComponents}>刷新</button>
                            : <span className="key-action-muted">--</span>}</td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </> : <>
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
              <div className="trend-chart-wrap">
                <svg
                  className="trend-chart"
                  viewBox="0 0 122 70"
                  role="img"
                  aria-label={trendMode === "all" ? `${trendGroup} 全类别历史价格趋势` : `${trendName} 历史价格趋势`}
                  preserveAspectRatio="xMidYMid meet"
                  onMouseMove={(event) => showTrendTooltip(event.currentTarget, event.clientX, event.clientY)}
                  onMouseLeave={() => setTrendTooltip(null)}
                >
                  {yTicks.map((value) => <g key={value}>
                    <line x1={chartLeft} y1={yForPrice(value)} x2={chartRight} y2={yForPrice(value)} className="grid-line" />
                    <text x={chartLeft - 2} y={yForPrice(value)} className="axis-tick y" dominantBaseline="middle">{value.toLocaleString()}</text>
                  </g>)}
                  <line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} className="axis-line" />
                  <line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} className="axis-line" />
                  {xTicks.map((date) => <text key={date} x={xForTick(date)} y="63" className="axis-tick x" textAnchor="middle">{date}</text>)}
                  {trendTooltip && <line x1={trendTooltip.x} y1={chartTop} x2={trendTooltip.x} y2={chartBottom} className="tooltip-guide" />}
                  {trendMode === "all" ? allTrendSeries.map((series) => <g key={series.key}>
                    <polyline points={series.points.map(([date, price]) => `${xForDate(date)},${yForAllPrice(price)}`).join(" ")} className="trend-line multi" style={{ stroke: series.color }} />
                    {series.points.map(([date, price], index) => <circle key={`${series.key}-${date}-${index}`} cx={xForDate(date)} cy={yForAllPrice(price)} r=".72" className="trend-point filled" style={{ fill: series.color, stroke: series.color }} aria-label={`${series.name} · ${date}：${formatTrendPrice(price)} ${series.unit}`} />)}
                  </g>) : <>
                    <polyline points={chartPoints} className="trend-line" />
                    {trend.map((point, index) => <circle key={`${point[0]}-${index}`} cx={xForPoint(index)} cy={yForPrice(point[1])} r=".72" className="trend-point filled" aria-label={`${point[0]}：${formatTrendPrice(point[1])} ${chartUnit}`} />)}
                  </>}
                </svg>
                {trendTooltip && <div
                  className={`trend-tooltip ${trendTooltip.x < 32 ? "edge-left" : trendTooltip.x > 104 ? "edge-right" : ""} ${trendTooltip.y < 24 ? "below" : ""}`}
                  style={{
                    left: `${(trendTooltip.x / 122) * 100}%`,
                    top: `${(trendTooltip.y / 70) * 100}%`,
                  }}
                >
                  <strong>{trendTooltip.date}</strong>
                  {trendTooltip.entries.map((entry) => <div className="trend-tooltip-row" key={`${entry.name}-${entry.price}-${entry.unit}`}>
                    <span><i style={{ background: entry.color }} />{entry.name}</span>
                    <b>{formatTrendPrice(entry.price)} {entry.unit}</b>
                    {entry.source && entry.source !== "—" && <small>{entry.source}</small>}
                  </div>)}
                </div>}
              </div>
              <div className="axis-labels"><span>{trendMode === "all" ? allTrendDates[0] || "—" : trend[0][0]}</span><span>{trendMode === "all" ? allTrendDates.at(-1) || "—" : trend.at(-1)![0]}</span></div>
              <div className="trend-legend">
                {trendMode === "all"
                  ? allTrendSeries.map((series) => <span key={series.key}><i style={{ background: series.color }} />{series.name}</span>)
                  : <span><i />{trendName}</span>}
                <span className="chart-unit">{chartUnit}</span>
              </div>
              </>}
            </div>
            <aside className="trend-insight">
              <span className={`direction ${changeRate >= 0 ? "up" : "down"}`}>{changeRate >= 0 ? "↗ 上行" : "↘ 下行"}</span>
              <p>样本期变化</p><strong>{changeRate >= 0 ? "+" : ""}{changeRate.toFixed(2)}%</strong>
              <dl><div><dt>最新价格</dt><dd>{trendPrices.at(-1)!.toLocaleString()}</dd></div><div><dt>短期参考值</dt><dd>{forecast.toFixed(2)}</dd></div><div><dt>历史样本</dt><dd>{trend.length} 天</dd></div></dl>
              <small>{trend.length > 1 ? "预测值为简单线性外推；历史继续积累后可升级为移动平均或时间序列模型。" : "当前只有一个历史日期，先展示价格点；导入下一期数据后会自动形成趋势线。"}</small>
            </aside>
          </div>
          <div className="coverage-note"><strong>趋势数据状态</strong><span>实线为表格中的真实历史价格；右侧预测值按样本期平均日变化外推，仅用于方向参考。</span><span>所有品类均保留 Excel 中的全部日期，多期数据绘制趋势线。</span></div>
        </section>

        <section className="tracker-section" id="tracking-matrix">
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
                <td>{item.isKeyComponent
                  ? <a href={item.url} target="_blank" rel="noreferrer">{item.source} ↗</a>
                  : item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.source} ↗</a> : <button className="text-button" onClick={() => openEditor(item)}>＋ 添加参考链接</button>}</td>
                <td>{item.isKeyComponent
                  ? <span className="key-action-muted">--</span>
                  : <div className="row-actions"><button onClick={() => markUpdated(item.id)} title="标记为今日已更新">✓</button><button onClick={() => openEditor(item)} title="编辑来源">✎</button></div>}</td>
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

        <section className="source-section" id="source-directory">
          <div className="section-heading"><div><p className="kicker">SOURCE DIRECTORY</p><h2>可系统追踪品类价格来源</h2></div><p>按数据来源体系整理可自动追踪的核心品类，作为价格平台的数据来源说明。</p></div>
          <div className="source-grid">
            {categorySources.map((source) => <div className="source-card" key={`${source.group}-${source.label}`}>
              <span>{source.group}</span>
              <strong>{source.label}</strong>
              <small>数据来源</small>
              <div className="source-list">{source.sources.map((item) => <a className={`source-chip source-${item.name.replace(/[^A-Za-z]/g, "").toLowerCase()}`} href={item.url} target="_blank" rel="noreferrer" key={item.name}>{item.name}</a>)}</div>
            </div>)}
          </div>
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
