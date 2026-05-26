import { useMemo, useState, type ReactElement } from "react";
import type { FieldRenderModel } from "../../../lib/field-rendering";

type ZoneEntry = { __component: string } & Record<string, unknown>;

/**
 * Placeholder editor for `dynamiczone` field kind.
 *
 * A dynamic zone is an ordered, polymorphic array of components. The
 * production editor will use drag-and-drop reordering; this placeholder
 * exposes a JSON textarea plus simple add/remove/move controls so editors
 * can shape the list while we land the typed form UI separately.
 */
export function DynamicZoneControl(props: {
  model: FieldRenderModel;
  value: string | boolean;
  onChange(value: string): void;
  onBlur(): void;
}): ReactElement {
  const initialEntries = useMemo<ZoneEntry[]>(() => {
    if (typeof props.value !== "string" || !props.value.trim()) return [];
    try {
      const parsed = JSON.parse(props.value);
      return Array.isArray(parsed) ? parsed.filter(isZoneEntry) : [];
    } catch {
      return [];
    }
  }, [props.value]);

  const [entries, setEntries] = useState<ZoneEntry[]>(initialEntries);
  const [rawText, setRawText] = useState<string>(typeof props.value === "string" ? props.value : JSON.stringify(initialEntries, null, 2));
  const [error, setError] = useState<string | null>(null);
  const allowed = props.model.dynamicZone?.components ?? [];
  const [pendingComponent, setPendingComponent] = useState<string>(allowed[0] ?? "");

  const sync = (next: ZoneEntry[]) => {
    setEntries(next);
    const text = JSON.stringify(next, null, 2);
    setRawText(text);
    setError(null);
    props.onChange(text);
  };

  const addEntry = () => {
    if (!pendingComponent) return;
    sync([...entries, { __component: pendingComponent }]);
  };

  const removeEntry = (index: number) => {
    sync(entries.filter((_, currentIndex) => currentIndex !== index));
  };

  const moveEntry = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= entries.length) return;
    const next = entries.slice();
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    sync(next);
  };

  const editRaw = (text: string) => {
    setRawText(text);
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every(isZoneEntry)) {
        setError("Expected an array of objects with __component");
        return;
      }
      setEntries(parsed);
      setError(null);
      props.onChange(text);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
    }
  };

  return (
    <div className="dynamiczone-control" data-field-name={props.model.name}>
      <div className="dynamiczone-control__toolbar">
        <label className="dynamiczone-control__pick">
          <span>Add</span>
          <select
            value={pendingComponent}
            onChange={(event) => setPendingComponent(event.currentTarget.value)}
            disabled={allowed.length === 0}
            aria-label={`Component to insert into ${props.model.name}`}
          >
            {allowed.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={addEntry} disabled={!pendingComponent}>Insert block</button>
      </div>
      <ol className="dynamiczone-control__list">
        {entries.length === 0 ? <li className="dynamiczone-control__empty">No blocks yet — pick a component above to start.</li> : null}
        {entries.map((entry, index) => (
          <li key={index} className="dynamiczone-control__item">
            <header>
              <strong>{entry.__component}</strong>
              <div className="dynamiczone-control__item-actions">
                <button type="button" onClick={() => moveEntry(index, -1)} aria-label={`Move ${entry.__component} up`}>↑</button>
                <button type="button" onClick={() => moveEntry(index, 1)} aria-label={`Move ${entry.__component} down`}>↓</button>
                <button type="button" onClick={() => removeEntry(index)} aria-label={`Remove ${entry.__component}`}>Remove</button>
              </div>
            </header>
          </li>
        ))}
      </ol>
      <details className="dynamiczone-control__raw">
        <summary>Edit raw JSON</summary>
        <textarea
          name={props.model.name}
          value={rawText}
          rows={8}
          spellCheck={false}
          onChange={(event) => editRaw(event.currentTarget.value)}
          onBlur={props.onBlur}
          aria-label={`${props.model.name} raw JSON`}
        />
        {error ? <p className="dynamiczone-control__error" role="alert">{error}</p> : null}
      </details>
    </div>
  );
}

function isZoneEntry(value: unknown): value is ZoneEntry {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).__component === "string");
}
