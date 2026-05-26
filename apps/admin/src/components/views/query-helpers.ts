import type { InfiniteData } from "@tanstack/react-query";
import { AdminApiError, type AdminCollectionName, type AdminContentListResult, type AdminContentRecord, type AdminHealthReport, type AdminSchemaMetadata, type ApiKeyRecord, type AuditEntry, type AuthSessionRecord, type I18nBackfillStatus, type MediaRecord, type OrganizationInvitation, type OrganizationMember, type OrganizationRecord, type WebhookRecord } from "../../lib/api-client";

export type AdminSortState = {
  field: string;
  direction: "asc" | "desc";
} | null;

export type ContentStatusFilter = "all" | "draft" | "published";
export type ListResult<T> = { items: T[] };
export type InfiniteListResult<T> = ListResult<T> & { nextCursor?: string };

export function contentSelectionKey(collection: AdminCollectionName, id: string): string {
  return `${collection}:${id}`;
}

export function selectedItemsByCollection(selected: Set<string>, collection: AdminCollectionName): string[] {
  const prefix = `${collection}:`;
  return [...selected].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

export function toggleContentSelection(selected: Set<string>, collection: AdminCollectionName, id: string, checked: boolean): Set<string> {
  const next = new Set(selected);
  const key = contentSelectionKey(collection, id);
  if (checked) next.add(key);
  else next.delete(key);
  return next;
}

export function toggleVisibleContentSelection(selected: Set<string>, collection: AdminCollectionName, ids: string[], checked: boolean): Set<string> {
  return ids.reduce((next, id) => toggleContentSelection(next, collection, id, checked), new Set(selected));
}

export function removeCollectionSelection(selected: Set<string>, collection: AdminCollectionName): Set<string> {
  const prefix = `${collection}:`;
  return new Set([...selected].filter((key) => !key.startsWith(prefix)));
}

export function updateContentListRecords(
  data: InfiniteData<AdminContentListResult> | undefined,
  ids: string[],
  action: "delete" | "publish" | "unpublish"
): InfiniteData<AdminContentListResult> | undefined {
  if (!data || ids.length === 0) return data;
  const idSet = new Set(ids);
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: action === "delete"
        ? page.items.filter((item) => !idSet.has(item.id))
        : page.items.map((item) => idSet.has(item.id)
          ? { ...item, status: action === "publish" ? "published" : "draft" }
          : item)
    }))
  };
}

export function contentRecordsFromQuery(data: InfiniteData<AdminContentListResult> | undefined): AdminContentRecord[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

export function relationRecordsFromQuery(data: AdminContentListResult | undefined): AdminContentRecord[] {
  return data?.items ?? [];
}

export function auditEntriesFromQuery(data: InfiniteData<InfiniteListResult<AuditEntry>> | undefined): AuditEntry[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

export function webhooksFromQuery(data: ListResult<WebhookRecord> | undefined): WebhookRecord[] {
  return data?.items ?? [];
}

export function apiKeysFromQuery(data: ListResult<ApiKeyRecord> | undefined): ApiKeyRecord[] {
  return data?.items ?? [];
}

export function authSessionsFromQuery(data: ListResult<AuthSessionRecord> | undefined): AuthSessionRecord[] {
  return data?.items ?? [];
}

export function mediaFromQuery(data: ListResult<MediaRecord> | undefined): MediaRecord[] {
  return data?.items ?? [];
}

export function organizationFromQuery(data: OrganizationRecord | undefined): OrganizationRecord | null {
  return data ?? null;
}

export function organizationMembersFromQuery(data: ListResult<OrganizationMember> | undefined): OrganizationMember[] {
  return data?.items ?? [];
}

export function organizationInvitationsFromQuery(data: ListResult<OrganizationInvitation> | undefined): OrganizationInvitation[] {
  return data?.items ?? [];
}

export function healthReportFromQuery(data: AdminHealthReport | undefined): AdminHealthReport | null {
  return data ?? null;
}

export function i18nStatusFromQuery(data: I18nBackfillStatus | undefined): I18nBackfillStatus | null {
  return data ?? null;
}

export function emptySchemaMetadata(): AdminSchemaMetadata {
  return { collections: {} };
}

export function schemaMetadataFromQuery(data: AdminSchemaMetadata | undefined): AdminSchemaMetadata {
  return data ?? emptySchemaMetadata();
}

export function editorMutationErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof AdminApiError) {
    if (error.status === 401) return "Your session expired. Sign in again before saving this record.";
    if (error.status === 403) return "You do not have permission to make this change.";
    const detail = errorDetailMessage(error.details);
    if (detail) return detail;
    return `The CMS API rejected this change with HTTP ${error.status}.`;
  }
  if (error instanceof Error) return error.message;
  return "The editor could not save this change.";
}

function errorDetailMessage(details: unknown): string | null {
  if (!details || typeof details !== "object") return typeof details === "string" ? details : null;
  const record = details as { message?: unknown; error?: unknown; issues?: unknown };
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (Array.isArray(record.issues)) {
    const first = record.issues.find((issue): issue is { message?: unknown } => typeof issue === "object" && issue !== null && "message" in issue);
    if (typeof first?.message === "string") return first.message;
  }
  return null;
}

export function sortStateFromRoute(sort: string | undefined): AdminSortState {
  if (!sort) return { field: "updatedAt", direction: "desc" };
  if (sort.startsWith("-") && sort.slice(1)) return { field: sort.slice(1), direction: "desc" };
  const [field, direction] = sort.split(":");
  if (!field) return { field: "updatedAt", direction: "desc" };
  return { field, direction: direction === "desc" ? "desc" : "asc" };
}

export function nextSortState(current: AdminSortState, field: string): AdminSortState {
  if (current?.field !== field) return { field, direction: "asc" };
  if (current.direction === "asc") return { field, direction: "desc" };
  return null;
}

export function sortIndicator(sort: AdminSortState, field: string): string {
  if (sort?.field !== field) return "";
  return sort.direction === "asc" ? "up" : "down";
}

export function sortParamFromState(sort: AdminSortState): string {
  if (!sort) return "-updatedAt";
  if (sort.direction === "desc") return `-${sort.field}`;
  return `${sort.field}:asc`;
}
