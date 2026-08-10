/// <reference types="@cloudflare/workers-types" />
interface CronEnv {
  APP_BASE_URL: string;
  CRON_SECRET: string;
}

const refreshPaths = ["/api/crawler/ddr", "/api/crawler/plastic", "/api/crawler/trendforce", "/api/crawler/digikey"];

const priceCacheCronWorker = {
  async scheduled(_controller: ScheduledController, env: CronEnv, context: ExecutionContext) {
    context.waitUntil(Promise.all(refreshPaths.map(async (path) => {
      const response = await fetch(env.APP_BASE_URL + path + "?refresh=" + Date.now(), {
        headers: { accept: "application/json", "x-cron-secret": env.CRON_SECRET.trim() },
      });
      if (!response.ok) throw new Error(path + " refresh failed with HTTP " + response.status);
    })));
  },

  async fetch() {
    return new Response("Price cache cron worker", { status: 200 });
  },
};

export default priceCacheCronWorker;
