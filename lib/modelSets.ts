import trackingConfig from "../config/tracking.json";
import keyComponentsConfig from "../config/key-components.json";
import { seedItems } from "../app/data";
import { workbookItems } from "../app/workbook-data";
import lcscDiscovered from "../config/lcsc-discovered.json";

export type CatalogModel = {
  category: string;
  name: string;
  mpn?: string;
  spec?: string;
  manufacturer?: string;
  source?: string;
  sourceUrl?: string;
  id: string;
  currentPrice?: number | null;
  currency?: string;
  unit?: string;
  currentPriceDate?: string;
  priceOrigin?: "static_seed_price" | "unknown_origin";
  originalRequestedMpn?: string;
  trackedMpn?: string;
};

const emptyValues = new Set(["", "—", "--", "-"]);
const normalized = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const usable = (value: unknown) => !emptyValues.has(String(value ?? "").trim());

export function modelId(model: Pick<CatalogModel, "category" | "name" | "mpn" | "spec">) {
  const mpn = usable(model.mpn) ? normalized(model.mpn) : "";
  const identity = mpn || `${normalized(model.name)}|${normalized(model.spec)}`;
  return `${normalized(model.category)}::${identity}`;
}

function configuredModel(entry: Record<string, unknown>): CatalogModel {
  return {
    category: String(entry.category || ""),
    name: String(entry.name || entry.mpn || ""),
    mpn: String(entry.mpn || ""),
    spec: String(entry.description || ""),
    manufacturer: String(entry.manufacturer || ""),
    source: String(entry.source || ""),
    sourceUrl: String(entry.url || entry.sourceUrl || ""),
    id: String(entry.id || modelId({ category: String(entry.category || ""), name: String(entry.name || entry.mpn || ""), mpn: String(entry.mpn || ""), spec: String(entry.description || "") })),
  };
}

export const core41Models = [
  ...(trackingConfig as Record<string, unknown>[]).map(configuredModel),
  ...(keyComponentsConfig as Record<string, unknown>[]).filter((entry) => entry.enabled).map(configuredModel),
];

export const categoryStatusModels: CatalogModel[] = [...seedItems, ...workbookItems].map((item) => ({
  category: item.group,
  name: item.name,
  mpn: item.mpn,
  spec: item.spec,
  manufacturer: item.supplier,
  source: item.source,
  sourceUrl: item.url,
  id: modelId({ category: item.group, name: item.name, mpn: item.mpn, spec: item.spec }),
  currentPrice: item.price && Number.isFinite(Number(item.price)) ? Number(item.price) : null,
  currency: item.unit,
  unit: item.unit,
  currentPriceDate: item.updated,
  priceOrigin: item.price && Number.isFinite(Number(item.price)) ? "static_seed_price" : "unknown_origin",
}));

function matchesCore(model: CatalogModel, core: CatalogModel) {
  const modelMpn = usable(model.mpn) ? normalized(model.mpn) : "";
  const coreMpn = usable(core.mpn) ? normalized(core.mpn) : "";
  if (modelMpn && coreMpn) return modelMpn === coreMpn;
  return normalized(model.category) === normalized(core.category)
    && normalized(model.name) === normalized(core.name);
}

export const extendedCategoryModels = categoryStatusModels.filter((model) => !core41Models.some((core) => matchesCore(model, core)));

// Browser-discovered LCSC mappings are intentionally applied only to extended
// models; core41/category seed pricing keeps its existing source and cadence.
const lcscByMpn = new Map((lcscDiscovered as Array<{ manufacturerPartNumber?: string; originalRequestedMpn?: string; trackedMpn?: string; lcscProductUrl?: string; lcscManufacturer?: string }>).map((item) => [normalized(item.originalRequestedMpn || item.manufacturerPartNumber), item]));
for (const model of extendedCategoryModels) {
  const discovered = lcscByMpn.get(normalized(model.mpn));
  if (discovered?.lcscProductUrl) {
    model.source = "LCSC";
    model.sourceUrl = discovered.lcscProductUrl;
    if (discovered.trackedMpn) model.mpn = discovered.trackedMpn;
    if (discovered.trackedMpn) {
      model.originalRequestedMpn = discovered.originalRequestedMpn || model.mpn;
      model.trackedMpn = discovered.trackedMpn;
      // The LCSC listing is the canonical display/quote model for these
      // user-confirmed mappings; retain the original request separately.
      model.name = discovered.trackedMpn;
    }
    if (discovered.lcscManufacturer) model.manufacturer = discovered.lcscManufacturer;
  }
}

/** Models without a verified LCSC detail URL are discovery candidates, not failures. */
export const pendingDiscoveryModels = extendedCategoryModels.filter((model) => !/lcsc\.com/i.test(model.sourceUrl || ""));

/** Existing plastic/DDR entries retain their mature source and are never sent to LCSC discovery. */
export const protectedModels = pendingDiscoveryModels.filter((model) => {
  const rawCategory = String(model.category || "").trim().toUpperCase();
  const category = normalized(rawCategory);
  return rawCategory.includes("塑料") || category.includes("DDR") || category === "MEMORY";
});

/** Standard electronic parts for which a public LCSC product page is an appropriate source. */
export const lcscDiscoveryCandidates = pendingDiscoveryModels.filter((model) => {
  if (protectedModels.includes(model)) return false;
  const category = normalized(model.category);
  return category.includes("MCU") || category.includes("SOC") || category.includes("MOS") || category.includes("SGT");
});

/** PCB, LCD, battery and other non-component price series need their existing category source. */
export const nonLcscCandidates = pendingDiscoveryModels.filter((model) => !protectedModels.includes(model) && !lcscDiscoveryCandidates.includes(model));

/** Verified LCSC detail-page mappings eligible for unattended daily updates. */
export const activeLcscAutoUpdateModels = extendedCategoryModels.filter((model) =>
  lcscByMpn.has(normalized(model.originalRequestedMpn || model.mpn))
  && /lcsc\.com\/product-detail\//i.test(model.sourceUrl || "")
  && usable(model.trackedMpn || model.mpn)
  && !protectedModels.includes(model)
  && !nonLcscCandidates.includes(model)
);

export function modelSetSummary() {
  const categories = new Set(extendedCategoryModels.map((model) => model.category));
  return {
    coreCount: core41Models.length,
    categoryStatusCount: categoryStatusModels.length,
    overlapCount: categoryStatusModels.length - extendedCategoryModels.length,
    extendedCount: extendedCategoryModels.length,
    extendedCategoryCount: categories.size,
    missingSourceCount: extendedCategoryModels.filter((model) => !model.sourceUrl).length,
    pendingDiscoveryCount: pendingDiscoveryModels.length,
    protectedCount: protectedModels.length,
    lcscDiscoveryCandidateCount: lcscDiscoveryCandidates.length,
    nonLcscCandidateCount: nonLcscCandidates.length,
    activeLcscAutoUpdateCount: activeLcscAutoUpdateModels.length,
  };
}
