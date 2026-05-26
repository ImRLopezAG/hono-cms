import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAIProvider } from "../ai-provider";

type FetchCall = { url: string; init: RequestInit };

function captureFetch(response: Response): { calls: FetchCall[]; impl: (input: any, init?: any) => Promise<Response> } {
  const calls: FetchCall[] = [];
  const impl = async (input: any, init?: any) => {
    calls.push({ url: typeof input === "string" ? input : String(input), init: init ?? {} });
    return response;
  };
  return { calls, impl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const baseInput = {
  collection: "articles",
  documentId: "doc-1",
  sourceLocale: "en",
  targetLocale: "es",
  fields: { title: "Hello world", body: "Goodbye" }
};

describe("createAIProvider — anthropic", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sends correct headers, model, max_tokens, system prompt, and messages", async () => {
    const envelope = {
      content: [{ type: "text", text: JSON.stringify({ title: "Hola mundo", body: "Adios" }) }]
    };
    const { calls, impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-test-model"
    });

    const out = await provider.translate(baseInput);

    expect(out).toEqual({ title: "Hola mundo", body: "Adios" });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("claude-test-model");
    expect(body.max_tokens).toBe(4096);
    expect(typeof body.system).toBe("string");
    expect(body.system).toContain("en");
    expect(body.system).toContain("es");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0]).toEqual({
      role: "user",
      content: JSON.stringify(baseInput.fields)
    });
  });

  test("uses default model when none provided and supports custom baseUrl", async () => {
    const envelope = {
      content: [{ type: "text", text: JSON.stringify({ title: "X", body: "Y" }) }]
    };
    const { calls, impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({
      provider: "anthropic",
      apiKey: "sk-1",
      baseUrl: "https://proxy.example/v1/messages"
    });
    await provider.translate(baseInput);

    expect(calls[0]!.url).toBe("https://proxy.example/v1/messages");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  test("throws when fetch returns non-2xx", async () => {
    const { impl } = captureFetch(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "anthropic", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/anthropic.*500/);
  });

  test("throws when response text is invalid JSON", async () => {
    const envelope = { content: [{ type: "text", text: "not valid json {" }] };
    const { impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "anthropic", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/non-JSON response/);
  });

  test("throws when an expected key is missing from response", async () => {
    const envelope = {
      content: [{ type: "text", text: JSON.stringify({ title: "only title" }) }]
    };
    const { impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "anthropic", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/missing key: body/);
  });

  test("throws when content[0].text is absent", async () => {
    const { impl } = captureFetch(jsonResponse({ content: [] }));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "anthropic", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow();
  });

  test("health() returns ok: true", async () => {
    const provider = createAIProvider({ provider: "anthropic", apiKey: "k" });
    const result = await provider.health!();
    expect(result.ok).toBe(true);
  });
});

describe("createAIProvider — openai", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses Authorization: Bearer and chat completions envelope", async () => {
    const envelope = {
      choices: [{ message: { content: JSON.stringify({ title: "Hola", body: "Chau" }) } }]
    };
    const { calls, impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({
      provider: "openai",
      apiKey: "sk-openai",
      model: "gpt-test"
    });
    const out = await provider.translate(baseInput);

    expect(out).toEqual({ title: "Hola", body: "Chau" });
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer sk-openai");

    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe("gpt-test");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({ role: "system", content: expect.stringContaining("en") });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: JSON.stringify(baseInput.fields)
    });
  });

  test("uses default openai model when none provided", async () => {
    const envelope = {
      choices: [{ message: { content: JSON.stringify({ title: "x", body: "y" }) } }]
    };
    const { calls, impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "openai", apiKey: "k" });
    await provider.translate(baseInput);
    expect(JSON.parse(calls[0]!.init.body as string).model).toBe("gpt-4o");
  });

  test("throws on non-2xx", async () => {
    const { impl } = captureFetch(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "openai", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/openai.*401/);
  });

  test("throws on invalid JSON content", async () => {
    const envelope = { choices: [{ message: { content: "not json" } }] };
    const { impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "openai", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/non-JSON/);
  });

  test("throws when missing key in response", async () => {
    const envelope = {
      choices: [{ message: { content: JSON.stringify({ title: "only title" }) } }]
    };
    const { impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({ provider: "openai", apiKey: "k" });
    await expect(provider.translate(baseInput)).rejects.toThrow(/missing key: body/);
  });
});

describe("createAIProvider — ai-gateway", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses Authorization Bearer + chat completions parsing with custom baseUrl/model", async () => {
    const envelope = {
      choices: [{ message: { content: JSON.stringify({ title: "T", body: "B" }) } }]
    };
    const { calls, impl } = captureFetch(jsonResponse(envelope));
    vi.stubGlobal("fetch", vi.fn(impl));

    const provider = createAIProvider({
      provider: "ai-gateway",
      apiKey: "gw-key",
      baseUrl: "https://gw.example/v1/chat/completions",
      model: "router-model"
    });
    const out = await provider.translate(baseInput);

    expect(out).toEqual({ title: "T", body: "B" });
    expect(calls[0]!.url).toBe("https://gw.example/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gw-key");

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("router-model");
  });
});

describe("createAIProvider — custom", () => {
  test("passes through to custom translate function", async () => {
    const translate = vi.fn().mockResolvedValue({ title: "OUT", body: "FOO" });
    const provider = createAIProvider({ provider: "custom", translate });

    const out = await provider.translate(baseInput);
    expect(out).toEqual({ title: "OUT", body: "FOO" });
    expect(translate).toHaveBeenCalledWith(baseInput);
    expect(provider.provider).toBe("custom");
  });

  test("uses provided healthCheck when given", async () => {
    const healthCheck = vi.fn().mockResolvedValue({ ok: false, message: "down" });
    const provider = createAIProvider({
      provider: "custom",
      translate: async () => ({}),
      healthCheck
    });
    const result = await provider.health!();
    expect(result).toEqual({ ok: false, message: "down" });
    expect(healthCheck).toHaveBeenCalledOnce();
  });

  test("defaults health to ok:true when no healthCheck given", async () => {
    const provider = createAIProvider({
      provider: "custom",
      translate: async () => ({})
    });
    const result = await provider.health!();
    expect(result.ok).toBe(true);
  });
});
