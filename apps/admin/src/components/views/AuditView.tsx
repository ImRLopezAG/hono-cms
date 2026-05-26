import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Download } from "lucide-react";
import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AuditEntry, type AuditLogOptions } from "../../lib/api-client";
import { auditEntriesFromQuery } from "./query-helpers";
import { SettingsShell } from "./SettingsShell";
import { useClient } from "./shared";

type AuditFilterFormValues = {
  collection: string;
  documentId: string;
  operation: string;
  actorId: string;
  from: string;
  to: string;
  limit: number;
};

const DEFAULT_AUDIT_FORM_VALUES: AuditFilterFormValues = {
  collection: "",
  documentId: "",
  operation: "",
  actorId: "",
  from: "",
  to: "",
  limit: 25
};

const OPERATION_OPTIONS = [
  { value: "", label: "Any operation" },
  { value: "create", label: "create" },
  { value: "update", label: "update" },
  { value: "delete", label: "delete" },
  { value: "publish", label: "publish" },
  { value: "unpublish", label: "unpublish" },
  { value: "media_upload", label: "media_upload" },
  { value: "media_delete", label: "media_delete" }
] as const;

function auditOptionsFromValues(values: AuditFilterFormValues): AuditLogOptions {
  const limit = Number(values.limit);
  const options: AuditLogOptions = {
    limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 25
  };
  const collection = values.collection.trim();
  const documentId = values.documentId.trim();
  const operation = values.operation.trim();
  const actorId = values.actorId.trim();
  const from = auditDateTimeValue(values.from);
  const to = auditDateTimeValue(values.to);
  if (collection) options.collection = collection;
  if (documentId) options.documentId = documentId;
  if (operation) options.operation = operation;
  if (actorId) options.actorId = actorId;
  if (from) options.from = from;
  if (to) options.to = to;
  return options;
}

