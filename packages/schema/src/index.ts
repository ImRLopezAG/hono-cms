import { z } from "zod";
import { CMSConfigError } from "./errors";
export { SchemaLoadError } from "./errors";
export { generateCollectionFile, type CollectionFileOptions } from "./file-writer";
export { generateDrizzleSchema, type DrizzleDialect, type GenerateDrizzleSchemaOptions } from "./drizzle-generator";

export type FieldKind =
  | "string"
  | "text"
  | "richtext"
  | "number"
  | "boolean"
  | "datetime"
  | "date"
  | "time"
  | "json"
  | "email"
  | "url"
  | "password"
  | "uid"
  | "enum"
  | "media"
  | "relation"
  | "component"
  | "dynamiczone";

type BaseField<Kind extends FieldKind, Required extends boolean = false> = {
  kind: Kind;
  required?: Required;
  unique?: boolean;
  localized?: boolean;
  private?: boolean;
  permissions?: FieldPermissions;
  default?: unknown;
};

export type FieldPermissionAudience = "public" | "authenticated" | (string & {});

export type FieldPermissions = {
  read?: readonly FieldPermissionAudience[];
  write?: readonly FieldPermissionAudience[];
};

export type StringField<Required extends boolean = false> = BaseField<"string", Required> & {
  min?: number;
  max?: number;
};

export type TextField<Required extends boolean = false> = BaseField<"text", Required>;
export type RichTextField<Required extends boolean = false> = BaseField<"richtext", Required>;
export type NumberField<Required extends boolean = false> = BaseField<"number", Required> & {
  int?: boolean;
  min?: number;
  max?: number;
};
export type BooleanField<Required extends boolean = false> = BaseField<"boolean", Required>;
export type DateTimeField<Required extends boolean = false> = BaseField<"datetime", Required>;
export type DateField<Required extends boolean = false> = BaseField<"date", Required>;
export type TimeField<Required extends boolean = false> = BaseField<"time", Required>;
export type JsonField<Required extends boolean = false> = BaseField<"json", Required>;
export type EmailField<Required extends boolean = false> = BaseField<"email", Required>;
export type UrlField<Required extends boolean = false> = BaseField<"url", Required>;
export type PasswordField<Required extends boolean = false> = BaseField<"password", Required>;
export type UidField<Required extends boolean = false> = BaseField<"uid", Required> & {
  targetField?: string;
};
export type EnumField<Values extends readonly [string, ...string[]], Required extends boolean = false> =
  BaseField<"enum", Required> & { values: Values };
export type MediaField<Required extends boolean = false> = BaseField<"media", Required> & {
  multiple?: boolean;
};
export type RelationField<
  Target extends string = string,
  Cardinality extends RelationCardinality = "one",
  Required extends boolean = false
> = BaseField<"relation", Required> & {
  target: Target;
  cardinality: Cardinality;
  inverse?: string;
  onDelete?: "cascade" | "restrict" | "set_null";
};

export type ComponentField<
  ComponentName extends string = string,
  Required extends boolean = false,
  Repeatable extends boolean = false
> = BaseField<"component", Required> & {
  component: ComponentName;
  repeatable?: Repeatable;
  min?: number;
  max?: number;
};

export type DynamicZoneField<
  Components extends readonly string[] = readonly string[],
  Required extends boolean = false
> = BaseField<"dynamiczone", Required> & {
  components: Components;
  min?: number;
  max?: number;
};

export type RelationCardinality = "one" | "many" | "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";
type InverseOrJoinRelationCardinality = "one-to-many" | "many-to-many";
type RelationDeleteOption<Cardinality extends RelationCardinality> =
  Cardinality extends "many-to-many" ? "cascade" | "restrict" : "cascade" | "restrict" | "set_null";
type RelationFieldConfig<
  Target extends string,
  Cardinality extends RelationCardinality,
  Required extends boolean
> =
  Omit<RelationField<Target, Cardinality, Required>, "kind" | "target" | "cardinality" | "required" | "onDelete"> &
  { onDelete?: RelationDeleteOption<Cardinality> } &
  (Cardinality extends InverseOrJoinRelationCardinality ? { required?: never } : { required?: Required });

export type FieldDefinition =
  | StringField<boolean>
  | TextField<boolean>
  | RichTextField<boolean>
  | NumberField<boolean>
  | BooleanField<boolean>
  | DateTimeField<boolean>
  | DateField<boolean>
  | TimeField<boolean>
  | JsonField<boolean>
  | EmailField<boolean>
  | UrlField<boolean>
  | PasswordField<boolean>
  | UidField<boolean>
  | EnumField<readonly [string, ...string[]], boolean>
  | MediaField<boolean>
  | RelationField<string, RelationCardinality, boolean>
  | ComponentField<string, boolean, boolean>
  | DynamicZoneField<readonly string[], boolean>;

export type FieldsDefinition = Record<string, FieldDefinition>;

export type ComponentDefinition<Name extends string, Fields extends FieldsDefinition> = {
  name: Name;
  fields: Fields;
};

export type CMSComponents = Record<string, ComponentDefinition<string, FieldsDefinition>>;

export type CollectionOptions = {
  draftAndPublish?: boolean;
  timestamps?: boolean;
  i18n?: {
    locales: readonly [string, ...string[]];
    defaultLocale: string;
  };
  rbac?: {
    public?: readonly CollectionAction[];
    authenticated?: readonly CollectionAction[];
  };
};

export type CollectionAction = "create" | "read" | "update" | "delete" | "publish";

export type CollectionDefinition<Name extends string, Fields extends FieldsDefinition> = {
  name: Name;
  fields: Fields;
  options: CollectionOptions;
};

type FieldValue<Field extends FieldDefinition> =
  Field extends StringField<boolean> | TextField<boolean> | RichTextField<boolean> | DateField<boolean> | TimeField<boolean> | EmailField<boolean> | UrlField<boolean> | PasswordField<boolean> | UidField<boolean> ? string
  : Field extends NumberField<boolean> ? number
  : Field extends BooleanField<boolean> ? boolean
  : Field extends DateTimeField<boolean> ? string
  : Field extends JsonField<boolean> ? unknown
  : Field extends EnumField<infer Values, boolean> ? Values[number]
  : Field extends MediaField<boolean> ? (Field["multiple"] extends true ? string[] : string)
  : Field extends RelationField<string, infer Cardinality, boolean> ? (RelationCardinalityIsMany<Cardinality> extends true ? string[] : string)
  : Field extends ComponentField<string, boolean, boolean> ? (Field["repeatable"] extends true ? Record<string, unknown>[] : Record<string, unknown>)
  : Field extends DynamicZoneField<readonly string[], boolean> ? Array<{ __component: string } & Record<string, unknown>>
  : never;

type RelationCardinalityIsMany<Cardinality extends RelationCardinality> =
  Cardinality extends "many" | "one-to-many" | "many-to-many" ? true : false;

type OptionalKeys<Fields extends FieldsDefinition> = {
  [Key in keyof Fields]: Fields[Key]["required"] extends true ? never : Key;
}[keyof Fields];

type RequiredKeys<Fields extends FieldsDefinition> = Exclude<keyof Fields, OptionalKeys<Fields>>;

export type InferCollectionInput<Collection extends CollectionDefinition<string, FieldsDefinition>> =
  { [Key in RequiredKeys<Collection["fields"]>]: FieldValue<Collection["fields"][Key]> } &
  { [Key in OptionalKeys<Collection["fields"]>]?: FieldValue<Collection["fields"][Key]> };

export type InferCollectionOutput<Collection extends CollectionDefinition<string, FieldsDefinition>> =
  InferCollectionInput<Collection> & {
    id: string;
    createdAt: string;
    updatedAt: string;
    status?: "draft" | "published" | "archived";
    locale?: string;
  };

