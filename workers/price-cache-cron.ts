/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];
const nxpIds = ["key-nxp-mcimx515djm8c", "key-nxp-tja1042t-3", "key-nxp-tja1055t-3", "key-nxp-mcimx9352cvvxmac", "key-nxp-pca9451ahny"];

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

const priceCacheCronWorker = {
  async scheduled(_controller: ScheduledController, env: CronEnv) {
    const secret = env.CRON_SECRET?.trim();
    const automaticResults: Array<Record<string, unknown>> = [];
    const results = await Promise.allSettled(refreshPaths.map(async (path) => {
      const requestUrl = env.APP_BASE_URL + path + "?refresh=" + Date.now();
      const requestHeaders = { accept: "application/json", "x-cron-secret": secret || "" };
      let response: Response;
      try {
        response = await fetch(requestUrl, {
          headers: requestHeaders,
        });
      } catch (error) {
        console.error("crawler refresh fetch failed:", { path, error: String(error) });
        throw error;
      }
      const body = await response.text();
      try {
        const payload = JSON.parse(body) as { results?: unknown } | unknown[];
        const entries = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.results) ? payload.results : [];
        entries.forEach((entry) => { if (entry && typeof entry === "object") automaticResults.push(entry as Record<string, unknown>); });
      } catch {}
      if (!response.ok) throw new Error(path + " refresh failed with HTTP " + response.status + ": " + body.slice(0, 300));
      if (!hasSuccessfulPayload(path, body)) throw new Error(path + " refresh returned no successful data: " + body.slice(0, 300));
    }));
    const distributorResponse = await fetch(env.APP_BASE_URL + "/api/crawler/distributor", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "x-cron-secret": secret || "" }, body: JSON.stringify({ ids: nxpIds }) });
    const distributorBody = await distributorResponse.text();
    if (!distributorResponse.ok) throw new Error("/api/crawler/distributor failed with HTTP " + distributorResponse.status + ": " + distributorBody.slice(0, 300));
    try { const payload = JSON.parse(distributorBody) as { results?: unknown }; if (Array.isArray(payload.results)) payload.results.forEach((entry) => { if (entry && typeof entry === "object") automaticResults.push(entry as Record<string, unknown>); }); } catch { throw new Error("/api/crawler/distributor returned non-JSON response"); }
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
