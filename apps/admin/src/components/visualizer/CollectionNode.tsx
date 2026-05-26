import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { Handle, NodeResizer, Position, useConnection, type NodeProps } from "@xyflow/react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  CircleDot,
  CircleDotDashed,
  Copy,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  Table2,
  X
} from "lucide-react";
import { toast } from "sonner";
import type { CollectionNode as CollectionNodeShape } from "../../lib/visualizer/types";
import { COLLECTION_MINIMIZED_FIELDS } from "../../lib/visualizer/types";
import { DEFAULT_COLLECTION_COLOR } from "./ColorPicker";
import type { AdminSchemaField, ContentTypeInput } from "../../lib/api-client";
import { useCollectionNodeApi } from "./CollectionNodeContext";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------- */
/* Field-row helpers                                                  */
/* ----------------------------------------------------------------- */

const KIND_SHORT: Partial<Record<AdminSchemaField["kind"], string>> = {
  string: "string",
  text: "text",
  richtext: "richtext",
  number: "number",
  boolean: "bool",
  datetime: "datetime",
  date: "date",
  time: "time",
  json: "json",
  email: "email",
  url: "url",
  password: "password",
  uid: "uid",
  enum: "enum",
  media: "media",
  relation: "relation",
  component: "component",
  dynamiczone: "zone"
};

const FIELD_KINDS: AdminSchemaField["kind"][] = [
  "string",
  "text",
  "richtext",
  "number",
  "boolean",
  "datetime",
  "date",
  "time",
  "json",
  "email",
  "url",
  "password",
  "uid",
  "enum",
  "media",
  "relation",
  "component",
  "dynamiczone"
];

const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Handle id prefixes — chartdb uses left_/right_ pairs so connections
 * snap onto the closer edge of the source/target. We mirror that here.
 */
export const LEFT_HANDLE_ID_PREFIX = "left_rel_";
export const RIGHT_HANDLE_ID_PREFIX = "right_rel_";
export const TARGET_HANDLE_ID_PREFIX = "target_rel_";

function isPrimaryKey(name: string, field: AdminSchemaField): boolean {
  return field.kind === "uid" || name === "id";
}

type FieldRowProps = {
  collectionName: string;
  name: string;
  field: AdminSchemaField;
  focused: boolean;
  isForeignKey: boolean;
};

