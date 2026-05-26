import { useState } from "react";
import { useForm } from "@tanstack/react-form";

export type AddCollectionInput = {
  name: string;
  draftAndPublish: boolean;
  primaryStringField: string;
};

type AddCollectionDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: AddCollectionInput) => Promise<void>;
  existingNames: readonly string[];
};

export function AddCollectionDialog({ open, onClose, onSubmit, existingNames }: AddCollectionDialogProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: "", draftAndPublish: false, primaryStringField: "title" } as AddCollectionInput,
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      try {
        await onSubmit(value);
        form.reset();
        onClose();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Failed to create collection");
      }
    }
  });

  if (!open) return null;

  return (
    <div className="hcms-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="hcms-add-collection-title">
      <div className="hcms-dialog">
        <header className="hcms-dialog-header">
          <div>
            <p className="hcms-dialog-eyebrow">Schema</p>
            <h2 id="hcms-add-collection-title">New collection</h2>
          </div>
          <button type="button" className="hcms-dialog-close" onClick={onClose} aria-label="Close">×</button>
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
            name="name"
            validators={{
              onChange: ({ value }) => {
                if (!value) return "Required";
                if (!/^[a-z][a-zA-Z0-9_-]*$/.test(value)) return "Lowercase letter first; letters, numbers, _ or -";
                if (existingNames.includes(value)) return "A collection with this name already exists";
                return undefined;
              }
            }}
          >
            {(field) => (
              <label className="hcms-field">
                <span className="hcms-field-label">Collection name</span>
                <input
                  className="hcms-field-input"
                  autoFocus
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  placeholder="e.g. comments"
                  spellCheck={false}
                  autoComplete="off"
                />
                {field.state.meta.errors.length > 0 ? (
                  <span className="hcms-field-error">{String(field.state.meta.errors[0])}</span>
                ) : (
                  <span className="hcms-field-hint">Exposed as <code>/api/{field.state.value || "name"}</code></span>
                )}
              </label>
            )}
          </form.Field>

          <form.Field name="primaryStringField">
            {(field) => (
              <label className="hcms-field">
                <span className="hcms-field-label">Primary text field</span>
                <input
                  className="hcms-field-input"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  placeholder="title"
                  spellCheck={false}
                  autoComplete="off"
                />
                <span className="hcms-field-hint">Required string field. More can be added directly on the canvas.</span>
              </label>
            )}
          </form.Field>

          <form.Field name="draftAndPublish">
            {(field) => (
              <label className="hcms-toggle">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.checked)}
                />
                <span>
                  <strong>Draft + publish workflow</strong>
                  <small>Records start as drafts and require an explicit publish step.</small>
                </span>
              </label>
            )}
          </form.Field>

          {submitError ? <div className="hcms-form-submit-error">{submitError}</div> : null}

          <footer className="hcms-dialog-footer">
            <button type="button" className="hcms-btn hcms-btn--ghost" onClick={onClose}>Cancel</button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <button type="submit" className="hcms-btn hcms-btn--primary" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Creating…" : "Create collection"}
                </button>
              )}
            </form.Subscribe>
          </footer>
        </form>
      </div>
    </div>
  );
}