export function AuditView(): ReactElement {
  const client = useClient();
  const [filters, setFilters] = useState<AuditLogOptions>({ limit: 25 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) => client.auditLog({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor
  });
  const exportMutation = useMutation({
    mutationFn: () => client.auditCsv(filters),
    onSuccess: (csv) => {
      const filename = `cms-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      downloadTextFile(csv, filename, "text/csv");
      toast.success("CSV exported", { description: filename });
    },
    onError: (error) => {
      toast.error("Export failed", { description: error instanceof Error ? error.message : "Try again" });
    }
  });
  const rows = auditEntriesFromQuery(query.data);

  const form = useForm({
    defaultValues: DEFAULT_AUDIT_FORM_VALUES,
    onSubmit: ({ value }) => {
      setExpandedId(null);
      setFilters(auditOptionsFromValues(value));
    }
  });

  return (
    <SettingsShell
      eyebrow="System"
      title="Audit log"
      subtitle="Immutable record of content mutations, media events, and operator actions. Filter and export for compliance reviews."
      action={
        <Button type="button" variant="outline" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
          <Download size={15} /> Export CSV
        </Button>
      }
    >
      <div className="rounded-lg border border-[#eaeaef] bg-white overflow-hidden shadow-sm">
        {/* Filter toolbar */}
        <form
          className="flex flex-wrap items-center gap-2 border-b border-[#eaeaef] px-5 py-3 bg-[#f6f6f9]"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field name="collection">
            {(field) => (
              <Input
                className="h-8 w-36 text-[13px]"
                name="collection"
                placeholder="Collection"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
              />
            )}
          </form.Field>
          <form.Field name="documentId">
            {(field) => (
              <Input
                className="h-8 w-40 text-[13px]"
                name="documentId"
                placeholder="Document ID"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
              />
            )}
          </form.Field>
          <form.Field name="operation">
            {(field) => (
              <select
                className="h-8 rounded-md border border-input bg-background px-3 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                name="operation"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
                aria-label="Operation"
              >
                {OPERATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </form.Field>
          <form.Field name="actorId">
            {(field) => (
              <Input
                className="h-8 w-36 text-[13px]"
                name="actorId"
                placeholder="Actor ID"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
              />
            )}
          </form.Field>
          <form.Field name="from">
            {(field) => (
              <Input
                className="h-8 text-[13px]"
                name="from"
                type="datetime-local"
                aria-label="Audit from"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
              />
            )}
          </form.Field>
          <form.Field name="to">
            {(field) => (
              <Input
                className="h-8 text-[13px]"
                name="to"
                type="datetime-local"
                aria-label="Audit to"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
              />
            )}
          </form.Field>
          <form.Field name="limit">
            {(field) => (
              <Input
                className="h-8 w-20 text-[13px]"
                name="limit"
                type="number"
                min={1}
                max={100}
                aria-label="Audit page size"
                value={field.state.value}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  field.handleChange(Number.isFinite(next) ? next : 25);
                }}
              />
            )}
          </form.Field>
          <Button type="submit" variant="outline" className="h-8 text-[13px]">Apply</Button>
        </form>

        {/* Audit table */}
        <table className="w-full text-[13px] border-collapse">
          <thead className="border-b border-[#eaeaef] bg-[#f6f6f9]">
            <tr>
              <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Collection</th>
              <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Document</th>
              <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Operation</th>
              <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Actor</th>
              <th scope="col" className="px-5 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8e8ea9]">Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                isExpanded={entry.id === expandedId}
                onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              />
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-[#8e8ea9]">
                  No audit entries match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Load more */}
        {query.hasNextPage && (
          <div className="flex justify-center border-t border-[#eaeaef] px-5 py-3">
            <Button
              type="button"
              variant="outline"
              className="text-[13px]"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

function AuditRow({
  entry,
  isExpanded,
  onToggle
}: {
  entry: AuditEntry;
  isExpanded: boolean;
  onToggle: () => void;
}): ReactElement {
  const operationClass = operationBadgeClass(entry.operation);
  return (
    <>
      <tr
        className="border-b border-[#eaeaef] hover:bg-[#f6f6f9] cursor-pointer"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <td className="px-5 py-3 text-[#32324d] font-medium">{entry.collection ?? <span className="text-[#8e8ea9]">—</span>}</td>
        <td className="px-5 py-3 font-mono text-[12px] text-[#666687]">{entry.documentId ?? <span className="text-[#8e8ea9]">—</span>}</td>
        <td className="px-5 py-3">
          <span className={operationClass}>{entry.operation}</span>
        </td>
        <td className="px-5 py-3 font-mono text-[12px] text-[#666687]">{entry.actorId ?? <span className="text-[#8e8ea9]">system</span>}</td>
        <td className="px-5 py-3 tabular-nums text-[#666687] whitespace-nowrap">
          <time>{entry.createdAt}</time>
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-[#eaeaef] bg-[#f6f6f9]">
          <td colSpan={5} className="px-5 py-3">
            <pre className="overflow-x-auto rounded-md bg-[#0b0d12] p-4 text-[12px] leading-relaxed text-[#c9d1d9] font-mono">
              {formatAuditDiff(entry)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function operationBadgeClass(operation: string): string {
  switch (operation) {
    case "create":
      return "inline-flex items-center rounded-full bg-[#c6f0c2] px-2.5 py-0.5 text-[11px] font-medium text-[#328048]";
    case "update":
      return "inline-flex items-center rounded-full bg-[#dbeafe] px-2.5 py-0.5 text-[11px] font-medium text-[#1e40af]";
    case "delete":
    case "media_delete":
      return "inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-medium text-red-700";
    case "publish":
      return "inline-flex items-center rounded-full bg-[#f0f0ff] px-2.5 py-0.5 text-[11px] font-medium text-[#4945ff]";
    case "unpublish":
      return "inline-flex items-center rounded-full bg-[#eaeaef] px-2.5 py-0.5 text-[11px] font-medium text-[#666687]";
    default:
      return "inline-flex items-center rounded-full bg-[#eaeaef] px-2.5 py-0.5 text-[11px] font-medium text-[#666687]";
  }
}

export function auditLogOptionsFromForm(form: FormData): AuditLogOptions {
  const limit = Number(form.get("limit") ?? 25);
  const options: AuditLogOptions = {
    limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 25
  };
  const collection = String(form.get("collection") ?? "").trim();
  const documentId = String(form.get("documentId") ?? "").trim();
  const operation = String(form.get("operation") ?? "").trim();
  const actorId = String(form.get("actorId") ?? "").trim();
  const from = auditDateTimeValue(form.get("from"));
  const to = auditDateTimeValue(form.get("to"));
  if (collection) options.collection = collection;
  if (documentId) options.documentId = documentId;
  if (operation) options.operation = operation;
  if (actorId) options.actorId = actorId;
  if (from) options.from = from;
  if (to) options.to = to;
  return options;
}

function auditDateTimeValue(value: FormDataEntryValue | null | undefined): string | undefined {
  const input = String(value ?? "").trim();
  if (!input) return undefined;
  const normalized = input.includes("T") ? input : `${input}T00:00`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function formatAuditDiff(entry: AuditEntry): string {
  return JSON.stringify({
    before: entry.diff?.before ?? null,
    after: entry.diff?.after ?? null
  }, null, 2);
}

function downloadTextFile(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
