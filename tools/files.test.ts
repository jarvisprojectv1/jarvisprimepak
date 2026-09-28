import { describe, it, expect } from "vitest";
import { filesTool } from "./files";

describe("tools/files (real sandboxed file I/O)", () => {
  const testFile = `vitest-${Date.now()}.txt`;

  it("writes a file inside the sandbox", async () => {
    const result = await filesTool.execute({
      action: "write",
      path: testFile,
      content: "hello jarvis",
    });
    expect(result.status).toBe("OK");
  });

  it("reads the file back", async () => {
    const result = await filesTool.execute({ action: "read", path: testFile });
    expect(result.status).toBe("OK");
    expect((result.data as { content: string }).content).toBe("hello jarvis");
  });

  it("lists the sandbox directory", async () => {
    const result = await filesTool.execute({ action: "list", path: "." });
    expect(result.status).toBe("OK");
    const names = (result.data as { name: string }[]).map((e) => e.name);
    expect(names).toContain(testFile);
  });

  it("refuses to read outside the sandbox", async () => {
    const result = await filesTool.execute({ action: "read", path: "../../etc/passwd" });
    expect(result.status).toBe("ERROR");
  });
});
