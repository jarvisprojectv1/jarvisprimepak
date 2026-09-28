import { describe, it, expect } from "vitest";
import { initHeartbeat, beat, getHeartbeat, isStale } from "./heartbeat";

describe("core/worker/heartbeat (#4)", () => {
  it("creates and refreshes a heartbeat row, tracking counters", async () => {
    const workerId = `test-worker-${Date.now()}`;
    await initHeartbeat(workerId);

    let hb = await getHeartbeat(workerId);
    expect(hb?.status).toBe("IDLE");
    expect(hb?.processedTasks).toBe(0);

    await beat(workerId, { status: "RUNNING", currentTaskId: "task-1" });
    hb = await getHeartbeat(workerId);
    expect(hb?.status).toBe("RUNNING");
    expect(hb?.currentTaskId).toBe("task-1");

    await beat(workerId, { incrementProcessed: true });
    await beat(workerId, { incrementFailed: true });
    hb = await getHeartbeat(workerId);
    expect(hb?.processedTasks).toBe(1);
    expect(hb?.failedTasks).toBe(1);
  });

  it("isStale reports true only after the timeout window elapses", async () => {
    const workerId = `stale-worker-${Date.now()}`;
    await initHeartbeat(workerId);
    const hb = await getHeartbeat(workerId);
    expect(hb).not.toBeNull();
    expect(isStale(hb!, 60_000)).toBe(false);
    const future = new Date(hb!.lastHeartbeat.getTime() + 120_000);
    expect(isStale(hb!, 60_000, future)).toBe(true);
  });
});
