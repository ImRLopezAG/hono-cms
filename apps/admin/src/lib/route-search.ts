import { createStandardSchemaV1, parseAsString, parseAsStringEnum, type inferParserType } from "nuqs";
import qs from "qs";
import type { AdminContentListOptions } from "./api-client";

export const contentSearchParsers = {
  q: parseAsString.withDefault(""),
  status: parseAsStringEnum(["all", "draft", "published"]).withDefault("all"),
  sort: parseAsString.withDefault("-updatedAt")
};

export const mediaSearchParsers = {
  q: parseAsString.withDefault(""),
  type: parseAsString.withDefault(""),
  sort: parseAsString.withDefault("-createdAt"),
  view: parseAsStringEnum(["grid", "list"]).withDefault("grid"),
  // Active folder id; empty string means the root (Media library).
  folder: parseAsString.withDefault("")
};

export type ContentSearchState = inferParserType<typeof contentSearchParsers>;
export type MediaSearchState = inferParserType<typeof mediaSearchParsers>;

export const validateContentSearch = createStandardSchemaV1(contentSearchParsers, {
  partialOutput: true
});

export const validateMediaSearch = createStandardSchemaV1(mediaSearchParsers, {
  partialOutput: true
});

export function contentSearchToUrl(search: ContentSearchState): Record<string, string | undefined> {
  return {
    q: search.q || undefined,
    status: search.status === "all" ? undefined : search.status,
    sort: search.sort === "-updatedAt" ? undefined : search.sort
  };
}

export function contentSearchToListOptions(
  search: ContentSearchState,
  options: {
    limit?: number;
    cursor?: string;
    searchField?: string | null;
    draftWorkflow?: boolean;
  } = {}
): AdminContentListOptions {
  const trimmedSearch = search.q.trim();
  const filters = options.searchField && trimmedSearch
    ? { [options.searchField]: { $contains: trimmedSearch } }
    : undefined;
  const status = options.draftWorkflow && search.status !== "all" ? search.status : undefined;
  return {
    limit: options.limit,
    cursor: options.cursor,
    status,
    sort: search.sort,
    filters
  };
}

export function contentSearchToApiQuery(search: ContentSearchState, options: Parameters<typeof contentSearchToListOptions>[1] = {}): string {
  const listOptions = contentSearchToListOptions(search, options);
  return qs.stringify({
    pagination: {
      limit: listOptions.limit,
      cursor: listOptions.cursor
    },
    status: listOptions.status,
    sort: listOptions.sort,
    filters: listOptions.filters
  }, {
    encodeValuesOnly: true,
    arrayFormat: "brackets",
    skipNulls: true
  });
}

export function mediaSearchToUrl(search: MediaSearchState): Record<string, string | undefined> {
  return {
    q: search.q || undefined,
    type: search.type || undefined,
    sort: search.sort === "-createdAt" ? undefined : search.sort,
    view: search.view === "grid" ? undefined : search.view,
    folder: search.folder || undefined
  };
}
