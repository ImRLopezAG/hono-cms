import { useMemo, useState, type ReactElement } from "react";
import type { FieldRenderModel } from "../../../lib/field-rendering";

/**
 * Placeholder editor for `component` field kind.
 *
 * Components are reusable typed structures embedded inside a collection.
 * For now we render a JSON textarea so editors can author values; a
 * structured form-builder UI is a separate track (Plan 005 follow-up).
 */
export function ComponentControl(props: {
  model: FieldRenderModel;
  value: string | boolean;
  onChange(value: string): void;
  onBlur(): void;
}): ReactElement {
  const initial = useMemo(() => typeof props.value === "string" ? props.value : "", [props.value]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const repeatable = props.model.component?.repeatable === true;
  const placeholder = repeatable ? "[]" : "{}";

  return (
    <div className="component-control" data-field-name={props.model.name} data-component={props.model.component?.name ?? ""}>
      <div className="component-control__meta" aria-label={`Component ${props.model.component?.name ?? "unknown"}`}>
        <span className="component-control__badge">{props.model.component?.name ?? "component"}</span>
        {repeatable ? <span className="component-control__badge component-control__badge--repeatable">repeatable</span> : null}
      </div>
      <textarea
        name={props.model.name}
        className="component-control__editor"
        value={text}
        rows={8}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={`${props.model.name} component data`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          try {
            if (next.trim()) JSON.parse(next);
            setError(null);
            props.onChange(next);
          } catch (parseError) {
            setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
          }
        }}
        onBlur={props.onBlur}
      />
      {error ? <p className="component-control__error" role="alert">{error}</p> : null}
      <p className="component-control__hint">Edit as JSON. A structured editor is coming soon.</p>
    </div>
  );
}
