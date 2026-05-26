import { createCloudflareExport, createVercelHandler, generateVercelJson } from "@hono-cms/platform";
import { createNewsroomCMS } from "./app";

export const newsroomCronSecret = "newsroom-cron-secret";

export function createNewsroomCloudflareWorker() {
  return createCloudflareExport(createNewsroomCMS());
}

export function createNewsroomVercelHandler() {
  return createVercelHandler(createNewsroomCMS({
    jobs: { provider: "vercel", secret: newsroomCronSecret, cronOnly: true }
  }));
}

export const newsroomVercelJson = generateVercelJson({
  "/cms/jobs/scheduled-publish": "*/5 * * * *"
});
