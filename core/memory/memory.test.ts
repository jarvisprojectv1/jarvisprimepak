import { describe, it, expect, beforeAll } from "vitest";
import { Memory } from "./index";
import { prisma } from "../../database/client";

describe("core/memory", () => {
  const testKey = `test-key-${Date.now()}`;

  it("creates a memory entry", async () => {
    const entry = await Memory.create({
      namespace: "PREFERENCE",
      key: testKey,
      value: { likes: "matte lamination" },
      importance: 7,
    });
    expect(entry.namespace).toBe("PREFERENCE");
    expect(entry.status).toBe("ACTIVE");
    expect(entry.value).toEqual({ likes: "matte lamination" });
  });

  it("reads the active entry", async () => {
    const entry = await Memory.read("PREFERENCE", testKey);
    expect(entry).not.toBeNull();
    expect(entry?.value).toEqual({ likes: "matte lamination" });
  });

  it("archives the old value instead of overwriting on update (append-only history)", async () => {
    const first = await Memory.read("PREFERENCE", testKey);
    const updated = await Memory.update({
      namespace: "PREFERENCE",
      key: testKey,
      value: { likes: "gloss lamination" },
    });

    expect(updated.supersedes).toBe(first?.id);

    const history = await Memory.history("PREFERENCE", testKey);
    expect(history.length).toBeGreaterThanOrEqual(2);

    const archived = history.find((h) => h.id === first?.id);
    expect(archived?.status).toBe("ARCHIVED");

    const active = await Memory.read("PREFERENCE", testKey);
    expect(active?.value).toEqual({ likes: "gloss lamination" });
  });

  it("archive() soft-deletes without inserting a replacement", async () => {
    const entry = await Memory.create({
      namespace: "TASK",
      key: `archive-test-${Date.now()}`,
      value: { note: "temp" },
    });
    await Memory.archive(entry.id);
    const row = await prisma.memory.findUnique({ where: { id: entry.id } });
    expect(row?.status).toBe("ARCHIVED");
  });

  it("search() filters by namespace and query substring", async () => {
    const results = await Memory.search({ namespace: "PREFERENCE", query: "gloss" });
    expect(results.some((r) => JSON.stringify(r.value).includes("gloss"))).toBe(true);
  });

  it("rejects an out-of-range importance score", async () => {
    await expect(
      Memory.create({ namespace: "BUSINESS", key: "bad-importance", value: 1, importance: 99 })
    ).rejects.toThrow();
  });
});
