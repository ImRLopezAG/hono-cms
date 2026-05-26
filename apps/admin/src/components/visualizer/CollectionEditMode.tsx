import { useEffect, useRef, useState } from "react";
import type { AdminSchemaCollection, AdminSchemaField, ContentTypeInput } from "../../lib/api-client";

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

type DraftField = {
  /** Original field key before any rename, or "" for newly added fields. */
  originalName: string;
  name: string;
  field: AdminSchemaField;
  removed?: boolean;
};

type CollectionEditModeProps = {
  collection: AdminSchemaCollection;
  onSave: (input: ContentTypeInput) => Promise<void>;
  onClose: () => void;
};

export function CollectionEditMode({ collection, onSave, onClose }: CollectionEditModeProps) {
  const [collectionName, setCollectionName] = useState(collection.name);
  const [draftAndPublish, setDraftAndPublish] = useState(Boolean(collection.options.draftAndPublish));
  const [fields, setFields] = useState<DraftField[]>(() =>
    Object.entries(collection.fields).map(([name, field]) => ({
      originalName: name,
      name,
      field
    }))
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addField = () => {
    const baseName = "newField";
    let suffix = 1;
    while (fields.some((f) => f.name === `${baseName}${suffix}`)) suffix++;
    setFields((current) => [
      ...current,
      {
        originalName: "",
        name: `${baseName}${suffix}`,
        field: { kind: "string", required: false, unique: false, localized: false, private: false }
      }
    ]);
  };

  const updateField = (index: number, patch: Omit<Partial<DraftField>, "field"> & { field?: Partial<AdminSchemaField> }) => {
    setFields((current) =>
      current.map((entry, i) => {
        if (i !== index) return entry;
        const next: DraftField = { ...entry, ...patch, field: { ...entry.field, ...(patch.field ?? {}) } };
        return next;
      })
    );
  };

  const removeField = (index: number) => {
    setFields((current) =>
      current.map((entry, i) => (i === index ? { ...entry, removed: !entry.removed } : entry))
    );
  };

  const handleSave = async () => {
    setError(null);
    const nextFields = fields.filter((f) => !f.removed);
    if (nextFields.length === 0) {
      setError("Collection needs at least one field");
      return;
    }
    const seen = new Set<string>();
    for (const f of nextFields) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.name)) {
        setError(`Invalid field name: "${f.name}"`);
        return;
      }
      if (seen.has(f.name)) {
        setError(`Duplicate field name: "${f.name}"`);
        return;
      }
      seen.add(f.name);
    }
    const input: ContentTypeInput = {
      name: collectionName,
      options: {
        ...collection.options,
        draftAndPublish
      },
      fields: Object.fromEntries(nextFields.map((f) => [f.name, f.field as AdminSchemaField & { kind: AdminSchemaField["kind"] }]))
    };
    setSubmitting(true);
    try {
      await onSave(input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hcms-edit-overlay" role="dialog" aria-modal="true" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="hcms-edit-panel" ref={ref}>
        <header className="hcms-edit-header">
          <div>
            <p className="hcms-dialog-eyebrow">Collection</p>
            <input
              className="hcms-edit-name"
              value={collectionName}
              onChange={(e) => setCollectionName(e.currentTarget.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Collection name"
            />
          </div>
          <div className="hcms-edit-header-actions">
            <label className="hcms-edit-toggle-inline">
              <input
                type="checkbox"
                checked={draftAndPublish}
                onChange={(e) => setDraftAndPublish(e.currentTarget.checked)}
              />
              <span>Draft + Publish</span>
            </label>
            <button type="button" className="hcms-dialog-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="hcms-edit-fields">
          {fields.map((draft, index) => (
            <FieldEditRow
              key={draft.originalName || `new-${index}`}
              draft={draft}
              onChange={(patch) => updateField(index, patch)}
              onToggleRemove={() => removeField(index)}
            />
          ))}
          <button type="button" className="hcms-edit-add" onClick={addField}>+ Add field</button>
        </div>

        {error ? <div className="hcms-form-submit-error">{error}</div> : null}

        <footer className="hcms-edit-footer">
          <button type="button" className="hcms-btn hcms-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="hcms-btn hcms-btn--primary" onClick={handleSave} disabled={submitting}>
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function FieldEditRow({ draft, onChange, onToggleRemove }: { draft: DraftField; onChange: (patch: Omit<Partial<DraftField>, "field"> & { field?: Partial<AdminSchemaField> }) => void; onToggleRemove: () => void }) {
  return (
    <div className={`hcms-edit-field${draft.removed ? " hcms-edit-field--removed" : ""}`}>
      <input
        className="hcms-edit-field-name"
        value={draft.name}
        onChange={(e) => onChange({ name: e.currentTarget.value })}
        placeholder="fieldName"
        spellCheck={false}
        autoComplete="off"
        disabled={draft.removed}
      />
      <select
        className="hcms-edit-field-kind"
        value={draft.field.kind}
        onChange={(e) => onChange({ field: { kind: e.currentTarget.value as AdminSchemaField["kind"] } })}
        disabled={draft.removed}
      >
        {FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label className="hcms-edit-field-toggle" title="Required">
        <input
          type="checkbox"
          checked={draft.field.required}
          onChange={(e) => onChange({ field: { required: e.currentTarget.checked } })}
          disabled={draft.removed}
        />
        <span>REQ</span>
      </label>
      <label className="hcms-edit-field-toggle" title="Unique">
        <input
          type="checkbox"
          checked={draft.field.unique}
          onChange={(e) => onChange({ field: { unique: e.currentTarget.checked } })}
          disabled={draft.removed}
        />
        <span>UNQ</span>
      </label>
      <button
        type="button"
        className={`hcms-edit-field-remove${draft.removed ? " hcms-edit-field-remove--undo" : ""}`}
        onClick={onToggleRemove}
        aria-label={draft.removed ? "Undo remove" : "Remove field"}
      >
        {draft.removed ? "↶" : "×"}
      </button>
    </div>
  );
}
