import { describe, it, expect, beforeEach } from "vitest";
import { publish, subscribe, __resetSubscriptionsForTests } from "./index";
import { prisma } from "../../database/client";

describe("core/events - event bus", () => {
  beforeEach(() => {
    __resetSubscriptionsForTests();
  });

  it("persists a published event to the events table", async () => {
    const event = await publish({ type: "test.persisted", payload: { a: 1 }, source: "unit-test" });
    const row = await prisma.event.findUnique({ where: { id: event.id } });
    expect(row).not.toBeNull();
    expect(row?.type).toBe("test.persisted");
  });

  it("notifies a subscribed handler synchronously", async () => {
    let received: unknown;
    subscribe("test.subscribed", (event) => {
      received = event.payload;
    });
    await publish({ type: "test.subscribed", payload: { hello: "world" } });
    expect(received).toEqual({ hello: "world" });
  });

  it("does not throw the publisher when a handler fails", async () => {
    subscribe("test.failing", () => {
      throw new Error("handler boom");
    });
    await expect(publish({ type: "test.failing" })).resolves.toBeDefined();
  });

  it("does not notify handlers subscribed to a different event type", async () => {
    let called = false;
    subscribe("test.other", () => {
      called = true;
    });
    await publish({ type: "test.unrelated" });
    expect(called).toBe(false);
  });
});
