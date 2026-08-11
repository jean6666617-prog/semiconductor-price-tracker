/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];

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
      if (!response.ok) throw new Error(path + " refresh failed with HTTP " + response.status);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      console.error("cron refresh completed with failures:", failures.map((failure) => String(failure.reason)));
    } else {
      console.log("cron refresh completed successfully:", refreshPaths.length);
    }
  },

  async fetch() {
    return new Response("Price cache cron worker", { status: 200 });
  },
};

export default priceCacheCronWorker;
