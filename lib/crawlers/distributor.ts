import type { PriceResult, TrackingEntry } from "./index";
import { fetchDigiKeyPrice, hasDigiKeyCredentials, missingCredentialsMessage } from "./digikey";
import { fetchLcscPrice } from "./lcsc";
import { fetchMouserPrice, hasMouserCredentials, missingMouserCredentialsMessage } from "./mouser";
import { fetchCytechPrice, type KeyComponentEntry } from "./cytech";
type DistributorResult = PriceResult & { id: string };
function todayKey() { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("/", "-"); }
function digiKeyEntry(entry: KeyComponentEntry): TrackingEntry { return { id: entry.id, category: entry.category, name: entry.name, source: "DigiKey", url: "https://www.digikey.com/en/products/result?keywords=" + encodeURIComponent(entry.mpn), crawler: "digikey", mode: "real", unit: "USD/pcs", manufacturer: entry.manufacturer, mpn: entry.mpn, currency: "USD", quantity: 1, enabled: entry.enabled }; }
function failure(entry: KeyComponentEntry, error: string, source = "Distributor aggregation"): DistributorResult { return { id: entry.id, success: false, category: entry.category, material: entry.mpn, materialName: entry.name, mpn: entry.mpn, price: null, currency: "USD", unit: "USD/pcs", source, sourceUrl: entry.officialUrl || entry.sourceUrl, updateDate: todayKey(), crawlTime: new Date().toISOString(), mode: "real", error, status: "source_unavailable" }; }
function isCloudflareError(error?: string) { return /cloudflare|cf-chl|just a moment|challenge|enable javascript/i.test(error || ""); }
export async function fetchDistributorPrice(entry: KeyComponentEntry): Promise<DistributorResult> {
  if (!entry.enabled) return failure(entry, "Key component crawler is disabled"); const notices: string[] = []; const digiKeyMissing = !hasDigiKeyCredentials();
  if (!digiKeyMissing) { const result = await fetchDigiKeyPrice(digiKeyEntry(entry)); if (result.success && result.price !== null) return { ...result, id: entry.id, source: "DigiKey", status: "success" }; if (result.error && !isCloudflareError(result.error)) notices.push("DigiKey：" + result.error); } else notices.push(missingCredentialsMessage);
  if (hasMouserCredentials()) { const result = await fetchMouserPrice(entry); if (result.success && result.price !== null) return result; if (result.error) notices.push("Mouser：" + result.error); } else notices.push(missingMouserCredentialsMessage);
  if (entry.lcscUrl || entry.sourceUrl.includes("lcsc.com/product-detail")) { const lcscEntry = entry.lcscUrl ? { ...entry, sourceUrl: entry.lcscUrl, crawler: "lcsc" } : entry; const result = await fetchLcscPrice(lcscEntry); if (result.success && result.price !== null) return { ...result, id: entry.id, status: "success" }; if (result.error) notices.push("LCSC：" + result.error); } else notices.push("LCSC：未配置可验证的产品详情页");
  const cytechResult = await fetchCytechPrice(entry); if (cytechResult.success && cytechResult.price !== null) return { ...cytechResult, id: entry.id, status: "success" }; const fallbackError = isCloudflareError(cytechResult.error) ? "备用来源暂不可用：供应商页面验证限制" : "未获取到公开的单件价格"; const result = failure(entry, fallbackError + (notices.length ? "；" + notices.join("；") : "")); if (digiKeyMissing) result.status = "configuration_required"; return result;
}
