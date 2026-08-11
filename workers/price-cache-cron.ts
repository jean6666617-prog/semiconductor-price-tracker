/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];

const priceCacheCronWorker = {
  async scheduled(_controller: ScheduledController, env: CronEnv) {
    console.log("cron scheduled start");
    const secret = env.CRON_SECRET?.trim();
    const results = await Promise.allSettled(refreshPaths.map(async (path) => {
      console.log("cron refresh start:", {
        path,
        secretConfigured: Boolean(secret),
        secretLength: secret?.length,
      });
      let response: Response;
      try {
        response = await fetch(env.APP_BASE_URL + path + "?refresh=" + Date.now(), {
          headers: { accept: "application/json", "x-cron-secret": secret || "" },
        });
      } catch (error) {
        console.error("crawler refresh fetch failed:", { path, error: String(error) });
        throw error;
      }
      console.log("cron refresh result:", {
        path,
        status: response.status,
        ok: response.ok,
        cache: response.headers.get("x-crawler-cache"),
        contentType: response.headers.get("content-type"),
      });
      if (!response.ok) throw new Error(path + " refresh failed with HTTP " + response.status);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const successCount = results.length - failures.length;
    const failureCount = failures.length;
    console.log("crawler refresh finished", { successCount, failureCount });
    if (failures.length) {
      console.error("cron refresh completed with failures:", failures.map((failure) => String(failure.reason)));
    } else {
      console.log("cron refresh completed successfully:", refreshPaths.length);
    }
    console.log("scheduled handler finished");
  },

  async fetch() {
    return new Response("Price cache cron worker", { status: 200 });
  },
};

export default priceCacheCronWorker;
