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

  it("supports the DECISION namespace", async () => {
    const entry = await Memory.remember({
      namespace: "DECISION",
      key: `decision-${Date.now()}`,
      content: "Chose vendor A over vendor B on price.",
      source: "brain",
    });
    expect(entry.namespace).toBe("DECISION");
    expect(entry.content).toContain("vendor A");
  });

  it("remember()/retrieve() store and return content, source, confidence, relatedEntity, metadata", async () => {
    const key = `rich-${Date.now()}`;
    const entry = await Memory.remember({
      namespace: "CLIENT",
      key,
      content: "Client prefers matte lamination.",
      source: "agent:research",
      confidence: 0.8,
      relatedEntity: "company-123",
      metadata: { channel: "email" },
    });
    expect(entry.content).toBe("Client prefers matte lamination.");
    expect(entry.source).toBe("agent:research");
    expect(entry.confidence).toBe(0.8);
    expect(entry.relatedEntity).toBe("company-123");
    expect(entry.metadata).toEqual({ channel: "email" });

    const retrieved = await Memory.retrieve("CLIENT", key);
    expect(retrieved?.content).toBe("Client prefers matte lamination.");
  });

  it("supersede() archives the prior entry, same as update()", async () => {
    const key = `supersede-${Date.now()}`;
    const first = await Memory.remember({ namespace: "PROJECT", key, content: "v1" });
    const second = await Memory.supersede({ namespace: "PROJECT", key, content: "v2" });
    expect(second.supersedes).toBe(first.id);
    const history = await Memory.history("PROJECT", key);
    expect(history.find((h) => h.id === first.id)?.status).toBe("ARCHIVED");
  });

  it("forget() excludes a memory from search()/retrieve() without deleting its history", async () => {
    const key = `forget-${Date.now()}`;
    const created = await Memory.remember({ namespace: "TASK", key, content: "temp fact" });
    await Memory.forget(created.id);

    const retrieved = await Memory.retrieve("TASK", key);
    expect(retrieved).toBeNull();

    const found = await Memory.search({ namespace: "TASK", query: "temp fact" });
    expect(found.some((r) => r.id === created.id)).toBe(false);

    const history = await Memory.history("TASK", key);
    expect(history.some((h) => h.id === created.id)).toBe(true);
  });
});
