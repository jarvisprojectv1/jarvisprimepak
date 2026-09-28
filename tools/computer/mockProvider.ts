// tools/computer/mockProvider.ts - MockComputerProvider (Phase 10, sections
// 2, 38-42, 71).
//
// HONESTY NOTE: real OS-level desktop automation (moving the actual mouse,
// typing into the actual keyboard focus, reading the actual screen) requires
// a GUI environment this sandbox does not have. Building a "ComputerProvider"
// that claims to do any of this without one would violate this project's
// REAL/CONFIGURATION_REQUIRED/NOT_IMPLEMENTED honesty discipline (section
// 71's exact three-state model, reused as-is - not a fourth status). Every
// method here honestly returns NOT_IMPLEMENTED. This class exists only so
// the ComputerProvider interface (tools/browser/types.ts) has one concrete
// implementation for architecture completeness/tests, exactly like
// tools/voice/mockProvider.ts exists for VoiceProvider.
import type { BrowserActionOutcome, ComputerProvider } from "../browser/types";

function notImplemented(op: string): BrowserActionOutcome {
  return { ok: false, message: `NOT_IMPLEMENTED: computer.${op} - no real desktop/OS-level automation is wired up in this sandbox (no GUI environment). See docs/PHASE10_BROWSER_COMPUTER.md.` };
}

export class MockComputerProvider implements ComputerProvider {
  name = "mock-computer";
  isConfigured(): boolean {
    return false;
  }
  async moveMouse(): Promise<BrowserActionOutcome> { return notImplemented("moveMouse"); }
  async clickMouse(): Promise<BrowserActionOutcome> { return notImplemented("clickMouse"); }
  async doubleClick(): Promise<BrowserActionOutcome> { return notImplemented("doubleClick"); }
  async rightClick(): Promise<BrowserActionOutcome> { return notImplemented("rightClick"); }
  async scroll(): Promise<BrowserActionOutcome> { return notImplemented("scroll"); }
  async typeText(): Promise<BrowserActionOutcome> { return notImplemented("typeText"); }
  async pressKey(): Promise<BrowserActionOutcome> { return notImplemented("pressKey"); }
  async screenshot(): Promise<BrowserActionOutcome> { return notImplemented("screenshot"); }
  async locateVisualTarget(): Promise<BrowserActionOutcome> { return notImplemented("locateVisualTarget"); }
  async drag(): Promise<BrowserActionOutcome> { return notImplemented("drag"); }
  async resize(): Promise<BrowserActionOutcome> { return notImplemented("resize"); }
  async focusWindow(): Promise<BrowserActionOutcome> { return notImplemented("focusWindow"); }
}
