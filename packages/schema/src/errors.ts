export class CMSConfigError extends Error {
  readonly code = "CMS_CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "CMSConfigError";
  }
}

export class SchemaLoadError extends Error {
  readonly code = "SCHEMA_LOAD_ERROR";
  readonly filePath: string | undefined;
  readonly cause: unknown;

  constructor(message: string, options: { filePath?: string; cause?: unknown } = {}) {
    super(options.filePath ? `${message} (${options.filePath})` : message);
    this.name = "SchemaLoadError";
    this.filePath = options.filePath;
    this.cause = options.cause;
  }
}

export class AdapterCapabilityError extends Error {
  readonly code = "ADAPTER_CAPABILITY_ERROR";

  constructor(provider: string, capability: string) {
    super(`Adapter "${provider}" does not support "${capability}".`);
    this.name = "AdapterCapabilityError";
  }
}