export type CMSCollections = Record<string, CollectionDefinition<string, FieldsDefinition>>;

export const CMS_COLLECTION_SYMBOL = Symbol.for("@hono-cms/collection");

export type InferCMS<Collections extends CMSCollections> = {
  [Name in keyof Collections]: InferCollectionOutput<Collections[Name]>;
};

export function isCMSCollection(value: unknown): value is CollectionDefinition<string, FieldsDefinition> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[CMS_COLLECTION_SYMBOL] === true);
}

export const fields = {
  string: <Required extends boolean = false>(config: Omit<StringField<Required>, "kind"> = {}): StringField<Required> => ({ kind: "string", ...config }),
  text: <Required extends boolean = false>(config: Omit<TextField<Required>, "kind"> = {}): TextField<Required> => ({ kind: "text", ...config }),
  richtext: <Required extends boolean = false>(config: Omit<RichTextField<Required>, "kind"> = {}): RichTextField<Required> => ({ kind: "richtext", ...config }),
  number: <Required extends boolean = false>(config: Omit<NumberField<Required>, "kind"> = {}): NumberField<Required> => ({ kind: "number", ...config }),
  boolean: <Required extends boolean = false>(config: Omit<BooleanField<Required>, "kind"> = {}): BooleanField<Required> => ({ kind: "boolean", ...config }),
  datetime: <Required extends boolean = false>(config: Omit<DateTimeField<Required>, "kind"> = {}): DateTimeField<Required> => ({ kind: "datetime", ...config }),
  date: <Required extends boolean = false>(config: Omit<DateField<Required>, "kind"> = {}): DateField<Required> => ({ kind: "date", ...config }),
  time: <Required extends boolean = false>(config: Omit<TimeField<Required>, "kind"> = {}): TimeField<Required> => ({ kind: "time", ...config }),
  json: <Required extends boolean = false>(config: Omit<JsonField<Required>, "kind"> = {}): JsonField<Required> => ({ kind: "json", ...config }),
  email: <Required extends boolean = false>(config: Omit<EmailField<Required>, "kind"> = {}): EmailField<Required> => ({ kind: "email", ...config }),
  url: <Required extends boolean = false>(config: Omit<UrlField<Required>, "kind"> = {}): UrlField<Required> => ({ kind: "url", ...config }),
  password: <Required extends boolean = false>(config: Omit<PasswordField<Required>, "kind"> = {}): PasswordField<Required> => ({ kind: "password", ...config }),
  uid: <Required extends boolean = false>(config: Omit<UidField<Required>, "kind"> = {}): UidField<Required> => ({ kind: "uid", ...config }),
  enum: <Values extends readonly [string, ...string[]], Required extends boolean = false>(
    values: Values,
    config: Omit<EnumField<Values, Required>, "kind" | "values"> = {}
  ): EnumField<Values, Required> => ({ kind: "enum", values, ...config }),
  media: <Required extends boolean = false>(config: Omit<MediaField<Required>, "kind"> = {}): MediaField<Required> => ({ kind: "media", ...config }),
  relation: <Target extends string, Cardinality extends RelationCardinality = "one", Required extends boolean = false>(
    target: Target,
    cardinality: Cardinality,
    config: RelationFieldConfig<Target, Cardinality, Required> = {}
  ): RelationField<Target, Cardinality, Required> => ({ kind: "relation", target, cardinality, ...config }),
  component: <ComponentName extends string, Required extends boolean = false, Repeatable extends boolean = false>(
    component: ComponentName,
    config: Omit<ComponentField<ComponentName, Required, Repeatable>, "kind" | "component"> = {}
  ): ComponentField<ComponentName, Required, Repeatable> => ({ kind: "component", component, ...config }),
  dynamiczone: <Components extends readonly string[], Required extends boolean = false>(
    components: Components,
    config: Omit<DynamicZoneField<Components, Required>, "kind" | "components"> = {}
  ): DynamicZoneField<Components, Required> => ({ kind: "dynamiczone", components, ...config })
};

export function defineCollection<const Name extends string, const Fields extends FieldsDefinition>(
  name: Name,
  fieldsConfig: Fields,
  options: CollectionOptions = {}
): CollectionDefinition<Name, Fields> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Collection name "${name}" must be kebab-case.`);
  }

  const collection = { name, fields: fieldsConfig, options };
  Object.defineProperty(collection, CMS_COLLECTION_SYMBOL, {
    value: true,
    enumerable: false
  });
  return collection;
}

export const CMS_COMPONENT_SYMBOL = Symbol.for("@hono-cms/component");

export function defineComponent<const Name extends string, const Fields extends FieldsDefinition>(
  name: Name,
  fieldsConfig: Fields
): ComponentDefinition<Name, Fields> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Component name "${name}" must be kebab-case.`);
  }
  const component = { name, fields: fieldsConfig };
  Object.defineProperty(component, CMS_COMPONENT_SYMBOL, {
    value: true,
    enumerable: false
  });
  return component;
}

export function isCMSComponent(value: unknown): value is ComponentDefinition<string, FieldsDefinition> {
  return Boolean(value && typeof value === "object" && (value as Record<PropertyKey, unknown>)[CMS_COMPONENT_SYMBOL] === true);
}

export type SchemaInput<Collections extends CMSCollections, Components extends CMSComponents = CMSComponents> = {
  collections: Collections;
  components?: Components;
};

const COMPONENTS_REGISTRY = new WeakMap<CMSCollections, CMSComponents>();

export function getSchemaComponents(collections: CMSCollections): CMSComponents {
  return COMPONENTS_REGISTRY.get(collections) ?? {};
}

export function defineSchema<const Collections extends CMSCollections>(collections: Collections): Collections;
export function defineSchema<const Collections extends CMSCollections, const Components extends CMSComponents>(
  input: SchemaInput<Collections, Components>
): Collections;
export function defineSchema(input: CMSCollections | SchemaInput<CMSCollections, CMSComponents>): CMSCollections {
  const { collections, components } = normalizeSchemaInput(input);
  validateSchema(collections, components);
  if (components && Object.keys(components).length > 0) {
    COMPONENTS_REGISTRY.set(collections, components);
  }
  return collections;
}

function normalizeSchemaInput(
  input: CMSCollections | SchemaInput<CMSCollections, CMSComponents>
): { collections: CMSCollections; components: CMSComponents } {
  if (isSchemaInputObject(input)) {
    return { collections: input.collections, components: input.components ?? {} };
  }
  return { collections: input, components: {} };
}

function isSchemaInputObject(
  value: CMSCollections | SchemaInput<CMSCollections, CMSComponents>
): value is SchemaInput<CMSCollections, CMSComponents> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { collections?: unknown; components?: unknown };
  if (!candidate.collections || typeof candidate.collections !== "object") return false;
  // Reject if this looks like a CMSCollections itself — verify members are CollectionDefinitions
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (isCMSCollection(entry)) return false;
  }
  return true;
}

