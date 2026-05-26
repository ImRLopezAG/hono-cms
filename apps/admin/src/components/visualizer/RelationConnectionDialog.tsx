import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";

export type RelationCardinalityChoice =
  | "one"
  | "many-to-one"
  | "one-to-many"
  | "many-to-many"
  | "one-to-one";

export type RelationConnectionInput = {
  fieldName: string;
  cardinality: RelationCardinalityChoice;
  required: boolean;
};

type RelationConnectionDialogProps = {
  open: boolean;
  sourceName: string;
  targetName: string;
  existingFieldNames: readonly string[];
  defaultFieldName: string;
  onClose: () => void;
  onSubmit: (input: RelationConnectionInput) => Promise<void>;
};

const CARDINALITY_OPTIONS: ReadonlyArray<{
  value: RelationCardinalityChoice;
  label: string;
  description: string;
}> = [
  { value: "one", label: "One", description: "Belongs to one (1:1 default)" },
  { value: "many-to-one", label: "Many-to-one (default)", description: "Many of this side, one on target" },
  { value: "one-to-many", label: "One-to-many", description: "One on this side, many on target" },
  { value: "many-to-many", label: "Many-to-many", description: "Many on both sides (creates a join table)" },
  { value: "one-to-one", label: "One-to-one", description: "Strictly one on both sides" }
];

const IDENTIFIER_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function RelationConnectionDialog({
  open,
  sourceName,
  targetName,
  existingFieldNames,
  defaultFieldName,
  onClose,
  onSubmit
}: RelationConnectionDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: {
      fieldName: defaultFieldName,
      cardinality: "many-to-one",
      required: false
    } as RelationConnectionInput,
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      try {
        await onSubmit(value);
        form.reset();
        onClose();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to create relation");
      }
    }
  });

  // Reset form when the dialog (re)opens with new defaults
  useEffect(() => {
    if (open) {
      form.reset({
        fieldName: defaultFieldName,
        cardinality: "many-to-one",
        required: false
      });
      setSubmitError(null);
    }
    // Intentionally exclude `form` from deps to avoid TanStack Form ref churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultFieldName]);

  // Esc key closes the dialog
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="hcms-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hcms-relation-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="hcms-dialog">
        <header className="hcms-dialog-header">
          <div>
            <p className="hcms-dialog-eyebrow">Relation</p>
            <h2 id="hcms-relation-dialog-title">
              {sourceName} → {targetName}
            </h2>
          </div>
          <button type="button" className="hcms-dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <form
          className="hcms-dialog-body"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="fieldName"
            validators={{
              onChange: ({ value }) => {
                if (!value) return "Required";
                if (!IDENTIFIER_RE.test(value)) {
                  return "Must start with a letter; letters, numbers, or _";
                }
                if (existingFieldNames.includes(value)) {
                  return `A field named "${value}" already exists on ${sourceName}`;
                }
                return undefined;
              }
            }}
          >
            {(field) => (
              <label className="hcms-field">
                <span className="hcms-field-label">Field name</span>
                <input
                  className="hcms-field-input"
                  autoFocus
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  placeholder={`${targetName}Ref`}
                  spellCheck={false}
                  autoComplete="off"
                />
                {field.state.meta.errors.length > 0 ? (
                  <span className="hcms-field-error">{String(field.state.meta.errors[0])}</span>
                ) : (
                  <span className="hcms-field-hint">
                    Added to <code>{sourceName}</code>, pointing at <code>{targetName}</code>
                  </span>
                )}
              </label>
            )}
          </form.Field>

          <form.Field name="cardinality">
            {(field) => (
              <label className="hcms-field">
                <span className="hcms-field-label">Cardinality</span>
                <select
                  className="hcms-field-input"
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value as RelationCardinalityChoice)
                  }
                >
                  {CARDINALITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="hcms-field-hint">
                  {CARDINALITY_OPTIONS.find((opt) => opt.value === field.state.value)?.description ?? ""}
                </span>
              </label>
            )}
          </form.Field>

          <form.Field name="required">
            {(field) => (
              <label className="hcms-toggle">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.checked)}
                />
                <span>
                  <strong>Required</strong>
                  <small>Records on {sourceName} must reference a {targetName}.</small>
                </span>
              </label>
            )}
          </form.Field>

          {submitError ? <div className="hcms-form-submit-error">{submitError}</div> : null}

          <footer className="hcms-dialog-footer">
            <button type="button" className="hcms-btn hcms-btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <button
                  type="submit"
                  className="hcms-btn hcms-btn--primary"
                  disabled={!canSubmit || isSubmitting}
                >
                  {isSubmitting ? "Creating…" : "Create relation"}
                </button>
              )}
            </form.Subscribe>
          </footer>
        </form>
      </div>
    </div>
  );
}
