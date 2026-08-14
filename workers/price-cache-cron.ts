/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];
const nxpIds = ["key-nxp-mcimx515djm8c", "key-nxp-tja1042t-3", "key-nxp-tja1055t-3", "key-nxp-mcimx9352cvvxmac", "key-nxp-pca9451ahny"];
const maxRefreshAttempts = 3;

function hasSuccessfulPayload(path: string, body: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(path + " returned non-JSON response");
  }

  if (!payload || typeof payload !== "object") return true;
  if ("success" in payload && (payload as { success?: unknown }).success === false) return false;

  const results = (payload as { results?: unknown }).results;
  if (Array.isArray(results)) return results.some((result) => Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === true));
  if (Array.isArray(payload)) return payload.some((result) => Boolean(result && typeof result === "object" && (result as { success?: unknown }).success === true));
  return true;
}

function hasFailedEntries(body: string) {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return true; }
  const entries = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [];
  return entries.some((entry) => entry && typeof entry === "object" && (entry as { success?: unknown }).success === false);
}

async function pauseBeforeRetry(attempt: number) {
  await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
}

async function fetchCrawlerWithRetry(path: string, headers: HeadersInit) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRefreshAttempts; attempt += 1) {
    try {
      const requestUrl = `${path}?refresh=${Date.now()}`;
      const response = await fetch(requestUrl, { headers });
      const body = await response.text();
      if (!response.ok) throw new Error(`${path} refresh failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
      if (!hasSuccessfulPayload(path, body) || hasFailedEntries(body)) {
        throw new Error(`${path} refresh returned incomplete data: ${body.slice(0, 300)}`);
      }
      console.log("crawler refresh succeeded", { path, attempt, maxAttempts: maxRefreshAttempts });
      return body;
    } catch (error) {
      lastError = error;
      console.warn("crawler refresh attempt failed", { path, attempt, maxAttempts: maxRefreshAttempts, error: String(error) });
      if (attempt < maxRefreshAttempts) await pauseBeforeRetry(attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${path} refresh failed after ${maxRefreshAttempts} attempts`);
}

const priceCacheCronWorker = {
  async scheduled(_controller: ScheduledController, env: CronEnv) {
    const secret = env.CRON_SECRET?.trim();
    const automaticResults: Array<Record<string, unknown>> = [];
    const requestHeaders = { accept: "application/json", "x-cron-secret": secret || "" };
    const results = await Promise.allSettled(refreshPaths.map(async (path) => {
      const body = await fetchCrawlerWithRetry(env.APP_BASE_URL + path, requestHeaders);
      try {
        const payload = JSON.parse(body) as { results?: unknown } | unknown[];
        const entries = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.results) ? payload.results : [];
        entries.forEach((entry) => { if (entry && typeof entry === "object") automaticResults.push(entry as Record<string, unknown>); });
      } catch {}
    }));
    const distributorHeaders = { accept: "application/json", "content-type": "application/json", "x-cron-secret": secret || "" };
    let distributorBody = "";
    let distributorError: unknown;
    for (let attempt = 1; attempt <= maxRefreshAttempts; attempt += 1) {
      try {
        const distributorResponse = await fetch(env.APP_BASE_URL + "/api/crawler/distributor", { method: "POST", headers: distributorHeaders, body: JSON.stringify({ ids: nxpIds }) });
        distributorBody = await distributorResponse.text();
        if (!distributorResponse.ok) throw new Error("/api/crawler/distributor failed with HTTP " + distributorResponse.status + ": " + distributorBody.slice(0, 300));
        if (hasFailedEntries(distributorBody)) throw new Error("/api/crawler/distributor returned incomplete data: " + distributorBody.slice(0, 300));
        const payload = JSON.parse(distributorBody) as { results?: unknown };
        if (!Array.isArray(payload.results)) throw new Error("/api/crawler/distributor returned invalid results");
        payload.results.forEach((entry) => { if (entry && typeof entry === "object") automaticResults.push(entry as Record<string, unknown>); });
        console.log("distributor refresh succeeded", { attempt, maxAttempts: maxRefreshAttempts });
        distributorError = undefined;
        break;
      } catch (error) {
        distributorError = error;
        console.warn("distributor refresh attempt failed", { attempt, maxAttempts: maxRefreshAttempts, error: String(error) });
        if (attempt < maxRefreshAttempts) await pauseBeforeRetry(attempt);
      }
    }
    if (distributorError) throw distributorError;
    const statusResponse = await fetch(env.APP_BASE_URL + "/api/crawler/auto-status", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-cron-secret": secret || "" }, body: JSON.stringify({ runAt: new Date().toISOString(), results: automaticResults }) });
    if (!statusResponse.ok) throw new Error("/api/crawler/auto-status failed with HTTP " + statusResponse.status);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      const messages = failures.map((failure) => String(failure.reason));
      console.error("cron refresh completed with failures:", messages);
      throw new Error(messages.join("; "));
    } else {
      console.log("cron refresh completed successfully:", refreshPaths.length);
    }
  },

  async fetch() {
    return new Response("Price cache cron worker", { status: 200 });
  },
};

export default priceCacheCronWorker;