export function validateSchema(collections: CMSCollections, components: CMSComponents = {}): void {
  const names = new Set(Object.keys(collections));
  const componentNames = new Set(Object.keys(components));

  for (const componentName of componentNames) {
    const component = components[componentName];
    if (!component) continue;
    for (const [fieldName, field] of Object.entries(component.fields)) {
      if (field.kind === "relation") {
        throw new CMSConfigError(`Component "${componentName}.${fieldName}" cannot declare a relation field — relations are only valid on collections.`);
      }
      if (field.kind === "component" && !componentNames.has(field.component)) {
        throw new CMSConfigError(`Component "${componentName}.${fieldName}" references unknown component "${field.component}".`);
      }
      if (field.kind === "dynamiczone") {
        for (const allowed of field.components) {
          if (!componentNames.has(allowed)) {
            throw new CMSConfigError(`Component "${componentName}.${fieldName}" dynamiczone references unknown component "${allowed}".`);
          }
        }
      }
    }
  }

  for (const collection of Object.values(collections)) {
    if (collection.options.i18n) {
      const { locales, defaultLocale } = collection.options.i18n;
      if (!locales.includes(defaultLocale)) {
        throw new CMSConfigError(`Collection "${collection.name}" i18n.defaultLocale must be included in i18n.locales.`);
      }
      for (const locale of locales) {
        if (!isBCP47Locale(locale)) {
          throw new CMSConfigError(`Collection "${collection.name}" i18n locale "${locale}" must be a valid BCP 47 language tag.`);
        }
      }
    }
    for (const [audience, actions] of Object.entries(collection.options.rbac ?? {})) {
      for (const action of actions ?? []) {
        if (!isCollectionAction(action)) {
          throw new CMSConfigError(`Collection "${collection.name}" rbac.${audience} includes unknown action "${action}".`);
        }
      }
    }

    for (const [fieldName, field] of Object.entries(collection.fields)) {
      for (const [operation, audiences] of Object.entries(field.permissions ?? {})) {
        for (const audience of audiences ?? []) {
          if (!audience.trim()) {
            throw new CMSConfigError(`Field "${collection.name}.${fieldName}" permissions.${operation} includes an empty audience.`);
          }
        }
      }
      if (field.kind === "component") {
        if (!componentNames.has(field.component)) {
          throw new CMSConfigError(`Component field "${collection.name}.${fieldName}" references unknown component "${field.component}". Pass it in defineSchema({ collections, components }).`);
        }
        continue;
      }
      if (field.kind === "dynamiczone") {
        if (field.components.length === 0) {
          throw new CMSConfigError(`DynamicZone "${collection.name}.${fieldName}" must allow at least one component.`);
        }
        for (const allowed of field.components) {
          if (!componentNames.has(allowed)) {
            throw new CMSConfigError(`DynamicZone "${collection.name}.${fieldName}" references unknown component "${allowed}". Pass it in defineSchema({ collections, components }).`);
          }
        }
        continue;
      }
      if (field.kind !== "relation") continue;
      if (!names.has(field.target)) {
        throw new CMSConfigError(`Relation "${collection.name}.${fieldName}" targets unknown collection "${field.target}".`);
      }
      if ((field.cardinality === "one-to-many" || field.cardinality === "many-to-many") && field.required) {
        throw new CMSConfigError(`Relation "${collection.name}.${fieldName}" cannot set required: true with ${field.cardinality} cardinality because no local foreign key column exists.`);
      }
      if (field.onDelete === "set_null" && field.required) {
        throw new CMSConfigError(`Relation "${collection.name}.${fieldName}" cannot use onDelete "set_null" when required is true.`);
      }
      if (field.onDelete === "set_null" && field.cardinality === "many-to-many") {
        throw new CMSConfigError(`Relation "${collection.name}.${fieldName}" cannot use onDelete "set_null" with many-to-many cardinality.`);
      }
      if (field.inverse) {
        const target = collections[field.target];
        const inverse = target?.fields[field.inverse];
        if (!inverse || inverse.kind !== "relation" || inverse.target !== collection.name) {
          throw new CMSConfigError(`Relation "${collection.name}.${fieldName}" inverse "${field.target}.${field.inverse}" is not a relation back to "${collection.name}".`);
        }
      }
    }
  }
}

function isBCP47Locale(locale: string): boolean {
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale);
}

function isCollectionAction(action: string): action is CollectionAction {
  return action === "create" || action === "read" || action === "update" || action === "delete" || action === "publish";
}

export function collectionToZod(
  collection: CollectionDefinition<string, FieldsDefinition>,
  components: CMSComponents = {}
): z.ZodObject<Record<string, z.ZodType>> {
  const shape = fieldsToZodShape(collection.fields, components);
  return z.object(shape);
}

export function componentToZod(
  component: ComponentDefinition<string, FieldsDefinition>,
  components: CMSComponents = {}
): z.ZodObject<Record<string, z.ZodType>> {
  return z.object(fieldsToZodShape(component.fields, components));
}

function fieldsToZodShape(fieldDefinitions: FieldsDefinition, components: CMSComponents): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};

  for (const [key, field] of Object.entries(fieldDefinitions)) {
    let schema: z.ZodType;

    switch (field.kind) {
      case "string":
      case "text":
      case "richtext":
      case "datetime":
      case "date":
      case "time":
      case "password":
      case "uid":
        schema = z.string();
        break;
      case "media":
        schema = field.multiple ? z.array(z.string()) : z.string();
        break;
      case "email":
        schema = z.string().email();
        break;
      case "url":
        schema = z.string().url();
        break;
      case "number":
        schema = field.int ? z.number().int() : z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "json":
        schema = z.unknown();
        break;
      case "enum":
        schema = z.enum(field.values);
        break;
      case "relation":
        schema = isManyRelation(field) ? z.array(z.string()) : z.string();
        break;
      case "component": {
        const target = components[field.component];
        const itemSchema = target ? componentToZod(target, components) : z.record(z.string(), z.unknown());
        schema = field.repeatable ? withArrayBounds(z.array(itemSchema), field.min, field.max) : itemSchema;
        break;
      }
      case "dynamiczone": {
        const variants = field.components.map((name) => {
          const target = components[name];
          const base = target ? componentToZod(target, components) : z.object({});
          return base.extend({ __component: z.literal(name) });
        });
        const itemSchema = variants.length > 1
          ? z.discriminatedUnion("__component", variants as [z.ZodObject<{ __component: z.ZodLiteral<string> }>, ...z.ZodObject<{ __component: z.ZodLiteral<string> }>[]])
          : variants[0] ?? z.object({ __component: z.string() });
        schema = withArrayBounds(z.array(itemSchema), field.min, field.max);
        break;
      }
      default:
        field satisfies never;
        schema = z.never();
    }

    shape[key] = field.required ? schema : schema.optional();
  }

  return shape;
}

function withArrayBounds(schema: z.ZodArray<z.ZodType>, min?: number, max?: number): z.ZodType {
  let next: z.ZodType = schema;
  if (typeof min === "number") next = (next as z.ZodArray<z.ZodType>).min(min);
  if (typeof max === "number") next = (next as z.ZodArray<z.ZodType>).max(max);
  return next;
}

