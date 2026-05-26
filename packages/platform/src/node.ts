import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CMSInstance } from "@hono-cms/core";

export type NodeHandler = (request: IncomingMessage, response: ServerResponse) => void;

export type NodeHandlerOptions = {
  baseUrl?: string;
};

export function createNodeHandler(cms: Pick<CMSInstance, "fetch">, options: NodeHandlerOptions = {}): NodeHandler {
  return (incoming, outgoing) => {
    void handleNodeRequest(cms, incoming, outgoing, options);
  };
}

async function handleNodeRequest(
  cms: Pick<CMSInstance, "fetch">,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: NodeHandlerOptions
): Promise<void> {
  try {
    const request = toRequest(incoming, options);
    const response = await cms.fetch(request);
    await writeResponse(outgoing, response);
  } catch (error) {
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
    }
    outgoing.end(JSON.stringify({ error: "node_handler_error", message: error instanceof Error ? error.message : "request failed" }));
  }
}

function toRequest(incoming: IncomingMessage, options: NodeHandlerOptions): Request {
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }

  const host = headers.get("host") ?? "localhost";
  const baseUrl = options.baseUrl ?? `http://${host}`;
  const url = new URL(incoming.url ?? "/", baseUrl);
  const bodyless = method === "GET" || method === "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (!bodyless) {
    init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  writeHeaders(outgoing, response.headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    outgoing.on("error", reject);
    outgoing.on("finish", resolve);
    nodeStream.pipe(outgoing);
  });
}

function writeHeaders(outgoing: ServerResponse, headers: Headers): void {
  const setCookies = getSetCookieHeaders(headers);
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    outgoing.setHeader(key, value);
  });
  if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}
