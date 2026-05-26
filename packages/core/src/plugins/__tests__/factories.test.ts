import { describe, expect, it } from "vitest";
import { createAuthPlugin, createPlugin } from "../factories";
import { CMSPluginError } from "../types";

describe("createPlugin", () => {
  it("returns the input verbatim when valid", () => {
    const plugin = createPlugin({ id: "cors" });
    expect(plugin).toEqual({ id: "cors" });
  });

  it("throws on missing id", () => {
    expect(() => createPlugin({} as never)).toThrow(CMSPluginError);
  });

  it("throws on empty id", () => {
    expect(() => createPlugin({ id: "" } as never)).toThrow(CMSPluginError);
  });
});

describe("createAuthPlugin", () => {
  it("returns the input verbatim when valid", () => {
    const plugin = createAuthPlugin({
      id: "tokens",
      protected: async (_c, next) => { await next(); }
    });
    expect(plugin.id).toBe("tokens");
  });

  it("throws when protected is missing", () => {
    expect(() => createAuthPlugin({ id: "tokens" } as never)).toThrow(
      /must declare a `protected` middleware/
    );
  });
});