export function generateTypeScriptSDK(collections: CMSCollections, components: CMSComponents = getSchemaComponents(collections)): string {
  const orderedCollections = Object.values(collections).sort((a, b) => a.name.localeCompare(b.name));
  const orderedComponents = Object.values(components).sort((a, b) => a.name.localeCompare(b.name));
  const schemaHash = hashSchema(collections, components);
  const lines = [
    "/* eslint-disable */",
    "// Generated by @hono-cms/schema. Do not edit by hand.",
    `// schemaHash: ${schemaHash}`,
    "import qs from 'qs';",
    "export { qs };",
    "export type ID = string;",
    "export type ContentStatus = 'draft' | 'published' | 'archived';",
    "export type Primitive = string | number | boolean | null | undefined;",
    "export type FilterOperators<T> = T extends string ? { $eq?: T; $ne?: T; $contains?: string; $notContains?: string; $startsWith?: string; $endsWith?: string; $in?: T[]; $nin?: T[]; $null?: boolean; $notNull?: boolean; $between?: [T, T] } : T extends number ? { $eq?: T; $ne?: T; $gt?: T; $gte?: T; $lt?: T; $lte?: T; $in?: T[]; $nin?: T[]; $null?: boolean; $notNull?: boolean; $between?: [T, T] } : T extends boolean ? { $eq?: T; $ne?: T; $null?: boolean; $notNull?: boolean } : { $eq?: T; $ne?: T; $in?: T[]; $nin?: T[]; $null?: boolean; $notNull?: boolean };",
    "export type FilterValue<T> = NonNullable<T> extends Primitive ? NonNullable<T> | FilterOperators<NonNullable<T>> : NonNullable<T> extends readonly (infer Item)[] ? DeepFilters<Item> | FilterOperators<ID> : NonNullable<T> extends object ? DeepFilters<NonNullable<T>> | FilterOperators<ID> : FilterOperators<ID>;",
    "export type DeepFilters<T> = { [K in keyof T]?: FilterValue<T[K]> };",
    "export type SortDirection = 'asc' | 'desc';",
    "export type SortParam<T> = Extract<keyof T, string> | `-${Extract<keyof T, string>}` | `${Extract<keyof T, string>}:${SortDirection}`;",
    "export type CursorPagination = { limit?: number; cursor?: string };",
    "export type OffsetPagination = { page?: number; pageSize?: number };",
    "export type QueryParams<T, Populate extends string = Extract<keyof T, string>, Locale extends string = string> = { filters?: DeepFilters<T>; sort?: SortParam<T> | SortParam<T>[]; pagination?: CursorPagination | OffsetPagination; populate?: '*' | Populate[]; fields?: Extract<keyof T, string>[]; status?: ContentStatus; locale?: Locale; fallback?: boolean; preview?: string };",
    "export type PopulateParams<RelationKey extends string> = { populate?: '*' | readonly RelationKey[] };",
    "export type CMSPaginationMeta = { cursor?: string; hasMore?: boolean; total?: number; page?: number; pageSize?: number; pageCount?: number };",
    "export type PaginatedResponse<T> = { items: T[]; nextCursor?: string; total?: number };",
    "export type MediaRecord = { id: ID; key: string; url: string; filename: string; size: number; contentType?: string; metadata?: Record<string, string>; createdAt: string; updatedAt: string };",
    "export type MediaFile = MediaRecord;",
    "export type MediaContentTypeInput = { contentType: string; mimeType?: string } | { contentType?: string; mimeType: string };",
    "export type MediaPresignInput = { filename: string; size: number } & MediaContentTypeInput;",
    "export type MediaPresign = { uploadId: string; uploadUrl: string; method: 'PUT' | 'POST'; key: string; headers?: Record<string, string>; expiresAt: string };",
    "export type MediaConfirmInput = { uploadId: string; key: string; filename: string; size: number; metadata?: Record<string, string> } & MediaContentTypeInput;",
    "export type SchedulePublishInput = { publishAt: string | Date };",
    "export type PreviewTokenRequest<Collection extends string = string> = { collection: Collection; documentId: ID };",
    "export type PreviewToken = { token: string; expiresAt: string; previewUrl: string };",
    "export type AuditOperation = 'create' | 'update' | 'delete' | 'publish' | 'unpublish' | 'media_upload' | 'media_delete' | 'schema_change';",
    "export type AuditDiff = { before: Record<string, unknown> | null; after: Record<string, unknown> | null };",
    "export type AuditEntry = { id: ID; operation: AuditOperation; collection?: string; documentId?: ID; actorId?: string; actorRoles: string[]; requestId: string; diff: AuditDiff; createdAt: string };",
    "export type AuditLogQuery = { collection?: string; documentId?: ID; operation?: AuditOperation; actorId?: string; from?: string; to?: string; cursor?: string; limit?: number };",
    "export type WebhookDeliveryStatus = 'pending' | 'success' | 'retrying' | 'failed';",
    "export type WebhookDelivery = { id: ID; webhookId: ID | null; eventType: string; url: string; attempt: number; status: WebhookDeliveryStatus; requestBody: string; responseStatus?: number; responseBody?: string; error?: string; nextAttemptAt?: string; createdAt: string };",
    "export type WebhookRecord = { id: ID; name: string; url: string; secret?: string; events: readonly string[]; enabled: boolean; createdAt: string; updatedAt: string };",
    "export type WebhookListItem = Omit<WebhookRecord, 'secret'> & { hasSecret: boolean; lastDeliveryAt: string | null; lastDeliveryStatus: WebhookDeliveryStatus | null };",
    "export type WebhookInput = { name: string; url: string; events: string[]; enabled?: boolean; secret?: string };",
    "export type WebhookUpdateInput = Omit<Partial<WebhookInput>, 'secret'> & { secret?: string | null };",
    "export type WebhookListResponse = { items: WebhookListItem[]; meta?: { total: number } };",
    "export type ApiKeyRecord = { id: ID; name?: string; userId: string; roles: readonly string[]; enabled: boolean; prefix?: string; createdAt?: string; updatedAt?: string; lastUsedAt?: string };",
    "export type ApiKeyInput = { name?: string; userId: string; roles: string[]; enabled?: boolean };",
    "export type ApiKeyUpdateInput = Partial<Pick<ApiKeyInput, 'name' | 'roles' | 'enabled'>>;",
    "export type ApiKeyCreateResponse = ApiKeyRecord & { secret: string };",
    "export type ApiKeyListResponse = { items: ApiKeyRecord[]; meta?: { total: number } };",
    "export type LivenessReport = { status: 'ok'; version: string; uptime_seconds: number };",
    "export type HealthCheck = { status: 'ok' | 'error'; latency_ms?: number; error?: string; details?: Record<string, unknown> };",
    "export type HealthReport = { status: 'ok' | 'degraded'; version: string; uptime_seconds: number; checks: Record<string, HealthCheck> };",
    "export type SchemaFieldKind = 'string' | 'text' | 'richtext' | 'number' | 'boolean' | 'datetime' | 'date' | 'time' | 'json' | 'email' | 'url' | 'password' | 'uid' | 'enum' | 'media' | 'relation' | 'component' | 'dynamiczone';",
    "export type SchemaFieldMetadata = { kind: SchemaFieldKind; required: boolean; unique: boolean; localized: boolean; private: boolean; min?: number; max?: number; int?: boolean; values?: readonly string[]; multiple?: boolean; target?: string; targetField?: string; cardinality?: string; inverse?: string; onDelete?: string; permissions?: Record<string, readonly string[]>; default?: unknown; component?: string; repeatable?: boolean; components?: readonly string[] };",
    "export type SchemaCollectionMetadata<Name extends string = string> = { name: Name; fields: Record<string, SchemaFieldMetadata>; options: { draftAndPublish?: boolean; timestamps?: boolean; i18n?: { locales: readonly string[]; defaultLocale: string }; rbac?: Record<string, readonly string[]> } };",
    "export type SchemaMetadata<Collection extends string = string> = { collections: Record<Collection, SchemaCollectionMetadata<Collection>> };",
    "export type ContentTypeCapabilities = { writable: boolean; mode: 'development' | 'read-only' | (string & {}); endpoints?: Record<string, string> };",
    "export type ContentTypeInput = { name: string; fields: Record<string, Partial<SchemaFieldMetadata> & { kind: SchemaFieldKind }>; options?: SchemaCollectionMetadata['options'] };",
    "export type ContentTypeWriteResponse = { collection: SchemaCollectionMetadata; source?: string; path?: string };",
    "export type ContentTypeListResponse<Collection extends string = string> = SchemaMetadata<Collection> & { capabilities: ContentTypeCapabilities };",
    "export type LocaleVariantStatus = 'pending' | 'in_progress' | 'complete' | 'error';",
    "export type LocaleTranslatedBy = 'ai' | 'human' | 'pending';",
    "export type LocaleState<Locale extends string = string> = { locale: Locale; status: LocaleVariantStatus | 'missing'; translatedBy: LocaleTranslatedBy; translatedAt?: string; error?: string };",
    "export type LocaleStatusResponse<Locale extends string = string> = { defaultLocale: Locale; locales: LocaleState<Locale>[] };",
    "export type TranslationVariant<Locale extends string = string, Fields extends Record<string, unknown> = Record<string, unknown>> = { id: ID; collection: string; documentId: ID; locale: Locale; fields: Partial<Fields>; status: LocaleVariantStatus; translatedBy: LocaleTranslatedBy; sourceUpdatedAt?: string; error?: string; provider?: string; translatedAt?: string; createdAt: string; updatedAt: string };",
    "export type TranslateInput<Locale extends string = string> = { targetLocale: Locale; sourceLocale?: Locale };",
    "export type LocaleReviewInput = { translatedBy: 'human' };",
    "export type SystemKeys = 'id' | 'createdAt' | 'updatedAt' | 'status' | 'publishedAt' | 'locale' | 'createdBy' | 'updatedBy';",
    "export type CreateInput<T> = Omit<T, SystemKeys>;",
    "export type UpdateInput<T> = Partial<CreateInput<T>>;",
    "export type PopulatedQuery<RelationKey extends string> = { populate: '*' | readonly RelationKey[] };",
    "export type PopulatedResult<Base, Populated, Query> = [NonNullable<Query>] extends [never] ? Base : NonNullable<Query> extends PopulatedQuery<string> ? Populated : Base;",
    "export type ClientOptions = { baseUrl: string; token?: string; fetch?: typeof fetch };",
    "export function buildQuery<T, Populate extends string = Extract<keyof T, string>, Locale extends string = string>(query: QueryParams<T, Populate, Locale> = {}): string {",
    "  return qs.stringify(query, { encodeValuesOnly: true, arrayFormat: 'brackets', skipNulls: true });",
    "}",
    "export function buildFlatQuery(query: object = {}): string {",
    "  const params = new URLSearchParams();",
    "  for (const [key, value] of Object.entries(query)) {",
    "    if (value !== undefined && value !== null) params.set(key, String(value));",
    "  }",
    "  return params.toString();",
    "}",
    "async function request<T>(options: ClientOptions, path: string, init: RequestInit = {}, json = true): Promise<T> {",
    "  const fetcher = options.fetch ?? fetch;",
    "  const headers = new Headers(init.headers);",
    "  if (options.token) headers.set('authorization', `Bearer ${options.token}`);",
    "  if (json && init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');",
    "  const response = await fetcher(new URL(path, options.baseUrl), { ...init, headers });",
    "  if (response.status === 204) return undefined as T;",
    "  const data = await response.json();",
    "  if (!response.ok) throw Object.assign(new Error(data?.error ?? `Request failed with ${response.status}`), { status: response.status, data });",
    "  return data as T;",
    "}",
    "async function requestText(options: ClientOptions, path: string, init: RequestInit = {}): Promise<string> {",
    "  const fetcher = options.fetch ?? fetch;",
    "  const headers = new Headers(init.headers);",
    "  if (options.token) headers.set('authorization', `Bearer ${options.token}`);",
    "  const response = await fetcher(new URL(path, options.baseUrl), { ...init, headers });",
    "  const text = await response.text();",
    "  if (!response.ok) throw Object.assign(new Error(text || `Request failed with ${response.status}`), { status: response.status, data: text });",
    "  return text;",
    "}",
    ""
  ];

  lines.push("export const cmsSchema = {");
  if (orderedComponents.length) {
    lines.push("  components: {");
    for (const component of orderedComponents) {
      lines.push(`    ${JSON.stringify(component.name)}: {`);
      lines.push("      fields: {");
      for (const [name, field] of Object.entries(component.fields).sort(([a], [b]) => a.localeCompare(b))) {
        const metadata = fieldMetadata(field);
        lines.push(`        ${JSON.stringify(name)}: ${JSON.stringify(metadata)},`);
      }
      lines.push("      }");
      lines.push("    },");
    }
    lines.push("  },");
  }
  lines.push("  collections: {");
  for (const collection of orderedCollections) {
    lines.push(`    ${JSON.stringify(collection.name)}: {`);
    lines.push("      fields: {");
    for (const [name, field] of Object.entries(collection.fields).sort(([a], [b]) => a.localeCompare(b))) {
      const metadata = fieldMetadata(field);
      lines.push(`        ${JSON.stringify(name)}: ${JSON.stringify(metadata)},`);
    }
    lines.push("      }");
    lines.push("    },");
  }
  lines.push("  }");
  lines.push("} as const;", "");

  for (const component of orderedComponents) {
    const componentTypeName = toPascalCase(component.name);
    lines.push(`export type ${componentTypeName} = {`);
    for (const [name, field] of Object.entries(component.fields).sort(([a], [b]) => a.localeCompare(b))) {
      if (field.private) continue;
      const optional = field.required ? "" : "?";
      lines.push(`  ${JSON.stringify(name)}${optional}: ${fieldType(field)};`);
    }
    lines.push("};", "");
    lines.push(`export type ${componentTypeName}Input = {`);
    for (const [name, field] of Object.entries(component.fields).sort(([a], [b]) => a.localeCompare(b))) {
      const optional = field.required ? "" : "?";
      lines.push(`  ${JSON.stringify(name)}${optional}: ${inputFieldType(field)};`);
    }
    lines.push("};", "");
  }

  for (const collection of orderedCollections) {
    const typeName = toPascalCase(collection.name);
    lines.push(`export type ${typeName} = {`);
    for (const [name, field] of Object.entries(collection.fields).sort(([a], [b]) => a.localeCompare(b))) {
      if (field.private) continue;
      const optional = field.required ? "" : "?";
      if (field.kind === "relation") {
        lines.push(`  ${JSON.stringify(name)}?: ${isManyRelation(field) ? `${toPascalCase(field.target)}[]` : toPascalCase(field.target)};`);
        if (relationHasLocalIdField(field)) {
          lines.push(`  ${JSON.stringify(`${name}Id`)}${optional}: ${isManyRelation(field) ? "ID[]" : "ID"};`);
        }
      } else {
        lines.push(`  ${JSON.stringify(name)}${optional}: ${fieldType(field)};`);
      }
    }
    lines.push("  id: ID;");
    lines.push("  createdAt: string;");
    lines.push("  updatedAt: string;");
    if (collection.options.draftAndPublish) {
      lines.push("  status: 'draft' | 'published';");
      lines.push("  publishedAt?: string | null;");
    }
    if (collection.options.i18n) {
      lines.push(`  locale?: ${localeUnion(collection)};`);
      lines.push("  translatedBy?: LocaleTranslatedBy;");
      lines.push("  translationStatus?: LocaleVariantStatus;");
      lines.push("  translatedAt?: string;");
    }
    lines.push("};", "");
    const populatedFields: string[] = [];
    const relationKeys: string[] = [];
    const createFields: string[] = [];
    for (const [name, field] of Object.entries(collection.fields).sort(([a], [b]) => a.localeCompare(b))) {
      if (field.kind === "relation") {
        relationKeys.push(JSON.stringify(name));
        if (!field.private) populatedFields.push(`  ${JSON.stringify(name)}: ${isManyRelation(field) ? `${toPascalCase(field.target)}[]` : toPascalCase(field.target)};`);
      }
      const inputName = field.kind === "relation" ? relationInputFieldName(name, field) : name;
      if (!inputName) continue;
      const optional = field.required ? "" : "?";
      const inputType = inputFieldType(field);
      createFields.push(`  ${JSON.stringify(inputName)}${optional}: ${inputType};`);
    }
    if (populatedFields.length) {
      lines.push(`export type ${typeName}Populated = ${typeName} & {\n${populatedFields.join("\n")}\n};`, "");
    }
    lines.push(`export type ${typeName}RelationKey = ${relationKeys.length ? relationKeys.join(" | ") : "never"};`);
    if (collection.options.i18n) {
      lines.push(`export type ${typeName}Locale = ${localeUnion(collection)};`);
      lines.push(`export type ${typeName}MutableLocale = ${mutableLocaleUnion(collection)};`);
      lines.push(`export type ${typeName}LocaleStatus = LocaleStatusResponse<${typeName}Locale>;`);
      lines.push(`export type ${typeName}TranslationVariant = TranslationVariant<${typeName}Locale, ${typeName}>;`);
    }
    lines.push(`export type ${typeName}Query = QueryParams<${typeName}, ${typeName}RelationKey${collection.options.i18n ? `, ${typeName}Locale` : ""}>;`);
    lines.push(`export type ${typeName}Result<Query> = ${populatedFields.length ? `PopulatedResult<${typeName}, ${typeName}Populated, Query>` : typeName};`);
    lines.push(`export type ${typeName}CreateInput = {\n${createFields.join("\n")}\n};`);
    lines.push(`export type ${typeName}UpdateInput = Partial<${typeName}CreateInput>;`, "");
    lines.push(`export function build${typeName}Query(query: ${typeName}Query = {}): string {`);
    lines.push(`  return buildQuery<${typeName}, ${typeName}RelationKey${collection.options.i18n ? `, ${typeName}Locale` : ""}>(query);`);
    lines.push("}", "");
  }

  lines.push("export type CMSContent = {");
  for (const collection of orderedCollections) {
    lines.push(`  ${JSON.stringify(collection.name)}: ${toPascalCase(collection.name)};`);
  }
  lines.push("};", "");
  lines.push("export type CMSClient = {");
  lines.push("  media: {");
  lines.push("    findMany(query?: { limit?: number; cursor?: string }): Promise<PaginatedResponse<MediaRecord>>;");
  lines.push("    upload(file: File): Promise<MediaRecord>;");
  lines.push("    presign(input: MediaPresignInput): Promise<MediaPresign>;");
  lines.push("    confirm(input: MediaConfirmInput): Promise<MediaRecord>;");
  lines.push("    delete(id: ID): Promise<void>;");
  lines.push("  };");
  lines.push("  previewTokens: {");
  lines.push("    create(input: PreviewTokenRequest<keyof CMSContent & string>): Promise<PreviewToken>;");
  lines.push("    revoke(token: string): Promise<void>;");
  lines.push("  };");
  lines.push("  liveness(): Promise<LivenessReport>;");
  lines.push("  readiness(): Promise<HealthReport>;");
  lines.push("  health(): Promise<HealthReport>;");
  lines.push("  schema(): Promise<SchemaMetadata<keyof CMSContent & string>>;");
  lines.push("  contentTypes: {");
  lines.push("    capabilities(): Promise<ContentTypeCapabilities>;");
  lines.push("    findMany(): Promise<ContentTypeListResponse<keyof CMSContent & string>>;");
  lines.push("    create(input: ContentTypeInput): Promise<ContentTypeWriteResponse>;");
  lines.push("    update(name: string, input: ContentTypeInput): Promise<ContentTypeWriteResponse>;");
  lines.push("  };");
  lines.push("  auditLog(query?: AuditLogQuery): Promise<PaginatedResponse<AuditEntry>>;");
  lines.push("  auditLogCsv(query?: AuditLogQuery): Promise<string>;");
  lines.push("  webhooks: {");
  lines.push("    findMany(): Promise<WebhookListResponse>;");
  lines.push("    create(input: WebhookInput): Promise<WebhookRecord>;");
  lines.push("    update(id: ID, input: WebhookUpdateInput): Promise<WebhookRecord>;");
  lines.push("    replace(id: ID, input: WebhookInput): Promise<WebhookRecord>;");
  lines.push("    delete(id: ID): Promise<void>;");
  lines.push("    deliveries(id: ID, query?: { limit?: number; cursor?: string }): Promise<PaginatedResponse<WebhookDelivery>>;");
  lines.push("    retryDelivery(id: ID, deliveryId: ID): Promise<WebhookDelivery>;");
  lines.push("    test(id: ID): Promise<WebhookDelivery>;");
  lines.push("  };");
  lines.push("  apiKeys: {");
  lines.push("    findMany(): Promise<ApiKeyListResponse>;");
  lines.push("    create(input: ApiKeyInput): Promise<ApiKeyCreateResponse>;");
  lines.push("    update(id: ID, input: ApiKeyUpdateInput): Promise<ApiKeyRecord>;");
  lines.push("    delete(id: ID): Promise<void>;");
  lines.push("  };");
  for (const collection of orderedCollections) {
    const typeName = toPascalCase(collection.name);
    lines.push(`  ${JSON.stringify(collection.name)}: {`);
    lines.push(`    findMany<const Query extends ${typeName}Query | undefined = undefined>(query?: Query): Promise<PaginatedResponse<${typeName}Result<Query>>>;`);
    lines.push(`    findOne<const Query extends ${typeName}Query | undefined = undefined>(id: ID, query?: Query): Promise<${typeName}Result<Query> | null>;`);
    lines.push(`    create(input: ${typeName}CreateInput): Promise<${typeName}>;`);
    lines.push(`    update(id: ID, input: ${typeName}UpdateInput): Promise<${typeName}>;`);
    lines.push("    delete(id: ID): Promise<void>;");
    if (collection.options.draftAndPublish) {
      lines.push(`    publish(id: ID): Promise<${typeName}>;`);
      lines.push(`    unpublish(id: ID): Promise<${typeName}>;`);
      lines.push(`    schedule(id: ID, input: SchedulePublishInput): Promise<${typeName}>;`);
      lines.push(`    unschedule(id: ID): Promise<${typeName}>;`);
    }
    if (collection.options.i18n) {
      lines.push(`    locales(id: ID): Promise<${typeName}LocaleStatus>;`);
      lines.push(`    translate(id: ID, input: TranslateInput<${typeName}Locale>): Promise<${typeName}TranslationVariant>;`);
      lines.push(`    reviewLocale(id: ID, locale: ${typeName}MutableLocale, input?: LocaleReviewInput): Promise<${typeName}TranslationVariant>;`);
      lines.push(`    updateLocale(id: ID, locale: ${typeName}MutableLocale, input: ${typeName}UpdateInput): Promise<${typeName}TranslationVariant>;`);
    }
    lines.push("  };");
  }
  lines.push("};", "");
  lines.push("export function createCMSClient(options: ClientOptions): CMSClient {");
  lines.push("  return {");
  lines.push("    media: {");
  lines.push("      findMany: (query?: { limit?: number; cursor?: string }) => {");
  lines.push("        const params = new URLSearchParams();");
  lines.push("        if (query?.limit) params.set('limit', String(query.limit));");
  lines.push("        if (query?.cursor) params.set('cursor', query.cursor);");
  lines.push("        return request<PaginatedResponse<MediaRecord>>(options, `/api/media?${params.toString()}`);");
  lines.push("      },");
  lines.push("      upload: (file: File) => {");
  lines.push("        const body = new FormData();");
  lines.push("        body.set('file', file);");
  lines.push("        return request<MediaRecord>(options, '/api/media', { method: 'POST', body }, false);");
  lines.push("      },");
  lines.push("      presign: (input: MediaPresignInput) => request<MediaPresign>(options, '/api/media/presign', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      confirm: (input: MediaConfirmInput) => request<MediaRecord>(options, '/api/media/confirm', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      delete: (id: ID) => request<void>(options, `/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),");
  lines.push("    },");
  lines.push("    previewTokens: {");
  lines.push("      create: (input: PreviewTokenRequest<keyof CMSContent & string>) => request<PreviewToken>(options, '/api/preview-tokens', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      revoke: (token: string) => request<void>(options, `/api/preview-tokens/${encodeURIComponent(token)}`, { method: 'DELETE' }),");
  lines.push("    },");
  lines.push("    liveness: () => request<LivenessReport>(options, '/cms/health/live'),");
  lines.push("    readiness: () => request<HealthReport>(options, '/cms/health/ready'),");
  lines.push("    health: () => request<HealthReport>(options, '/cms/health'),");
  lines.push("    schema: () => request<SchemaMetadata<keyof CMSContent & string>>(options, '/cms/schema'),");
  lines.push("    contentTypes: {");
  lines.push("      capabilities: () => request<ContentTypeCapabilities>(options, '/cms/content-types/capabilities'),");
  lines.push("      findMany: () => request<ContentTypeListResponse<keyof CMSContent & string>>(options, '/cms/content-types'),");
  lines.push("      create: (input: ContentTypeInput) => request<ContentTypeWriteResponse>(options, '/cms/content-types', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      update: (name: string, input: ContentTypeInput) => request<ContentTypeWriteResponse>(options, `/cms/content-types/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(input) }),");
  lines.push("    },");
  lines.push("    auditLog: (query?: AuditLogQuery) => request<PaginatedResponse<AuditEntry>>(options, `/cms/audit-log?${buildFlatQuery(query)}`),");
  lines.push("    auditLogCsv: (query?: AuditLogQuery) => requestText(options, `/cms/audit-log?${buildFlatQuery({ ...query, format: 'csv' })}`),");
  lines.push("    webhooks: {");
  lines.push("      findMany: () => request<WebhookListResponse>(options, '/cms/settings/webhooks'),");
  lines.push("      create: (input: WebhookInput) => request<WebhookRecord>(options, '/cms/settings/webhooks', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      update: (id: ID, input: WebhookUpdateInput) => request<WebhookRecord>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),");
  lines.push("      replace: (id: ID, input: WebhookInput) => request<WebhookRecord>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),");
  lines.push("      delete: (id: ID) => request<void>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),");
  lines.push("      deliveries: (id: ID, query?: { limit?: number; cursor?: string }) => request<PaginatedResponse<WebhookDelivery>>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}/deliveries?${buildFlatQuery(query)}`),");
  lines.push("      retryDelivery: (id: ID, deliveryId: ID) => request<WebhookDelivery>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`, { method: 'POST' }),");
  lines.push("      test: (id: ID) => request<WebhookDelivery>(options, `/cms/settings/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' }),");
  lines.push("    },");
  lines.push("    apiKeys: {");
  lines.push("      findMany: () => request<ApiKeyListResponse>(options, '/cms/settings/api-keys'),");
  lines.push("      create: (input: ApiKeyInput) => request<ApiKeyCreateResponse>(options, '/cms/settings/api-keys', { method: 'POST', body: JSON.stringify(input) }),");
  lines.push("      update: (id: ID, input: ApiKeyUpdateInput) => request<ApiKeyRecord>(options, `/cms/settings/api-keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),");
  lines.push("      delete: (id: ID) => request<void>(options, `/cms/settings/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),");
  lines.push("    },");
  for (const collection of orderedCollections) {
    const typeName = toPascalCase(collection.name);
    lines.push(`    ${JSON.stringify(collection.name)}: {`);
    lines.push(`      findMany: <const Query extends ${typeName}Query | undefined = undefined>(query?: Query) => request<PaginatedResponse<${typeName}Result<Query>>>(options, \`/api/${collection.name}?\${buildQuery(query)}\`),`);
    lines.push(`      findOne: async <const Query extends ${typeName}Query | undefined = undefined>(id: ID, query?: Query) => {`);
    lines.push(`        try { return await request<${typeName}Result<Query>>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}?\${buildQuery(query)}\`); }`);
    lines.push("        catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }");
    lines.push("      },");
    lines.push(`      create: (input: ${typeName}CreateInput) => request<${typeName}>(options, "/api/${collection.name}", { method: "POST", body: JSON.stringify(input) }),`);
    lines.push(`      update: (id: ID, input: ${typeName}UpdateInput) => request<${typeName}>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}\`, { method: "PATCH", body: JSON.stringify(input) }),`);
    lines.push(`      delete: (id: ID) => request<void>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}\`, { method: "DELETE" }),`);
    if (collection.options.draftAndPublish) {
      lines.push(`      publish: (id: ID) => request<${typeName}>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/publish\`, { method: "POST" }),`);
      lines.push(`      unpublish: (id: ID) => request<${typeName}>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/unpublish\`, { method: "POST" }),`);
      lines.push(`      schedule: (id: ID, input: SchedulePublishInput) => request<${typeName}>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/schedule\`, { method: "POST", body: JSON.stringify({ publishAt: input.publishAt instanceof Date ? input.publishAt.toISOString() : input.publishAt }) }),`);
      lines.push(`      unschedule: (id: ID) => request<${typeName}>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/unschedule\`, { method: "POST" }),`);
    }
    if (collection.options.i18n) {
      lines.push(`      locales: (id: ID) => request<${typeName}LocaleStatus>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/locales\`),`);
      lines.push(`      translate: (id: ID, input: TranslateInput<${typeName}Locale>) => request<${typeName}TranslationVariant>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/translate\`, { method: "POST", body: JSON.stringify(input) }),`);
      lines.push(`      reviewLocale: (id: ID, locale: ${typeName}MutableLocale, input: LocaleReviewInput = { translatedBy: "human" }) => request<${typeName}TranslationVariant>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/locales/\${encodeURIComponent(locale)}\`, { method: "PATCH", body: JSON.stringify(input) }),`);
      lines.push(`      updateLocale: (id: ID, locale: ${typeName}MutableLocale, input: ${typeName}UpdateInput) => request<${typeName}TranslationVariant>(options, \`/api/${collection.name}/\${encodeURIComponent(id)}/locales/\${encodeURIComponent(locale)}\`, { method: "PUT", body: JSON.stringify(input) }),`);
    }
    lines.push("    },");
  }
  lines.push("  };");
  lines.push("}", "");

  return `${lines.join("\n")}\n`;
}

