import * as XLSX from "xlsx";
import type { Item } from "../app/types";
import type { PriceResult } from "./crawlers";

export type PriceExportRow = {
  Date: string;
  Category: string;
  Sub_Category: string;
  Material_Name: string;
  Model_Spec: string;
  Supplier_Brand: string;
  MPN: string;
  Unit: string;
  "Latest Price": number;
  "Session Average": number;
  Source: string;
  Price_Source: string;
  Price_Source_URL: string;
};

type UpdateLogRow = {
  Timestamp: string;
  Material: string;
  Source: string;
  Success: boolean;
  Price: number | null;
  Unit: string;
  UpdateDate: string;
  Error: string;
};

type SavePickerWritable = {
  write: (data: Blob) => Promise<void> | void;
  close: () => Promise<void> | void;
};

type SavePickerHandle = {
  createWritable: () => Promise<SavePickerWritable>;
};

type SavePickerOptions = {
  suggestedName: string;
  types: {
    description: string;
    accept: Record<string, string[]>;
  }[];
};

type ExportSaveResult = "saved" | "downloaded" | "canceled";

declare global {
  interface Window {
    showSaveFilePicker?: (options: SavePickerOptions) => Promise<SavePickerHandle>;
  }
}

const totalHeaders = ["Date", "Category", "Sub_Category", "Material_Name", "Model_Spec", "Supplier_Brand", "MPN", "Unit", "Latest Price", "Session Average", "Source", "Price_Source", "Price_Source_URL"];
const priceDatabaseHeaders = ["Date", "Category", "Sub_Category", "Material_Name", "Model_Spec", "Supplier_Brand", "MPN", "Price", "Unit", "Source", "Price_Source", "Price_Source_URL"];
const marketHeaders = ["Date", "Category", "Item", "Brand", "MPN", "Unit", "Session Average", "Source"];
const plasticHeaders = ["Date", "Commodity", "Price", "Unit", "Source"];
const logHeaders = ["Timestamp", "Material", "Source", "Success", "Price", "Unit", "UpdateDate", "Error"];
const excelMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function timestampForFile() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}`,
    timestamp: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  };
}

function numericPrice(value: unknown) {
  const price = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(price) ? price : null;
}

function itemKey(item: Item) {
  return `${item.group}::${item.name}`;
}

function dedupeKey(row: PriceExportRow) {
  const identity = row.MPN && row.MPN !== "—" ? row.MPN : row.Material_Name;
  return `${row.Category}::${identity}::${row.Date}`;
}

function sortRows<T extends { Category: string; Material_Name: string; Date: string }>(rows: T[]) {
  return rows.sort((a, b) => a.Category.localeCompare(b.Category) || a.Material_Name.localeCompare(b.Material_Name) || a.Date.localeCompare(b.Date));
}

function dedupeRows(rows: PriceExportRow[]) {
  const byKey = new Map<string, PriceExportRow>();
  rows.forEach((row) => byKey.set(dedupeKey(row), row));
  return sortRows(Array.from(byKey.values()));
}

function rowsFromItems(items: Item[], history: Record<string, [string, number][]>) {
  const rows: PriceExportRow[] = [];
  items.forEach((item) => {
    const series = history[itemKey(item)] ?? [];
    const fallbackPrice = numericPrice(item.price);
    const points = series.length ? series : fallbackPrice !== null && item.updated ? [[item.updated, fallbackPrice] as [string, number]] : [];
    points.forEach(([date, price]) => {
      if (!date || !Number.isFinite(price)) return;
      rows.push({
        Date: date,
        Category: item.group,
        Sub_Category: item.group,
        Material_Name: item.name,
        Model_Spec: item.spec,
        Supplier_Brand: item.supplier,
        MPN: item.mpn,
        Unit: item.unit,
        "Latest Price": price,
        "Session Average": price,
        Source: item.source,
        Price_Source: item.source,
        Price_Source_URL: item.url,
      });
    });
  });
  return dedupeRows(rows);
}

function toMarketRows(rows: PriceExportRow[]) {
  return rows.filter((row) => ["DDR内存", "LCD屏幕", "电池", "NAND Flash"].includes(row.Category)).map((row) => ({
    Date: row.Date,
    Category: row.Category,
    Item: row.Material_Name,
    Brand: row.Supplier_Brand,
    MPN: row.MPN,
    Unit: row.Unit,
    "Session Average": row["Session Average"],
    Source: row.Source,
  }));
}

function toPlasticRows(rows: PriceExportRow[]) {
  return rows.filter((row) => row.Category === "塑料件").map((row) => ({
    Date: row.Date,
    Commodity: row.Material_Name,
    Price: row["Latest Price"],
    Unit: row.Unit,
    Source: row.Source,
  }));
}

function toPriceDatabaseRows(rows: PriceExportRow[]) {
  return rows.map((row) => ({
    Date: row.Date,
    Category: row.Category,
    Sub_Category: row.Sub_Category,
    Material_Name: row.Material_Name,
    Model_Spec: row.Model_Spec,
    Supplier_Brand: row.Supplier_Brand,
    MPN: row.MPN === "—" ? "" : row.MPN,
    Price: row["Latest Price"],
    Unit: row.Unit,
    Source: row.Source,
    Price_Source: row.Price_Source,
    Price_Source_URL: row.Price_Source_URL,
  })).sort((a, b) => a.Category.localeCompare(b.Category)
    || a.Material_Name.localeCompare(b.Material_Name)
    || a.MPN.localeCompare(b.MPN)
    || a.Date.localeCompare(b.Date));
}

function applySheetLayout(sheet: XLSX.WorkSheet, headers: string[], rowCount: number) {
  sheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(rowCount + 1, 1)}` };
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  sheet["!cols"] = headers.map((header) => ({ wch: Math.max(12, Math.min(30, header.length + 6)) }));
}

