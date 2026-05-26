/**
 * @vitest-environment happy-dom
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
import { ContentTypesView } from "./AdminApp";

declare global {
  // React checks this flag before accepting async act() in non-Jest runners.
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

describe("ContentTypesView generated workflow", () => {
  it("creates a content type through the rendered admin UI and shows generated artifacts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (init?.method === "POST") {
        return Response.json({
          collection: {
            name: "products",
            fields: { title: { kind: "string", required: true } },
            options: { draftAndPublish: true }
          },
          source: `export const products = defineCollection("products", {\n  title: fields.string({ required: true })\n});`,
          path: "cms/collections/products.ts",
          artifacts: ["node_modules/.cms/sdk/index.ts", "node_modules/.cms/drizzle-schema.ts"],
          migrations: [".hono-cms/migrations/202605230001_create_products.sql"],
          message: "Generated typed SDK and database schema"
        }, { status: 201 });
      }
      return Response.json({
        collections: {},
        capabilities: {
          writable: true,
          mode: "development",
          endpoints: {
            list: "/cms/content-types",
            create: "/cms/content-types",
            update: "/cms/content-types/{name}"
          }
        }
      });
    }));

    renderWithQueryClient(<ContentTypesView />);
    await waitForText("Development writer enabled");
    await waitForText("Generated API preview");
    await waitForText("1. Write schema source");
    await waitForText("4. Verify before deploy");

    await act(async () => {
      requiredElement<HTMLButtonElement>("button[aria-label='Copy SDK preview']").click();
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("client.newCollection.create"));

    const name = requiredElement<HTMLInputElement>("input[name='name']");
    name.value = "products";

    await act(async () => {
      requiredElement<HTMLButtonElement>("button[form='content-type-form']").click();
    });

    await waitForText("Generated typed SDK and database schema");
    expect(container?.textContent).toContain("cms/collections/products.ts");
    expect(container?.textContent).toContain("node_modules/.cms/sdk/index.ts");
    expect(container?.textContent).toContain("defineCollection(\"products\"");

    const createRequest = requests.find((request) => request.init?.method === "POST");
    expect(createRequest?.url).toBe("/cms/content-types");
    expect(createRequest?.init?.body).toBe(JSON.stringify({
      name: "products",
      fields: { title: { kind: "string", required: true } },
      options: {}
    }));
  });
});

function renderWithQueryClient(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  /*
   * `ContentTypesView` renders a `<Link>` for the Form/Visualizer tab strip,
   * which requires a router context. We wrap the test in a minimal in-memory
   * router so the component renders without depending on the real app shell.
   */
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => element });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] })
  });
  act(() => {
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
  const deadline = Date.now() + 1_000;
  while (!container?.textContent?.includes(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for text: ${text}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
