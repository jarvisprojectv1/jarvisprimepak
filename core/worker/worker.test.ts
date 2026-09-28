import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { prisma } from "../../database/client";
import { Worker, processClaimedTask } from "./index";
import { registerBuiltinTools } from "../../tools";
import { registerBuiltinAgents } from "../../agents/registry";
import { setSystemState, disableTool, enableTool } from "../state";
import { setLimitsConfig, DEFAULT_LIMITS } from "../limits";
import { getHeartbeat } from "./heartbeat";
import { getLatestDailyReport } from "../reports/dailyReport";

describe("core/worker - the Autonomous Worker loop (#1)", () => {
  beforeAll(() => {
    registerBuiltinTools();
    registerBuiltinAgents();
  });

  // Other test suites in this repo create top-level tasks without always
  // deleting them (they don't exercise a system-wide task-selection query
  // like this one does). Since vitest.config.ts runs test FILES sequentially
  // against one shared SQLite file (fileParallelism: false), clear any
  // leftover non-terminal top-level tasks before each test in THIS file so
  // the worker's candidate pool only ever contains what the test itself
  // created - this does not touch any other suite's already-completed run.
  beforeEach(async () => {
    // Broader than just PENDING/QUEUED/RETRYING: also clears leftover
    // WAITING/BLOCKED top-level tasks from other suites, since this file's
    // own tests exercise the backoff re-check pass (core/worker/index.ts's
    // recheckStaleTasks), which would otherwise re-promote them mid-test.
    await prisma.task.deleteMany({ where: { parentId: null } });
  });

  afterEach(async () => {
    await setSystemState("RUNNING", "test cleanup", "test");
    await enableTool("reports");
    await enableTool("browser");
    await setLimitsConfig({ ...DEFAULT_LIMITS });
  });

  it("processClaimedTask marks a toolName-tagged task DONE on OK, through the real tool registry", async () => {
    const task = await prisma.task.create({ data: { title: "run report", toolName: "reports", status: "IN_PROGRESS" } });
    const plannedTask = { ...task, waitingReason: null, blockedReason: null, failureReason: null } as any;
    const outcome = await processClaimedTask(plannedTask, 3);
    expect(outcome.status).toBe("DONE");
    await prisma.task.delete({ where: { id: task.id } });
  });

  it("processClaimedTask marks a task WAITING when its tool is NOT_IMPLEMENTED - never fabricates success", async () => {
    const task = await prisma.task.create({ data: { title: "browse something", toolName: "browser", status: "IN_PROGRESS" } });
    const plannedTask = { ...task, waitingReason: null, blockedReason: null, failureReason: null } as any;
    const outcome = await processClaimedTask(plannedTask, 3);
    expect(outcome.status).toBe("WAITING");
    await prisma.task.delete({ where: { id: task.id } });
  });

  it("a full tick claims, runs, and completes an eligible tool-tagged task, publishing a TASK event", async () => {
    const w = new Worker(`tick-test-${Date.now()}`);
    await w.start();
    try {
      const task = await prisma.task.create({ data: { title: "tick report", toolName: "reports", status: "PENDING" } });
      const eventsBefore = await prisma.event.count({ where: { type: "TASK.worker_outcome" } });

      // Run several ticks to give the async slot time to finish.
      for (let i = 0; i < 5; i++) {
        await w.tick();
        await new Promise((r) => setTimeout(r, 50));
        const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
        if (updated.status === "DONE") break;
      }

      const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(finalTask.status).toBe("DONE");
      expect(finalTask.claimedBy).toBeNull();

      const eventsAfter = await prisma.event.count({ where: { type: "TASK.worker_outcome" } });
      expect(eventsAfter).toBeGreaterThan(eventsBefore);

      const report = await getLatestDailyReport();
      expect(report).not.toBeNull();

      await prisma.task.delete({ where: { id: task.id } });
    } finally {
      await w.stop();
    }
  });

  it("NO-BYPASS: the worker cannot execute a disabled tool, even though it calls the tool directly (mirrors Phase 2's enforcement proof)", async () => {
    await disableTool("reports", "test");
    const w = new Worker(`no-bypass-tool-${Date.now()}`);
    await w.start();
    try {
      const task = await prisma.task.create({ data: { title: "should stay blocked", toolName: "reports", status: "PENDING" } });
      for (let i = 0; i < 3; i++) {
        await w.tick();
      }
      const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      // Eligibility pre-filter catches the disabled tool and marks BLOCKED
      // without ever calling toolRegistry.execute - but even if it hadn't,
      // core/enforcement would refuse the call. Either way, it never runs.
      expect(finalTask.status).toBe("BLOCKED");
      expect(finalTask.blockedReason).toMatch(/disabled/i);
      await prisma.task.delete({ where: { id: task.id } });
    } finally {
      await w.stop();
      await enableTool("reports");
    }
  });

  it("NO-BYPASS: the worker cannot execute a policy-BLOCKED action", async () => {
    const w = new Worker(`no-bypass-policy-${Date.now()}`);
    await w.start();
    try {
      const task = await prisma.task.create({ data: { title: "financial.transaction", status: "PENDING" } });
      for (let i = 0; i < 3; i++) {
        await w.tick();
      }
      const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(finalTask.status).toBe("BLOCKED");
      await prisma.task.delete({ where: { id: task.id } });
    } finally {
      await w.stop();
    }
  });

  it("a tick pauses when the system is not RUNNING, and heartbeat reflects IDLE", async () => {
    const w = new Worker(`paused-tick-${Date.now()}`);
    await w.start();
    try {
      await setSystemState("PAUSED", "test", "test");
      const result = await w.tick();
      expect(result.processed).toBe(0);
      const hb = await getHeartbeat(w.workerId);
      expect(hb?.status).toBe("IDLE");
    } finally {
      await setSystemState("RUNNING", "test cleanup", "test");
      await w.stop();
    }
  });

  it("#9 owner interruption: a WAITING task does not block other eligible tasks from being processed", async () => {
    const w = new Worker(`interrupt-test-${Date.now()}`);
    await w.start();
    try {
      const waitingTask = await prisma.task.create({
        data: { title: "needs info", status: "WAITING", waitingReason: "missing input" },
      });
      const readyTask = await prisma.task.create({ data: { title: "ready report", toolName: "reports", status: "PENDING" } });

      for (let i = 0; i < 5; i++) {
        await w.tick();
        await new Promise((r) => setTimeout(r, 50));
        const updated = await prisma.task.findUniqueOrThrow({ where: { id: readyTask.id } });
        if (updated.status === "DONE") break;
      }

      const finalReady = await prisma.task.findUniqueOrThrow({ where: { id: readyTask.id } });
      expect(finalReady.status).toBe("DONE");
      const stillWaiting = await prisma.task.findUniqueOrThrow({ where: { id: waitingTask.id } });
      expect(stillWaiting.status).toBe("WAITING");

      await prisma.task.deleteMany({ where: { id: { in: [waitingTask.id, readyTask.id] } } });
    } finally {
      await w.stop();
    }
  });
});