export function generateOpenAPISchemas(collections: CMSCollections, components: CMSComponents = getSchemaComponents(collections)): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [componentName, component] of Object.entries(components)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, field] of Object.entries(component.fields)) {
      if (!field.private) properties[name] = openAPIField(field);
      if (field.required && !field.private) required.push(name);
    }
    schemas[toPascalCase(componentName)] = {
      type: "object",
      properties,
      required,
      additionalProperties: false
    };
  }
  for (const collection of Object.values(collections)) {
    const collectionName = toPascalCase(collection.name);
    const properties: Record<string, unknown> = {
      id: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }
    };
    const required = ["id", "createdAt", "updatedAt"];
    const createProperties: Record<string, unknown> = {};
    const createRequired: string[] = [];

    for (const [name, field] of Object.entries(collection.fields)) {
      if (!field.private) properties[name] = openAPIField(field);
      const inputName = field.kind === "relation" ? relationInputFieldName(name, field) : name;
      if (inputName) {
        createProperties[inputName] = openAPIInputField(field);
      }
      if (field.required && !field.private) {
        required.push(name);
      }
      if (field.required && inputName) {
        createRequired.push(inputName);
      }
    }

    schemas[collectionName] = {
      type: "object",
      properties,
      required,
      additionalProperties: false
    };
    schemas[`${collectionName}CreateInput`] = {
      type: "object",
      properties: createProperties,
      required: createRequired,
      additionalProperties: false
    };
    schemas[`${collectionName}UpdateInput`] = {
      type: "object",
      properties: createProperties,
      required: [],
      additionalProperties: false
    };
  }
  return schemas;
}

