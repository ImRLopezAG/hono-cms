/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin deployment artifacts", () => {
  it("ships SPA fallback files for Cloudflare Pages and Vercel Static", async () => {
    const redirects = await readFile(resolve(process.cwd(), "public/_redirects"), "utf8");
    const vercel = JSON.parse(await readFile(resolve(process.cwd(), "public/vercel.json"), "utf8")) as {
      rewrites?: Array<{ source?: string; destination?: string }>;
    };

    expect(redirects.trim()).toBe("/* /index.html 200");
    expect(vercel.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
  });
});
