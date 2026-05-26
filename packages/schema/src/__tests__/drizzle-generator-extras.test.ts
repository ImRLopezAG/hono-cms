import { describe, expect, test } from "vitest";
import { defineCollection, defineSchema, fields, generateDrizzleSchema } from "../index";

const i18nCollection = defineCollection(
  "pages",
  { title: fields.string({ required: true }) },
  { i18n: { locales: ["en", "es"], defaultLocale: "en" } }
);

const plainCollection = defineCollection("articles", {
  title: fields.string({ required: true })
});

describe("generateDrizzleSchema — locale variants and audit log emission", () => {
  for (const dialect of ["sqlite", "pg"] as const) {
    describe(`dialect = ${dialect}`, () => {
      test("emits localeVariantsTable when a collection declares i18n.locales", () => {
        const schema = defineSchema({ pages: i18nCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        expect(output).toContain("export const localeVariantsTable = ");
        expect(output).toContain('"locale_variants"');
      });

      test("emits auditLogTable by default (includeAuditLog defaults to true)", () => {
        const schema = defineSchema({ articles: plainCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        expect(output).toContain("export const auditLogTable = ");
        expect(output).toContain('"audit_log"');
      });

      test("omits localeVariantsTable when includeLocaleVariants is false", () => {
        const schema = defineSchema({ pages: i18nCollection });
        const output = generateDrizzleSchema(schema, { dialect, includeLocaleVariants: false });
        expect(output).not.toContain("localeVariantsTable");
      });

      test("omits auditLogTable when includeAuditLog is false", () => {
        const schema = defineSchema({ articles: plainCollection });
        const output = generateDrizzleSchema(schema, { dialect, includeAuditLog: false });
        expect(output).not.toContain("auditLogTable");
      });

      test("includes uniqueIndex in the import line so localeVariants compiles", () => {
        const schema = defineSchema({ pages: i18nCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        const importLine = output
          .split("\n")
          .find((line) => line.startsWith("import {") && line.includes(dialect === "pg" ? "pg-core" : "sqlite-core"));
        expect(importLine).toBeDefined();
        expect(importLine!).toContain("uniqueIndex");
      });

      test("includes index helper in the import line so auditLog indexes compile", () => {
        const schema = defineSchema({ articles: plainCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        const importLine = output
          .split("\n")
          .find((line) => line.startsWith("import {") && line.includes(dialect === "pg" ? "pg-core" : "sqlite-core"));
        expect(importLine).toBeDefined();
        // Match the bare `index` import (avoid the `uniqueIndex` substring).
        expect(/[\s{,]index[\s,}]/.test(importLine!)).toBe(true);
      });

      test("auditLogTable block declares the expected columns and indexes", () => {
        const schema = defineSchema({ articles: plainCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        expect(output).toContain('id: text("id").primaryKey()');
        expect(output).toContain('operation: text("operation").notNull()');
        expect(output).toContain('actorRoles: text("actor_roles").notNull()');
        expect(output).toContain('requestId: text("request_id").notNull()');
        expect(output).toContain('diffBefore: text("diff_before")');
        expect(output).toContain('diffAfter: text("diff_after")');
        expect(output).toContain('createdAtIdx: index("audit_log_created_at_idx")');
        // Composite indexes for canonical filter+order shapes per Plan 014 U1.
        expect(output).toContain('collectionOpCreatedIdx: index("audit_log_collection_op_created_idx").on(table.collection, table.operation, table.createdAt)');
        expect(output).toContain('documentCreatedIdx: index("audit_log_document_created_idx").on(table.documentId, table.createdAt)');
        expect(output).toContain('actorCreatedIdx: index("audit_log_actor_created_idx").on(table.actorId, table.createdAt)');
      });

      test("localeVariantsTable block declares fields/status/translatedBy/unique index", () => {
        const schema = defineSchema({ pages: i18nCollection });
        const output = generateDrizzleSchema(schema, { dialect });
        expect(output).toContain('fields: text("fields").notNull()');
        expect(output).toContain('status: text("status", { enum: ["pending", "in_progress", "complete", "error"] }).notNull()');
        expect(output).toContain('translatedBy: text("translated_by", { enum: ["ai", "human", "pending"] }).notNull()');
        expect(output).toContain('uniqueIndex("locale_variants_collection_document_locale_uq")');
      });
    });
  }

  test("includeLocaleVariants: true forces emission even without an i18n collection", () => {
    const schema = defineSchema({ articles: plainCollection });
    const output = generateDrizzleSchema(schema, { dialect: "sqlite", includeLocaleVariants: true });
    expect(output).toContain("localeVariantsTable");
  });

  test("no i18n collection and no override => no localeVariantsTable", () => {
    const schema = defineSchema({ articles: plainCollection });
    const output = generateDrizzleSchema(schema, { dialect: "sqlite" });
    expect(output).not.toContain("localeVariantsTable");
  });
});