function fieldType(field: FieldDefinition): string {
  switch (field.kind) {
    case "string":
    case "text":
    case "richtext":
    case "datetime":
    case "date":
    case "time":
    case "email":
    case "url":
    case "password":
    case "uid":
      return "string";
    case "media":
      return field.multiple ? "MediaFile[] | ID[]" : "MediaFile | ID";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
      return "Record<string, unknown>";
    case "enum":
      return field.values.map((value) => JSON.stringify(value)).join(" | ");
    case "relation":
      return isManyRelation(field) ? `${toPascalCase(field.target)}[] | ID[]` : `${toPascalCase(field.target)} | ID`;
    case "component": {
      const componentType = toPascalCase(field.component);
      return field.repeatable ? `${componentType}[]` : componentType;
    }
    case "dynamiczone": {
      const variants = field.components.length
        ? field.components.map((name) => toPascalCase(name)).join(" | ")
        : "Record<string, unknown>";
      return `Array<${variants}>`;
    }
  }
}

function inputFieldType(field: FieldDefinition): string {
  if (field.kind === "relation") return isManyRelation(field) ? "ID[]" : "ID";
  if (field.kind === "media") return field.multiple ? "ID[]" : "ID";
  if (field.kind === "component") {
    const componentType = `${toPascalCase(field.component)}Input`;
    return field.repeatable ? `${componentType}[]` : componentType;
  }
  return fieldType(field);
}