function appendJsonSheet(workbook: XLSX.WorkBook, name: string, rows: Record<string, unknown>[], headers: string[]) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  applySheetLayout(sheet, headers, rows.length);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function buildWorkbook(totalRows: PriceExportRow[], updateLogs: UpdateLogRow[] = [], includePriceDatabase = false) {
  const workbook = XLSX.utils.book_new();
  appendJsonSheet(workbook, "总表", totalRows, totalHeaders);
  if (includePriceDatabase) appendJsonSheet(workbook, "Price_Database", toPriceDatabaseRows(totalRows), priceDatabaseHeaders);
  appendJsonSheet(workbook, "DDR-BATTERY-LCD", toMarketRows(totalRows), marketHeaders);
  appendJsonSheet(workbook, "塑料件", toPlasticRows(totalRows), plasticHeaders);
  if (updateLogs.length) appendJsonSheet(workbook, "更新日志", updateLogs, logHeaders);
  return workbook;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

async function saveWorkbookWithPicker(workbook: XLSX.WorkBook, suggestedName: string): Promise<ExportSaveResult> {
  if (typeof window === "undefined") return "canceled";
  const picker = window.showSaveFilePicker;
  if (!picker) {
    const confirmed = window.confirm("当前浏览器不支持选择保存路径，文件将保存到浏览器默认下载目录。是否继续？");
    if (!confirmed) return "canceled";
    XLSX.writeFile(workbook, suggestedName);
    return "downloaded";
  }

  try {
    const data = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    const blob = new Blob([data], { type: excelMime });
    const fileHandle = await picker({
      suggestedName,
      types: [{
        description: "Excel 工作簿",
        accept: { [excelMime]: [".xlsx"] },
      }],
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return "saved";
  } catch (error) {
    if (isAbortError(error)) return "canceled";
    throw error;
  }
}

export function buildAllPriceWorkbook(items: Item[], history: Record<string, [string, number][]>) {
  const totalRows = rowsFromItems(items, history);
  console.log("[Export Excel] Price_Database", { rows: totalRows.length });
  return { workbook: buildWorkbook(totalRows, [], true), rowCount: totalRows.length };
}

export function buildLatestUpdateWorkbook(updateRows: PriceExportRow[], updateResults: PriceResult[]) {
  const { timestamp } = timestampForFile();
  const logs = updateResults.map((result) => ({
    Timestamp: timestamp,
    Material: result.material,
    Source: result.source,
    Success: result.success,
    Price: result.price,
    Unit: result.unit,
    UpdateDate: result.updateDate,
    Error: result.error || "",
  }));
  return { workbook: buildWorkbook(dedupeRows(updateRows), logs), rowCount: updateRows.length };
}

export async function exportAllPriceData(items: Item[], history: Record<string, [string, number][]>) {
  const { date, time } = timestampForFile();
  const { workbook, rowCount } = buildAllPriceWorkbook(items, history);
  const result = await saveWorkbookWithPicker(workbook, `半导体价格追踪_全部数据_${date}_${time}.xlsx`);
  return { result, rowCount };
}

export async function exportLatestUpdateData(updateRows: PriceExportRow[], updateResults: PriceResult[]) {
  const { date, time } = timestampForFile();
  const { workbook, rowCount } = buildLatestUpdateWorkbook(updateRows, updateResults);
  const result = await saveWorkbookWithPicker(workbook, `半导体价格追踪_本次更新_${date}_${time}.xlsx`);
  return { result, rowCount };
}
