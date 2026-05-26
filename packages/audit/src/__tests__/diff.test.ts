import { describe, expect, it } from "vitest";
import { computeDiff } from "../diff";

describe("computeDiff", () => {
  it("returns the full record as added on create (before = null)", () => {
    const diff = computeDiff(null, { id: "1", title: "Hello", body: "World" } as any);
    expect(diff.before).toBeNull();
    expect(diff.after).toEqual({ id: "1", title: "Hello", body: "World" });
  });

  it("returns the full record as removed on delete (after = null)", () => {
    const diff = computeDiff({ id: "1", title: "Hello" } as any, null);
    expect(diff.after).toBeNull();
    expect(diff.before).toEqual({ id: "1", title: "Hello" });
  });

  it("emits only the changed fields on update", () => {
    const before = { id: "1", title: "Old", body: "Same" } as any;
    const after = { id: "1", title: "New", body: "Same" } as any;
    const diff = computeDiff(before, after);
    expect(diff.before).toEqual({ title: "Old" });
    expect(diff.after).toEqual({ title: "New" });
  });

  it("redacts default-excluded fields (password, token, secret, cookie, authorization)", () => {
    const before = { id: "1", password: "old" } as any;
    const after = { id: "1", password: "new", token: "abc" } as any;
    const diff = computeDiff(before, after);
    expect(diff.before).not.toHaveProperty("password");
    expect(diff.after).not.toHaveProperty("password");
    expect(diff.after).not.toHaveProperty("token");
  });

  it("redacts user-configured excludeFields", () => {
    const before = { id: "1", ssn: "111" } as any;
    const after = { id: "1", ssn: "222" } as any;
    const diff = computeDiff(before, after, { excludeFields: ["ssn"] });
    expect(diff.before).not.toHaveProperty("ssn");
    expect(diff.after).not.toHaveProperty("ssn");
  });

  it("truncates fields larger than maxFieldBytes", () => {
    const huge = "x".repeat(100);
    const diff = computeDiff(null, { id: "1", body: huge } as any, { maxFieldBytes: 20 });
    expect(diff.after?.body).toEqual({ truncated: true, length: expect.any(Number) });
  });

  it("leaves small fields untouched when maxFieldBytes is large", () => {
    const diff = computeDiff(null, { id: "1", body: "small" } as any, { maxFieldBytes: 1024 });
    expect(diff.after?.body).toBe("small");
  });

  it("treats equal values as unchanged (no diff entry)", () => {
    const before = { id: "1", a: 1, b: 2 } as any;
    const after = { id: "1", a: 1, b: 3 } as any;
    const diff = computeDiff(before, after);
    expect(diff.before).toEqual({ b: 2 });
    expect(diff.after).toEqual({ b: 3 });
  });
});
