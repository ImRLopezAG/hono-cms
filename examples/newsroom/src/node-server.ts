import { createServer, type Server } from "node:http";
import { createNodeHandler } from "@hono-cms/platform/node";
import { createNewsroomCMS } from "./app";

export type NewsroomNodeServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function startNewsroomNodeServer(): Promise<NewsroomNodeServer> {
  const cms = await createNewsroomCMS();
  const server = createServer(createNodeHandler({ fetch: cms.fetch.bind(cms) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Expected Node server to listen on a TCP address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
