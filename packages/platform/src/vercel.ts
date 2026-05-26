import type { CMSInstance } from "@hono-cms/core";

export type VercelRouteHandler = (request: Request) => Response | Promise<Response>;
export type VercelCron = { path: string; schedule: string };
export type VercelJson = { crons: VercelCron[] };

export function createVercelHandler(cms: Pick<CMSInstance, "fetch">): VercelRouteHandler {
  return (request) => cms.fetch(request);
}

export function generateVercelJson(scheduleMap: Record<string, string> | readonly VercelCron[]): VercelJson {
  const crons = Array.isArray(scheduleMap)
    ? scheduleMap
    : Object.entries(scheduleMap).map(([path, schedule]) => ({ path, schedule }));

  return { crons: crons.map(normalizeCron) };
}

function normalizeCron(cron: VercelCron): VercelCron {
  const path = cron.path.trim();
  const schedule = cron.schedule.trim();
  if (!path.startsWith("/")) {
    throw new Error(`Vercel cron path must start with "/": ${cron.path}`);
  }
  if (!schedule) {
    throw new Error(`Vercel cron schedule must be non-empty for ${path}`);
  }
  return { path, schedule };
}
