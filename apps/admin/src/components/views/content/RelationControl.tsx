import { useQuery } from "@tanstack/react-query";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { Input } from "@/components/ui/input";
import type { AdminContentRecord } from "../../../lib/api-client";
import type { FieldRenderModel } from "../../../lib/field-rendering";
import { relationRecordsFromQuery } from "../query-helpers";
import { useClient } from "../shared";

export function RelationControl(props: { model: FieldRenderModel; value: string | boolean; onChange(value: string): void; onBlur(): void }): ReactElement {
  const client = useClient();
  const relation = props.model.relation;
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const updateSearch = useDebouncedCallback((value: string) => setSearch(value.trim()), { wait: 300 });
  const query = useQuery({
    queryKey: ["relation-options", relation?.target, relation?.labelField, search],
    queryFn: () => client.listContent(relation?.target ?? "", {
      limit: 50,
      filters: relation?.labelField && search ? { [relation.labelField]: { $contains: search } } : undefined
    }),
    enabled: Boolean(relation?.target)
  });
  const records = relationRecordsFromQuery(query.data);
  const visibleRecords = useMemo(() => {
    if (!search || relation?.labelField) return records;
    const normalized = search.toLocaleLowerCase();
    return records.filter((record) => recordLabel(record).toLocaleLowerCase().includes(normalized) || record.id.toLocaleLowerCase().includes(normalized));
  }, [records, relation?.labelField, search]);
  const virtualizer = useVirtualizer({ count: visibleRecords.length, getScrollElement: () => listRef.current, estimateSize: () => 36, overscan: 6 });
  const selectedIds = relation?.multiple ? parseRelationIds(props.value) : [];

  if (!relation) {
    return <Input name={props.model.name} type="text" value={String(props.value ?? "")} onChange={(event) => props.onChange(event.currentTarget.value)} onBlur={props.onBlur} placeholder="Related record ID" />;
  }

  const selectRecord = (id: string) => {
    if (!relation.multiple) {
      props.onChange(id);
      props.onBlur();
      return;
    }
    const next = selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id];
    props.onChange(next.join(", "));
    props.onBlur();
  };

  const selectedId = String(props.value ?? "");

  if (relation.multiple) {
    return (
      <div className="relation-picker">
        <Input
          type="search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.currentTarget.value);
            updateSearch(event.currentTarget.value);
          }}
          placeholder={`Search ${relation.target}`}
          aria-label={`Search ${relation.target}`}
        />
        {selectedIds.length > 0 && (
          <div className="relation-selected" aria-label="Selected relations">
            {selectedIds.map((id) => (
              <button key={id} type="button" onClick={() => selectRecord(id)}>{id}</button>
            ))}
          </div>
        )}
        <VirtualRelationList
          records={visibleRecords}
          selectedIds={new Set(selectedIds)}
          virtualizer={virtualizer}
          listRef={listRef}
          onSelect={selectRecord}
        />
      </div>
    );
  }

  return (
    <div className="relation-picker">
      <Input
        type="search"
        value={searchInput}
        onChange={(event) => {
          setSearchInput(event.currentTarget.value);
          updateSearch(event.currentTarget.value);
        }}
        placeholder={`Search ${relation.target}`}
        aria-label={`Search ${relation.target}`}
      />
      {selectedId && <div className="relation-selected"><button type="button" onClick={() => { props.onChange(""); props.onBlur(); }}>{selectedId}</button></div>}
      <VirtualRelationList
        records={visibleRecords}
        selectedIds={selectedId ? new Set([selectedId]) : new Set()}
        virtualizer={virtualizer}
        listRef={listRef}
        onSelect={selectRecord}
      />
    </div>
  );
}

function VirtualRelationList(props: {
  records: AdminContentRecord[];
  selectedIds: Set<string>;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect(id: string): void;
}): ReactElement {
  return (
    <div ref={props.listRef} className="relation-options" aria-label="Relation options">
      <div style={{ height: props.virtualizer.getTotalSize(), position: "relative" }}>
        {props.virtualizer.getVirtualItems().map((virtualRow) => {
          const record = props.records[virtualRow.index];
          if (!record) return null;
          return (
            <button
              key={record.id}
              type="button"
              className={props.selectedIds.has(record.id) ? "selected" : ""}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              onClick={() => props.onSelect(record.id)}
            >
              <strong>{recordLabel(record)}</strong>
              <span>{record.id}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function parseRelationIds(value: string | boolean): string[] {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function recordLabel(record: AdminContentRecord): string {
  const candidate = record.title ?? record.name ?? record.email ?? record.slug ?? record.id;
  return String(candidate);
}
