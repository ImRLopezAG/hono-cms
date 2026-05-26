/**
 * @vitest-environment happy-dom
 *
 * LocalePanel — connected unit coverage.
 *
 * The presentational `LocalePanelView` is covered indirectly through the
 * connected render, but we also exercise:
 *
 *   - self-gating (no i18n config / no recordId → renders nothing)
 *   - data fetch + status mapping (backend → row badges)
 *   - "Translate from {default}" mutation calls
 *     `POST /api/{collection}/{id}/translate`
 *   - retry button appears for `error` rows and re-invokes the same route
 *
 * The shell mirrors `ContentTypesView.dom.test.tsx`: stub global fetch,
 * render through a minimal in-memory router + React Query provider, then
 * drive the DOM with `act()`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider
} from "@tanstack/react-router";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalePanel, localeRowsFromResponse } from "./LocalePanel";
import type { RecordLocalesResponse } from "../../../lib/api-client";

declare global {
  // React needs this to accept async act() outside Jest.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("localeRowsFromResponse", () => {
  it("maps backend statuses onto the UI row model", () => {
    const response: RecordLocalesResponse = {
      defaultLocale: "en",
      locales: [
        { locale: "en", status: "complete", translatedBy: "human" },
        { locale: "fr", status: "complete", translatedBy: "pending" },
        { locale: "es", status: "in_progress", translatedBy: "pending" },
        { locale: "de", status: "error", translatedBy: "pending", error: "Provider 429" }
      ]
    };
    const rows = localeRowsFromResponse(response, {
      defaultLocale: "en",
      locales: ["en", "fr", "es", "de", "it"]
    });
    expect(rows.map((row) => [row.locale, row.status])).toEqual([
      ["en", "translated"],
      ["fr", "translated"],
      ["es", "pending"],
      ["de", "error"],
      ["it", "missing"]
    ]);
    expect(rows.find((row) => row.locale === "de")?.error).toBe("Provider 429");
  });
});

describe("LocalePanel self-gating", () => {
  it("renders nothing when the collection has no i18n config", async () => {
    await renderPanel(<LocalePanel collection="articles" recordId="rec-1" i18n={null} />, []);
    expect(container?.querySelector("[aria-label='Locales']")).toBeNull();
  });

  it("renders nothing for unsaved records (no recordId)", async () => {
    await renderPanel(
      <LocalePanel
        collection="articles"
        recordId={null}
        i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
      />,
      []
    );
    expect(container?.querySelector("[aria-label='Locales']")).toBeNull();
  });
});

describe("LocalePanel render + actions", () => {
  it("lists every locale with its status and triggers a translation on click", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    stubFetch(requests, {
      locales: [
        { locale: "en", status: "complete", translatedBy: "human" },
        { locale: "fr", status: "missing", translatedBy: "pending" }
      ],
      defaultLocale: "en"
    });

    await renderPanel(
      <LocalePanel
        collection="articles"
        recordId="rec-42"
        i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
      />,
      []
    );

    await waitForText("Translated");
    await waitForText("Missing");

    const translateButton = requiredElement<HTMLButtonElement>(
      "button[aria-label='Translate fr from en']"
    );
    await act(async () => {
      translateButton.click();
    });
    await waitForRequest(requests, "POST", "/api/articles/rec-42/translate");
    const translateRequest = requests.find(
      (request) => request.method === "POST" && request.url === "/api/articles/rec-42/translate"
    );
    expect(translateRequest?.body).toBe(JSON.stringify({ targetLocale: "fr" }));
  });

  it("surfaces a retry button for failed locales that re-invokes the translate route", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    stubFetch(requests, {
      locales: [
        { locale: "en", status: "complete", translatedBy: "human" },
        { locale: "fr", status: "error", translatedBy: "pending", error: "Provider 500" }
      ],
      defaultLocale: "en"
    });

    await renderPanel(
      <LocalePanel
        collection="articles"
        recordId="rec-99"
        i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
      />,
      []
    );

    await waitForText("Failed");
    await waitForText("Provider 500");

    const retry = requiredElement<HTMLButtonElement>(
      "button[aria-label='Retry translation for fr']"
    );
    await act(async () => {
      retry.click();
    });
    await waitForRequest(requests, "POST", "/api/articles/rec-99/translate");
    const retryRequest = requests.find(
      (request) => request.method === "POST" && request.url === "/api/articles/rec-99/translate"
    );
    expect(retryRequest?.body).toBe(JSON.stringify({ targetLocale: "fr" }));
  });
});

function stubFetch(
  sink: Array<{ url: string; method: string; body?: string }>,
  localesResponse: RecordLocalesResponse
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const entry: { url: string; method: string; body?: string } = { url, method };
      if (typeof init?.body === "string") entry.body = init.body;
      sink.push(entry);
      if (method === "GET" && url.endsWith("/locales")) {
        return Response.json(localesResponse);
      }
      if (method === "POST" && url.endsWith("/translate")) {
        return Response.json({ status: "complete" });
      }
      return Response.json({});
    })
  );
}

async function renderPanel(element: ReactElement, _ignored: unknown[]): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  // LocalePanel does not navigate, but `useClient` reads an atom and other
  // imports may transitively expect a router context — provide a minimal
  // in-memory router for parity with sibling tests.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => element
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] })
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  });
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = container?.querySelector(selector);
  if (!element) throw new Error(`Missing test element: ${selector}`);
  return element as ElementType;
}

async function waitForText(text: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!container?.textContent?.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for text: ${text}\nGot: ${container?.textContent}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function waitForRequest(
  sink: ReadonlyArray<{ url: string; method: string }>,
  method: string,
  url: string
): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!sink.some((entry) => entry.method === method && entry.url === url)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${method} ${url}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