function FieldRow({ collectionName, name, field, focused, isForeignKey }: FieldRowProps) {
  const connection = useConnection();
  const isRelation = field.kind === "relation";
  const isPk = isPrimaryKey(name, field);
  const kindLabel = isRelation
    ? `→ ${field.target ?? ""}`
    : field.kind === "enum"
    ? `enum(${(field.values ?? []).length})`
    : field.kind === "component"
    ? `${field.repeatable ? "[]" : ""}${field.component ?? "component"}`
    : field.kind === "dynamiczone"
    ? `zone(${(field.components ?? []).length})`
    : KIND_SHORT[field.kind] ?? field.kind;

  const isTarget =
    connection.inProgress &&
    connection.fromNode?.id !== collectionName &&
    (connection.fromHandle?.id?.startsWith(RIGHT_HANDLE_ID_PREFIX) ||
      connection.fromHandle?.id?.startsWith(LEFT_HANDLE_ID_PREFIX));

  const copyName = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      void navigator.clipboard?.writeText(name).catch(() => undefined);
    },
    [name]
  );

  return (
    <div
      className={cn(
        "hcms-field-row group",
        isRelation && "hcms-field-row--relation",
        isPk && "hcms-field-row--pk",
        isForeignKey && "hcms-field-row--fk"
      )}
      data-kind={field.kind}
    >
      {/* Source handles — both sides for snap-to-nearest. Visible only when node is focused. */}
      <Handle
        id={`${RIGHT_HANDLE_ID_PREFIX}${name}`}
        type="source"
        position={Position.Right}
        className={cn(
          "hcms-field-handle",
          (!focused || isTarget) && "hcms-field-handle--hidden"
        )}
      />
      <Handle
        id={`${LEFT_HANDLE_ID_PREFIX}${name}`}
        type="source"
        position={Position.Left}
        className={cn(
          "hcms-field-handle",
          (!focused || isTarget) && "hcms-field-handle--hidden"
        )}
      />
      {/* Target handle — overlays the row when another node is dragging a connection. */}
      <Handle
        id={`${TARGET_HANDLE_ID_PREFIX}${name}`}
        type="target"
        position={Position.Left}
        className={
          isTarget
            ? "hcms-field-target-overlay"
            : "hcms-field-handle hcms-field-handle--hidden"
        }
      />

      <span className="hcms-field-icon" aria-hidden>
        {isPk ? (
          <KeyRound size={12} strokeWidth={2} />
        ) : isForeignKey ? (
          <ArrowRightLeft size={12} strokeWidth={2} />
        ) : null}
      </span>
      <span className="hcms-field-name" title={name}>
        {name}
      </span>
      <span className="hcms-field-kind">{kindLabel}</span>
      <span className="hcms-field-state" aria-hidden>
        {field.required ? (
          <CircleDot size={11} strokeWidth={2.4} aria-label="Required" />
        ) : (
          <CircleDotDashed size={11} strokeWidth={2} aria-label="Nullable" />
        )}
      </span>
      <button
        type="button"
        className="hcms-field-copy"
        onClick={copyName}
        aria-label={`Copy field name ${name}`}
        title="Copy field name"
      >
        <Copy size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Inline editable field row                                          */
/* ----------------------------------------------------------------- */

type DraftField = {
  /** Stable key used for React iteration; equals originalName for existing fields. */
  key: string;
  /** Original field key before any rename, or "" for newly added fields. */
  originalName: string;
  name: string;
  field: AdminSchemaField;
  removed?: boolean;
};

function buildInitialDrafts(fields: Record<string, AdminSchemaField>): DraftField[] {
  return Object.entries(fields).map(([name, field]) => ({
    key: name,
    originalName: name,
    name,
    field
  }));
}

function defaultFieldOfKind(kind: AdminSchemaField["kind"]): AdminSchemaField {
  return {
    kind,
    required: false,
    unique: false,
    localized: false,
    private: false
  };
}

/**
 * Stop the editor's keyboard events from bubbling to React Flow (which would
 * otherwise treat Backspace/Delete as "delete selected node" while we type).
 */
function swallow(event: KeyboardEvent<HTMLElement> | MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

type EditableFieldRowProps = {
  draft: DraftField;
  onChange: (patch: Omit<Partial<DraftField>, "field"> & { field?: Partial<AdminSchemaField> }) => void;
  onToggleRemove: () => void;
};

function EditableFieldRow({ draft, onChange, onToggleRemove }: EditableFieldRowProps) {
  return (
    <div
      className={cn("hcms-node-edit-row", draft.removed && "hcms-node-edit-row--removed")}
      onMouseDown={swallow}
      onKeyDown={swallow}
    >
      <input
        className="hcms-node-edit-input hcms-node-edit-input--name"
        value={draft.name}
        onChange={(event) => onChange({ name: event.currentTarget.value })}
        placeholder="fieldName"
        spellCheck={false}
        autoComplete="off"
        disabled={draft.removed}
        aria-label="Field name"
      />
      <select
        className="hcms-node-edit-input hcms-node-edit-input--kind"
        value={draft.field.kind}
        onChange={(event) =>
          onChange({ field: { kind: event.currentTarget.value as AdminSchemaField["kind"] } })
        }
        disabled={draft.removed}
        aria-label="Field kind"
      >
        {FIELD_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </select>
      <label
        className="hcms-node-edit-toggle"
        title="Required"
        onMouseDown={swallow}
      >
        <input
          type="checkbox"
          checked={Boolean(draft.field.required)}
          onChange={(event) => onChange({ field: { required: event.currentTarget.checked } })}
          disabled={draft.removed}
        />
        <span>REQ</span>
      </label>
      <button
        type="button"
        className={cn(
          "hcms-node-edit-remove",
          draft.removed && "hcms-node-edit-remove--undo"
        )}
        onClick={onToggleRemove}
        aria-label={draft.removed ? "Undo remove" : "Remove field"}
        title={draft.removed ? "Undo remove" : "Remove field"}
      >
        {draft.removed ? "↶" : <X size={12} strokeWidth={2.2} />}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- */
/* Collection node                                                    */
/* ----------------------------------------------------------------- */

export const CollectionNode = memo(function CollectionNode({
  data,
  selected,
  dragging,
  id
}: NodeProps<CollectionNodeShape>) {
  const { collection, color, expanded: expandedFromData } = data;
  const api = useCollectionNodeApi();
  const editing = api.editingCollection === collection.name && api.writable;
  const [expanded, setExpanded] = useState<boolean>(expandedFromData ?? true);
  const focused = (selected && !dragging) ?? false;

  // Local rename state — applied on blur/Enter.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);

  // Inline edit drafts — re-initialised whenever we enter edit mode or the
  // collection's field set changes underneath us (e.g. after a save).
  const [drafts, setDrafts] = useState<DraftField[]>(() =>
    buildInitialDrafts(collection.fields)
  );
  const [editError, setEditError] = useState<string | null>(null);
  const newFieldCounter = useRef(0);

  useEffect(() => {
    if (editing) {
      setDrafts(buildInitialDrafts(collection.fields));
      setEditError(null);
      newFieldCounter.current = 0;
    }
  }, [editing, collection.fields]);

  const fields = useMemo(() => Object.entries(collection.fields), [collection.fields]);
  const options = collection.options ?? {};

  /**
   * A field is treated as a foreign-key on this collection when it is a
   * relation field — the source side always owns the FK reference.
   */
  const fkFields = useMemo(() => {
    const set = new Set<string>();
    for (const [name, field] of fields) {
      if (field.kind === "relation") set.add(name);
    }
    return set;
  }, [fields]);

  const visibleFields = useMemo(() => {
    if (expanded || fields.length <= COLLECTION_MINIMIZED_FIELDS) return fields;
    // Prefer PK + FK rows when collapsed (mirrors chartdb's TABLE_MINIMIZED_FIELDS behavior).
    const must: typeof fields = [];
    const rest: typeof fields = [];
    for (const entry of fields) {
      const [name, field] = entry;
      if (isPrimaryKey(name, field) || field.kind === "relation") must.push(entry);
      else rest.push(entry);
    }
    return [...must, ...rest].slice(0, COLLECTION_MINIMIZED_FIELDS);
  }, [expanded, fields]);

  const accentColor = color ?? DEFAULT_COLLECTION_COLOR;
  const fieldCount = fields.length;
  const toggleExpand = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      setExpanded((prev) => !prev);
    },
    []
  );

  const showChips = Boolean(options.draftAndPublish || options.i18n);

  /* ------------------ inline edit handlers ------------------ */

  const addDraftField = useCallback(() => {
    newFieldCounter.current += 1;
    const idx = newFieldCounter.current;
    setDrafts((current) => {
      let candidate = `newField${idx}`;
      let suffix = idx;
      while (current.some((f) => !f.removed && f.name === candidate)) {
        suffix += 1;
        candidate = `newField${suffix}`;
      }
      return [
        ...current,
        {
          key: `__new_${Date.now()}_${idx}`,
          originalName: "",
          name: candidate,
          field: defaultFieldOfKind("string")
        }
      ];
    });
  }, []);

  const patchDraft = useCallback(
    (index: number, patch: Omit<Partial<DraftField>, "field"> & { field?: Partial<AdminSchemaField> }) => {
      setDrafts((current) =>
        current.map((entry, i) => {
          if (i !== index) return entry;
          return {
            ...entry,
            ...patch,
            field: { ...entry.field, ...(patch.field ?? {}) }
          };
        })
      );
    },
    []
  );

  const toggleRemoveDraft = useCallback((index: number) => {
    setDrafts((current) =>
      current.map((entry, i) => (i === index ? { ...entry, removed: !entry.removed } : entry))
    );
  }, []);

  const cancelEdit = useCallback(() => {
    setEditError(null);
    api.endEdit();
  }, [api]);

  const submitEdit = useCallback(async () => {
    setEditError(null);
    const surviving = drafts.filter((d) => !d.removed);
    if (surviving.length === 0) {
      setEditError("A collection needs at least one field.");
      return;
    }
    const seen = new Set<string>();
    for (const draft of surviving) {
      if (!IDENTIFIER_RE.test(draft.name)) {
        setEditError(`Invalid field name: "${draft.name}"`);
        return;
      }
      if (seen.has(draft.name)) {
        setEditError(`Duplicate field name: "${draft.name}"`);
        return;
      }
      seen.add(draft.name);
    }
    const input: ContentTypeInput = {
      name: collection.name,
      options: collection.options,
      fields: Object.fromEntries(
        surviving.map((d) => [
          d.name,
          { ...d.field, kind: d.field.kind } as AdminSchemaField & {
            kind: AdminSchemaField["kind"];
          }
        ])
      )
    };
    try {
      await api.saveCollection(input);
      toast.success(`Saved ${collection.name}`);
      api.endEdit();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Save failed";
      setEditError(message);
      toast.error(`Failed to save ${collection.name}: ${message}`);
    }
  }, [api, collection.name, collection.options, drafts]);

  /* ------------------ rename handlers ------------------ */

  const startRename = useCallback(
    (event: MouseEvent) => {
      if (!api.writable) return;
      event.stopPropagation();
      setRenameDraft(collection.name);
    },
    [api.writable, collection.name]
  );

  const commitRename = useCallback(async () => {
    if (renameDraft === null) return;
    const next = renameDraft.trim();
    setRenameDraft(null);
    if (!next || next === collection.name) return;
    if (!IDENTIFIER_RE.test(next)) {
      toast.error(`Invalid collection name: "${next}"`);
      return;
    }
    try {
      await api.renameCollection(collection, next);
      toast.success(`Renamed ${collection.name} → ${next}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Rename failed");
    }
  }, [api, collection, renameDraft]);

  /* ------------------ render ------------------ */

  return (
    <article
      className={cn(
        "hcms-node",
        selected && "hcms-node--selected",
        editing && "hcms-node--editing"
      )}
      data-collection={collection.name}
      aria-label={`Collection ${collection.name}`}
    >
      <NodeResizer
        isVisible={focused && !editing}
        minWidth={240}
        maxWidth={480}
        shouldResize={(event) => event.dy === 0}
        lineClassName="hcms-resize-line"
        handleClassName="hcms-resize-handle"
      />

      {/* Color stripe (4px) — chartdb's signature top edge */}
      <div className="hcms-node-stripe" style={{ background: accentColor }} aria-hidden />

      <header
        className="hcms-node-header"
        style={{ background: `${accentColor}1a` }}
        onDoubleClick={startRename}
        title={api.writable ? "Double-click to rename" : undefined}
      >
        <span className="hcms-node-icon" aria-hidden>
          <Table2 size={14} strokeWidth={2} />
        </span>
        {renameDraft !== null ? (
          <input
            autoFocus
            className="hcms-node-rename-input"
            value={renameDraft}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setRenameDraft(event.currentTarget.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename();
              } else if (event.key === "Escape") {
                setRenameDraft(null);
              }
            }}
            onMouseDown={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="hcms-node-name">{collection.name}</span>
        )}
        <span className="hcms-node-meta">
          {fieldCount} field{fieldCount === 1 ? "" : "s"}
        </span>
        {api.writable && !editing && renameDraft === null ? (
          <button
            type="button"
            className="hcms-node-edit-trigger"
            onClick={(event) => {
              event.stopPropagation();
              api.beginEdit(collection.name);
            }}
            aria-label="Edit fields inline"
            title="Edit fields inline"
          >
            <Pencil size={11} strokeWidth={2.2} />
          </button>
        ) : null}
        <Handle
          id={`node-source-${id}`}
          type="source"
          position={Position.Right}
          className="hcms-node-handle hcms-node-handle--source"
        />
        <Handle
          id={`incoming`}
          type="target"
          position={Position.Left}
          className="hcms-node-handle hcms-node-handle--target"
        />
      </header>

      {showChips ? (
        <div className="hcms-node-chips">
          {options.draftAndPublish ? (
            <span className="hcms-chip" title="Draft + publish workflow">
              Drafts
            </span>
          ) : null}
          {options.i18n ? (
            <span
              className="hcms-chip hcms-chip--neutral"
              title={`Locales: ${options.i18n.locales.join(", ")}`}
            >
              i18n · {options.i18n.locales.length}
            </span>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <div className="hcms-node-edit" onMouseDown={swallow}>
          {drafts.length === 0 ? (
            <p className="hcms-node-empty">No fields yet</p>
          ) : null}
          {drafts.map((draft, index) => (
            <EditableFieldRow
              key={draft.key}
              draft={draft}
              onChange={(patch) => patchDraft(index, patch)}
              onToggleRemove={() => toggleRemoveDraft(index)}
            />
          ))}
          <button
            type="button"
            className="hcms-node-edit-add"
            onClick={addDraftField}
          >
            <Plus size={12} strokeWidth={2.2} />
            Add field
          </button>
          {editError ? <div className="hcms-node-edit-error">{editError}</div> : null}
          <div className="hcms-node-edit-footer">
            <button
              type="button"
              className="hcms-node-edit-cancel"
              onClick={cancelEdit}
              disabled={api.saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="hcms-node-edit-save"
              onClick={() => void submitEdit()}
              disabled={api.saving}
            >
              {api.saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="hcms-node-edit-form"
              onClick={(event) => {
                event.stopPropagation();
                api.openFormView(collection.name);
              }}
              title="Open the form-based editor for advanced options"
            >
              <ExternalLink size={11} strokeWidth={2.2} />
              Open form view
            </button>
          </div>
        </div>
      ) : (
        <div className={cn("hcms-node-body", !expanded && "hcms-node-body--collapsed")}>
          {fields.length === 0 ? (
            <p className="hcms-node-empty">No fields yet</p>
          ) : null}
          {visibleFields.map(([name, field]) => (
            <FieldRow
              key={name}
              collectionName={collection.name}
              name={name}
              field={field}
              focused={focused}
              isForeignKey={fkFields.has(name)}
            />
          ))}
        </div>
      )}

      {!editing && fields.length > COLLECTION_MINIMIZED_FIELDS ? (
        <button
          type="button"
          className="hcms-node-toggle"
          onClick={toggleExpand}
          aria-expanded={expanded}
          aria-controls={`fields-${id}`}
        >
          {expanded ? (
            <>
              <ChevronUp size={12} strokeWidth={2.2} />
              Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} strokeWidth={2.2} />
              Show {fields.length - COLLECTION_MINIMIZED_FIELDS} more
            </>
          )}
        </button>
      ) : null}
    </article>
  );
});

