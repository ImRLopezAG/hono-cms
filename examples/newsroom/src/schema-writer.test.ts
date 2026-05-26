import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defineCollection, fields, generateCollectionFile } from "@hono-cms/schema";
import { createFileSchemaWriter } from "./schema-writer";

describe("createFileSchemaWriter", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "newsroom-schema-writer-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  test("writes the generated collection source to <baseDir>/<name>.ts", async () => {
    const writer = createFileSchemaWriter({ baseDir, logger: false });
    const collection = defineCollection("recipes", {
      title: fields.string({ required: true }),
      body: fields.richtext()
    });
    const source = generateCollectionFile(collection);

    const result = await writer.writeCollection({ collection, source, mode: "create" });

    const expectedPath = join(baseDir, "recipes.ts");
    expect(result.path).toBe(expectedPath);
    expect(result.source).toBe(source);
    expect(result.artifacts).toEqual([expectedPath]);

    const onDisk = await readFile(expectedPath, "utf8");
    expect(onDisk).toBe(source);
    expect(onDisk).toContain('defineCollection(');
    expect(onDisk).toContain('"recipes"');
  });

  test("creates baseDir recursively when it does not yet exist", async () => {
    const nested = join(baseDir, "deep", "nested");
    const writer = createFileSchemaWriter({ baseDir: nested, logger: false });
    const collection = defineCollection("widgets", { name: fields.string() });
    const source = generateCollectionFile(collection);

    const result = await writer.writeCollection({ collection, source, mode: "create" });

    expect(result.path).toBe(join(nested, "widgets.ts"));
    const onDisk = await readFile(join(nested, "widgets.ts"), "utf8");
    expect(onDisk).toBe(source);
  });

  test("regenerates the file when no source is passed in", async () => {
    const writer = createFileSchemaWriter({ baseDir, logger: false });
    const collection = defineCollection("posts", { title: fields.string({ required: true }) });

    const result = await writer.writeCollection({ collection, source: undefined as unknown as string, mode: "create" });

    expect(result.path).toBe(join(baseDir, "posts.ts"));
    const onDisk = await readFile(join(baseDir, "posts.ts"), "utf8");
    expect(onDisk).toBe(generateCollectionFile(collection));
  });

  test("afterWrite logs via the configured logger", async () => {
    const messages: string[] = [];
    const writer = createFileSchemaWriter({ baseDir, logger: (m) => messages.push(m) });
    const collection = defineCollection("tags", { label: fields.string() });
    const source = generateCollectionFile(collection);

    const result = await writer.writeCollection({ collection, source, mode: "create" });
    writer.afterWrite?.({ collection, source, mode: "create", result });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("wrote collection tags");
    expect(messages[0]).toContain("(create)");
  });

  test("removeCollection deletes the file from disk and reports the path", async () => {
    const writer = createFileSchemaWriter({ baseDir, logger: false });
    const collection = defineCollection("temp", { title: fields.string() });
    const source = generateCollectionFile(collection);
    await writer.writeCollection({ collection, source, mode: "create" });

    const expectedPath = join(baseDir, "temp.ts");
    await access(expectedPath); // sanity-check that the write happened first.

    const result = await writer.removeCollection!({ collection });

    expect(result.path).toBe(expectedPath);
    expect(result.artifacts).toEqual([expectedPath]);
    await expect(access(expectedPath)).rejects.toThrow();
  });

  test("removeCollection is idempotent when the file does not exist", async () => {
    const writer = createFileSchemaWriter({ baseDir, logger: false });
    const collection = defineCollection("ghost", { title: fields.string() });

    const result = await writer.removeCollection!({ collection });

    expect(result.path).toBe(join(baseDir, "ghost.ts"));
  });
});
