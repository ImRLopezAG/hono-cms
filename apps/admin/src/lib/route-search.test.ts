import { describe, expect, it } from "vitest";

import { contentSearchParsers, contentSearchToApiQuery, contentSearchToListOptions, contentSearchToUrl, mediaSearchParsers, mediaSearchToUrl } from "./route-search";

describe("admin route search validation", () => {
  it("normalizes content list search params at the router boundary", () => {
    expect(contentSearchParsers.q.parseServerSide("edge")).toBe("edge");
    expect(contentSearchParsers.status.parseServerSide("published")).toBe("published");
    expect(contentSearchParsers.sort.parseServerSide("title:asc")).toBe("title:asc");
  });

  it("defaults invalid content search params to stable list state", () => {
    expect(contentSearchParsers.q.parseServerSide(undefined)).toBe("");
    expect(contentSearchParsers.status.parseServerSide("archived")).toBe("all");
    expect(contentSearchParsers.sort.parseServerSide(undefined)).toBe("-updatedAt");
  });

  it("omits default content search params when writing URLs", () => {
    expect(contentSearchToUrl({
      q: "",
      status: "all",
      sort: "-updatedAt"
    })).toEqual({
      q: undefined,
      status: undefined,
      sort: undefined
    });
  });

  it("maps nuqs content search state into typed API list options", () => {
    expect(contentSearchToListOptions({
      q: " edge cms ",
      status: "published",
      sort: "title:asc"
    }, {
      limit: 50,
      cursor: "cursor_1",
      searchField: "title",
      draftWorkflow: true
    })).toEqual({
      limit: 50,
      cursor: "cursor_1",
      status: "published",
      sort: "title:asc",
      filters: { title: { $contains: "edge cms" } }
    });
  });

  it("serializes content search through qs for nested CMS filters", () => {
    expect(contentSearchToApiQuery({
      q: "edge",
      status: "draft",
      sort: "-updatedAt"
    }, {
      limit: 50,
      searchField: "title",
      draftWorkflow: true
    })).toBe("pagination[limit]=50&status=draft&sort=-updatedAt&filters[title][$contains]=edge");
  });

  it("normalizes media search params for typed media routes", () => {
    expect(mediaSearchParsers.q.parseServerSide("logo")).toBe("logo");
    expect(mediaSearchParsers.type.parseServerSide("image/png")).toBe("image/png");
    expect(mediaSearchToUrl({ q: "", type: "", sort: "-createdAt", view: "grid", folder: "" })).toEqual({
      q: undefined,
      type: undefined,
      sort: undefined,
      view: undefined,
      folder: undefined
    });
  });
});