function localeUnion(collection: CollectionDefinition<string, FieldsDefinition>): string {
  return collection.options.i18n?.locales.map((locale) => JSON.stringify(locale)).join(" | ") ?? "string";
}

function mutableLocaleUnion(collection: CollectionDefinition<string, FieldsDefinition>): string {
  const locales = collection.options.i18n?.locales.filter((locale) => locale !== collection.options.i18n?.defaultLocale) ?? [];
  return locales.length ? locales.map((locale) => JSON.stringify(locale)).join(" | ") : "never";
}

function hashSchema(collections: CMSCollections, components: CMSComponents = {}): string {
  const input = JSON.stringify({
    collections: Object.values(collections).sort((a, b) => a.name.localeCompare(b.name)),
    components: Object.values(components).sort((a, b) => a.name.localeCompare(b.name))
  });
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function openAPIField(field: FieldDefinition): unknown {
  const metadata = fieldMetadata(field);
  const extensions: Record<string, unknown> = {};
  if (metadata.private) extensions["x-cms-private"] = true;
  if (metadata.permissions) extensions["x-cms-permissions"] = metadata.permissions;
  const schema = (() => {
    switch (field.kind) {
    case "media":
      return field.multiple
        ? { type: "array", items: { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/MediaRecord" }] } }
        : { oneOf: [{ type: "string" }, { $ref: "#/components/schemas/MediaRecord" }] };
    case "string":
    case "text":
    case "richtext":
      return { type: "string" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "date":
      return { type: "string", format: "date" };
    case "time":
      return { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,9})?)?$" };
    case "email":
      return { type: "string", format: "email" };
    case "url":
      return { type: "string", format: "uri" };
    case "password":
      return { type: "string", format: "password", writeOnly: true };
    case "uid":
      return { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "json":
      return {};
    case "enum":
      return { type: "string", enum: field.values };
    case "relation": {
      const value = { oneOf: [{ type: "string" }, { $ref: `#/components/schemas/${toPascalCase(field.target)}` }] };
      return isManyRelation(field)
        ? { type: "array", items: value }
        : value;
    }
    case "component": {
      const itemSchema = { $ref: `#/components/schemas/${toPascalCase(field.component)}` };
      return field.repeatable
        ? { type: "array", items: itemSchema }
        : itemSchema;
    }
    case "dynamiczone": {
      const variants = field.components.map((name) => ({ $ref: `#/components/schemas/${toPascalCase(name)}` }));
      const itemSchema = variants.length === 1 ? variants[0]! : { oneOf: variants, discriminator: { propertyName: "__component" } };
      return { type: "array", items: itemSchema };
    }
    }
  })();
  return Object.keys(extensions).length ? { ...schema, ...extensions } : schema;
}

function openAPIInputField(field: FieldDefinition): unknown {
  const schema = openAPIField(field);
  if (field.kind === "media") {
    const extensions = typeof schema === "object" && schema !== null ? Object.fromEntries(Object.entries(schema).filter(([key]) => key.startsWith("x-"))) : {};
    return field.multiple
      ? { type: "array", items: { type: "string" }, ...extensions }
      : { type: "string", ...extensions };
  }
  if (field.kind !== "relation") return schema;
  const extensions = typeof schema === "object" && schema !== null ? Object.fromEntries(Object.entries(schema).filter(([key]) => key.startsWith("x-"))) : {};
  return isManyRelation(field)
    ? { type: "array", items: { type: "string" }, ...extensions }
    : { type: "string", ...extensions };
}

function fieldMetadata(field: FieldDefinition): {
  kind: FieldKind;
  private?: true;
  permissions?: FieldPermissions;
  targetField?: string;
  component?: string;
  repeatable?: boolean;
  components?: readonly string[];
} {
  const metadata: {
    kind: FieldKind;
    private?: true;
    permissions?: FieldPermissions;
    targetField?: string;
    component?: string;
    repeatable?: boolean;
    components?: readonly string[];
  } = { kind: field.kind };
  if (field.private) metadata.private = true;
  if (field.permissions) metadata.permissions = field.permissions;
  if (field.kind === "uid" && field.targetField) metadata.targetField = field.targetField;
  if (field.kind === "component") {
    metadata.component = field.component;
    if (field.repeatable) metadata.repeatable = true;
  }
  if (field.kind === "dynamiczone") metadata.components = field.components;
  return metadata;
}

export function isManyRelation(field: RelationField<string, RelationCardinality, boolean>): boolean {
  return field.cardinality === "many" || field.cardinality === "one-to-many" || field.cardinality === "many-to-many";
}

export function relationHasLocalIdField(field: RelationField<string, RelationCardinality, boolean>): boolean {
  return field.cardinality !== "one-to-many" && field.cardinality !== "many-to-many";
}

function relationInputFieldName(name: string, field: RelationField<string, RelationCardinality, boolean>): string | null {
  if (relationHasLocalIdField(field)) return `${name}Id`;
  if (field.cardinality === "many-to-many") return name;
  return null;
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

export type {
  AdapterCapabilities,
  ContentRecord,
  ContentStatus,
  DatabaseAdapter,
  FieldFilter,
  HealthStatus,
  ID,
  MigrationFile,
  PaginatedResult,
  PopulateMap,
  PopulateNode,
  QueryParams,
  SchemaDiff
} from "./adapter";
export { AdapterCapabilityError, CMSConfigError } from "./errors";
export type { CreateSchemaSnapshotOptions, SchemaChange, SchemaPlan, SchemaSnapshot, SystemTableSnapshot } from "./migrations";
export { assertNoReservedSystemTableConflicts, createSchemaSnapshot, formatSchemaPlan, planSchemaMigration } from "./migrations";
export type { SubsystemHealth } from "./health";
