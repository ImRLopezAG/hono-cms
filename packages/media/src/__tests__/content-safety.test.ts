import { describe, expect, it } from "vitest";
import { safeFilename, validateMediaContentType } from "../content-safety";

describe("validateMediaContentType()", () => {
  it("accepts ordinary safe types by default", () => {
    expect(() => validateMediaContentType("image/png")).not.toThrow();
    expect(() => validateMediaContentType("image/jpeg")).not.toThrow();
    expect(() => validateMediaContentType("application/pdf")).not.toThrow();
    expect(() => validateMediaContentType("video/mp4")).not.toThrow();
  });

  it("rejects active-content MIME types by default", () => {
    expect(() => validateMediaContentType("image/svg+xml")).toThrowError("active_content_not_allowed");
    expect(() => validateMediaContentType("text/html")).toThrowError("active_content_not_allowed");
    expect(() => validateMediaContentType("application/javascript")).toThrowError(
      "active_content_not_allowed"
    );
    expect(() => validateMediaContentType("application/xml")).toThrowError("active_content_not_allowed");
  });

  it("accepts active content when allowActiveContent: true is passed", () => {
    expect(() =>
      validateMediaContentType("image/svg+xml", { allowActiveContent: true })
    ).not.toThrow();
    expect(() => validateMediaContentType("text/html", { allowActiveContent: true })).not.toThrow();
  });

  it("ignores trailing parameters in the MIME header (`; charset=...`)", () => {
    expect(() => validateMediaContentType("image/svg+xml; charset=utf-8")).toThrowError(
      "active_content_not_allowed"
    );
    expect(() => validateMediaContentType("text/plain; charset=utf-8")).not.toThrow();
  });

  it("rejects strings that don't look like MIME types", () => {
    expect(() => validateMediaContentType("not-a-mime-type")).toThrowError(
      "contentType must be a valid MIME type"
    );
    expect(() => validateMediaContentType("")).toThrowError("contentType must be a valid MIME type");
  });
});

describe("safeFilename()", () => {
  it("strips disallowed characters from the filename", () => {
    expect(safeFilename("../../etc/passwd")).toBe("..-..-etc-passwd");
    expect(safeFilename("hello world!.png")).toBe("hello-world-.png");
  });

  it("collapses consecutive dashes", () => {
    expect(safeFilename("a    b")).toBe("a-b");
  });

  it("falls back to `upload.bin` for empty input", () => {
    expect(safeFilename("")).toBe("upload.bin");
  });

  it("clamps to 120 characters", () => {
    const long = "a".repeat(200) + ".png";
    expect(safeFilename(long).length).toBe(120);
  });
});
