import type { HealthStatus } from "@hono-cms/schema";
import type { TranslationProvider } from "../types/providers";

export type AnthropicProviderConfig = {
  provider: "anthropic";
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

export type OpenAIProviderConfig = {
  provider: "openai";
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

export type AIGatewayProviderConfig = {
  provider: "ai-gateway";
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type CustomProviderConfig = {
  provider: "custom";
  translate: TranslationProvider["translate"];
  healthCheck?: () => Promise<HealthStatus>;
};

export type AIProviderConfig =
  | AnthropicProviderConfig
  | OpenAIProviderConfig
  | AIGatewayProviderConfig
  | CustomProviderConfig;

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_API_VERSION = "2023-06-01";

type TranslateInput = Parameters<TranslationProvider["translate"]>[0];

function systemPrompt(input: TranslateInput): string {
  return (
    `You are a professional translator. Translate the given JSON object values from ${input.sourceLocale} to ${input.targetLocale}. ` +
    "Preserve all keys. Return ONLY valid JSON, no commentary."
  );
}

function parseJsonResponse(text: string, providerName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`AI provider returned non-JSON response (provider: ${providerName})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`AI provider returned non-JSON response (provider: ${providerName})`);
  }
  return parsed as Record<string, unknown>;
}

function validateTranslatedFields(
  expected: Record<string, string>,
  actual: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(expected)) {
    const value = actual[key];
    if (typeof value !== "string") {
      throw new Error(`AI provider response missing key: ${key}`);
    }
    out[key] = value;
  }
  return out;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

async function postJson(
  url: string,
  init: { headers: Record<string, string>; body: unknown },
  providerName: string
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(init.body)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AI provider "${providerName}" network error: ${message}`);
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new Error(`AI provider "${providerName}" request failed with status ${response.status}: ${body}`);
  }
  return response;
}

async function safeReadJson(response: Response, providerName: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`AI provider "${providerName}" returned non-JSON response envelope`);
  }
}

function createAnthropicProvider(config: AnthropicProviderConfig): TranslationProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_ANTHROPIC_URL;
  return {
    provider: "anthropic",
    async translate(input) {
      const response = await postJson(
        baseUrl,
        {
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": ANTHROPIC_API_VERSION
          },
          body: {
            model,
            max_tokens: 4096,
            system: systemPrompt(input),
            messages: [
              { role: "user", content: JSON.stringify(input.fields) }
            ]
          }
        },
        "anthropic"
      );
      const envelope = (await safeReadJson(response, "anthropic")) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = envelope.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error('AI provider returned non-JSON response (provider: anthropic)');
      }
      const parsed = parseJsonResponse(text, "anthropic");
      return validateTranslatedFields(input.fields, parsed);
    },
    async health(): Promise<HealthStatus> {
      return { ok: true, message: "no health endpoint" };
    }
  };
}

function createOpenAICompatibleProvider(options: {
  providerName: string;
  apiKey: string;
  model: string;
  baseUrl: string;
}): TranslationProvider {
  return {
    provider: options.providerName,
    async translate(input) {
      const response = await postJson(
        options.baseUrl,
        {
          headers: {
            authorization: `Bearer ${options.apiKey}`
          },
          body: {
            model: options.model,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt(input) },
              { role: "user", content: JSON.stringify(input.fields) }
            ]
          }
        },
        options.providerName
      );
      const envelope = (await safeReadJson(response, options.providerName)) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = envelope.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new Error(`AI provider returned non-JSON response (provider: ${options.providerName})`);
      }
      const parsed = parseJsonResponse(text, options.providerName);
      return validateTranslatedFields(input.fields, parsed);
    },
    async health(): Promise<HealthStatus> {
      return { ok: true, message: "no health endpoint" };
    }
  };
}

function createCustomProvider(config: CustomProviderConfig): TranslationProvider {
  return {
    provider: "custom",
    translate: config.translate,
    async health(): Promise<HealthStatus> {
      if (config.healthCheck) return config.healthCheck();
      return { ok: true, message: "no health endpoint" };
    }
  };
}

export function createAIProvider(config: AIProviderConfig): TranslationProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "openai":
      return createOpenAICompatibleProvider({
        providerName: "openai",
        apiKey: config.apiKey,
        model: config.model ?? DEFAULT_OPENAI_MODEL,
        baseUrl: config.baseUrl ?? DEFAULT_OPENAI_URL
      });
    case "ai-gateway":
      return createOpenAICompatibleProvider({
        providerName: "ai-gateway",
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl
      });
    case "custom":
      return createCustomProvider(config);
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown AI provider config: ${JSON.stringify(exhaustive)}`);
    }
  }
}
