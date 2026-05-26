import type { AdminSchemaCollection } from "./api-client";

type RenderableField = {
  kind: string;
  required?: boolean;
  private?: boolean;
  values?: readonly string[];
  target?: string;
  cardinality?: string;
  component?: string;
  repeatable?: boolean;
  components?: readonly string[];
};

type RenderableCollection = {
  fields: Record<string, RenderableField>;
  options: AdminSchemaCollection["options"];
};

type RenderableSchema = {
  collections: Record<string, RenderableCollection>;
};

export type FieldRenderModel = {
  name: string;
  label: string;
  control: "text" | "textarea" | "richtext" | "number" | "checkbox" | "select" | "relation" | "media" | "json" | "email" | "url" | "password" | "date" | "time" | "datetime" | "component" | "dynamiczone";
  required: boolean;
  options?: readonly string[];
  relation?: {
    target: string;
    multiple: boolean;
    labelField?: string | null;
  };
  component?: {
    name: string;
    repeatable: boolean;
  };
  dynamicZone?: {
    components: readonly string[];
  };
};

export type FieldFormValues = Record<string, string | boolean>;

export function fieldModels(collection: RenderableCollection, schema?: RenderableSchema): FieldRenderModel[] {
  return Object.entries(collection.fields).map(([name, field]) => {
    const model: FieldRenderModel = {
      name,
      label: labelize(name),
      control: controlFor(field),
      required: field.required === true
    };
    if (field.kind === "enum") model.options = field.values;
    if (field.kind === "relation" && field.target) {
      const targetCollection = schema?.collections[field.target];
      const relation: NonNullable<FieldRenderModel["relation"]> = {
        target: field.target,
        multiple: field.cardinality === "many" || field.cardinality === "many-to-many" || field.cardinality === "one-to-many",
      };
      const labelField = targetCollection ? contentSearchField(targetCollection) : null;
      if (labelField) {
        relation.labelField = labelField;
      }
      model.relation = relation;
    }
    if (field.kind === "component" && field.component) {
      model.component = { name: field.component, repeatable: field.repeatable === true };
    }
    if (field.kind === "dynamiczone") {
      model.dynamicZone = { components: field.components ?? [] };
    }
    return model;
  });
}

export function collectionColumns(collection: RenderableCollection): string[] {
  return ["id", ...Object.keys(collection.fields).slice(0, 4), "updatedAt"];
}

export function supportsDraftWorkflow(collection: RenderableCollection): boolean {
  return collection.options.draftAndPublish === true;
}

export function contentSearchField(collection: RenderableCollection): string | null {
  return Object.entries(collection.fields).find(([, field]) => !field.private && (field.kind === "string" || field.kind === "text" || field.kind === "richtext" || field.kind === "email" || field.kind === "url" || field.kind === "uid"))?.[0] ?? null;
}

export function serializeFormValue(model: FieldRenderModel, value: FormDataEntryValue | null): unknown {
  if (model.control === "checkbox") return value === "on";
  if (value == null) return "";
  if (model.control === "number") return Number(value);
  if (model.control === "relation" && model.relation?.multiple) {
    return String(value).split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (model.control === "json" || model.control === "component" || model.control === "dynamiczone") {
    const text = String(value).trim();
    if (!text) return model.control === "dynamiczone" ? [] : (model.control === "component" && model.component?.repeatable ? [] : {});
    return JSON.parse(text);
  }
  return String(value);
}

export function recordInputFromForm(models: FieldRenderModel[], formData: FormData): Record<string, unknown> {
  return Object.fromEntries(models.map((model) => [model.name, serializeFormValue(model, formData.get(model.name))]));
}

export function formValuesFromRecord(models: FieldRenderModel[], record: Record<string, unknown> | null): FieldFormValues {
  return Object.fromEntries(models.map((model) => [model.name, formValueForModel(model, record?.[model.name])]));
}

export function recordInputFromValues(models: FieldRenderModel[], values: FieldFormValues): Record<string, unknown> {
  return Object.fromEntries(models.map((model) => [model.name, serializeFormValue(model, formDataValueFromState(values[model.name]))]));
}

function formValueForModel(model: FieldRenderModel, value: unknown): string | boolean {
  if (model.control === "checkbox") return Boolean(value);
  if (model.control === "json") return JSON.stringify(value ?? {}, null, 2);
  if (model.control === "component") {
    const fallback = model.component?.repeatable ? [] : {};
    return JSON.stringify(value ?? fallback, null, 2);
  }
  if (model.control === "dynamiczone") return JSON.stringify(value ?? [], null, 2);
  if (model.control === "relation" && model.relation?.multiple && Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

function formDataValueFromState(value: string | boolean | undefined): FormDataEntryValue | null {
  if (typeof value === "boolean") return value ? "on" : null;
  return value ?? "";
}

function controlFor(field: RenderableField): FieldRenderModel["control"] {
  switch (field.kind) {
    case "text":
      return "textarea";
    case "richtext":
      return "richtext";
    case "email":
      return "email";
    case "url":
      return "url";
    case "password":
      return "password";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
      return "datetime";
    case "number":
      return "number";
    case "boolean":
      return "checkbox";
    case "enum":
      return "select";
    case "relation":
      return "relation";
    case "media":
      return "media";
    case "json":
      return "json";
    case "component":
      return "component";
    case "dynamiczone":
      return "dynamiczone";
    default:
      return "text";
  }
}

function labelize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
