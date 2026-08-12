/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];

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
      if (!response.ok) throw new Error(path + " refresh failed with HTTP " + response.status + ": " + body.slice(0, 300));
      if (!hasSuccessfulPayload(path, body)) throw new Error(path + " refresh returned no successful data: " + body.slice(0, 300));
    }));
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
