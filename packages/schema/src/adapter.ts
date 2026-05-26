import type { CMSCollections } from "./index";

export type ID = string;

export type ContentStatus = "draft" | "published" | "archived";

export type ContentRecord = Record<string, unknown> & {
  id: ID;
  createdAt: string;
  updatedAt: string;
  status?: ContentStatus;
  locale?: string;
};

export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$contains"
  | "$notContains"
  | "$startsWith"
  | "$endsWith"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$null"
  | "$notNull"
  | "$between";

export type FieldFilter = unknown | Partial<Record<FilterOperator, unknown>>;

export type PopulateNode = {
  fields?: string[];
  populate?: PopulateMap;
};

export type PopulateMap = Record<string, true | PopulateNode>;

export type QueryParams = {
  filters?: Record<string, FieldFilter>;
  limit?: number;
  cursor?: string;
  cursorCreatedAt?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  status?: ContentStatus;
  locale?: string;
  fallback?: boolean;
  populate?: PopulateMap;
  fields?: string[];
};

export type PaginatedResult<RecordType extends ContentRecord = ContentRecord> = {
  items: RecordType[];
  nextCursor?: string;
  total?: number;
};

export type AdapterCapabilities = {
  transactions?: boolean;
  jsonOperators?: boolean;
  advisoryLocks?: boolean;
  migrations?: boolean;
  populate?: boolean;
};

export type SchemaDiff = {
  added: string[];
  removed: string[];
  altered: string[];
};

export type MigrationFile = {
  filename: string;
  sql?: string;
  convexSchema?: string;
};

export type HealthStatus = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
};

export type DatabaseAdapter<Collections extends CMSCollections = CMSCollections, Client = unknown> = {
  readonly provider: string;
  readonly collections: Collections;
  readonly client: Client;
  readonly capabilities?: AdapterCapabilities;
  list(collection: keyof Collections & string, query?: QueryParams): Promise<PaginatedResult>;
  get(collection: keyof Collections & string, id: ID, query?: Pick<QueryParams, "populate" | "fields">): Promise<ContentRecord | null>;
  findManyByIds?(collection: keyof Collections & string, ids: readonly ID[], query?: Pick<QueryParams, "populate" | "fields">): Promise<ContentRecord[]>;
  create(collection: keyof Collections & string, input: Record<string, unknown>): Promise<ContentRecord>;
  update(collection: keyof Collections & string, id: ID, patch: Record<string, unknown>): Promise<ContentRecord>;
  delete(collection: keyof Collections & string, id: ID): Promise<void>;
  publish?(collection: keyof Collections & string, id: ID): Promise<ContentRecord>;
  unpublish?(collection: keyof Collections & string, id: ID): Promise<ContentRecord>;
  migrate?(schema: Collections): Promise<void>;
  checkDrift?(schema: Collections): Promise<SchemaDiff>;
  generateMigration?(schema: Collections): Promise<MigrationFile>;
  health?(): Promise<HealthStatus>;
};
