import { createServer } from "node:http";
import { createNodeHandler } from "@hono-cms/platform/node";
import { createNewsroomCMS } from "./app";

const PORT = Number(process.env.PORT ?? 8787);

const cms = await createNewsroomCMS();
const server = createServer(createNodeHandler({ fetch: cms.fetch.bind(cms) }));

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[newsroom] listening on http://127.0.0.1:${PORT}`);
});

const shutdown = () => {
  // eslint-disable-next-line no-console
  console.log("[newsroom] shutting down...");
  server.close(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
