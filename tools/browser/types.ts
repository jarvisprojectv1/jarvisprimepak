// tools/browser/types.ts - Provider abstractions (Phase 10, sections 2-5).

export interface BrowserActionOutcome {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * The browser-automation provider interface. Implemented for real by
 * PlaywrightBrowserProvider (tools/browser/playwrightProvider.ts). Every
 * unsupported/deferred operation returns an honest NOT_IMPLEMENTED outcome
 * rather than a fabricated success - see each method's implementation for
 * per-operation honesty notes.
 */
export interface BrowserProvider {
  name: string;
  isConfigured(): boolean;
  createSession(input: { taskId?: string | null; createdBy: string }): Promise<{ sessionId: string } | { code: "ERROR"; message: string }>;
  closeSession(sessionId: string): Promise<BrowserActionOutcome>;
  navigate(sessionId: string, url: string): Promise<BrowserActionOutcome>;
  goBack(sessionId: string): Promise<BrowserActionOutcome>;
  goForward(sessionId: string): Promise<BrowserActionOutcome>;
  reload(sessionId: string): Promise<BrowserActionOutcome>;
  getCurrentUrl(sessionId: string): Promise<BrowserActionOutcome>;
  getPageTitle(sessionId: string): Promise<BrowserActionOutcome>;
  getPageContent(sessionId: string): Promise<BrowserActionOutcome>;
  screenshot(sessionId: string): Promise<BrowserActionOutcome>;
  click(sessionId: string, target: { selector?: string; text?: string }): Promise<BrowserActionOutcome>;
  type(sessionId: string, target: { selector?: string; text?: string }, value: string): Promise<BrowserActionOutcome>;
  select(sessionId: string, target: { selector: string }, value: string): Promise<BrowserActionOutcome>;
  scroll(sessionId: string, direction: "down" | "up"): Promise<BrowserActionOutcome>;
  wait(sessionId: string, ms: number): Promise<BrowserActionOutcome>;
  findElement(sessionId: string, target: { selector?: string; text?: string }): Promise<BrowserActionOutcome>;
  inspectPage(sessionId: string): Promise<BrowserActionOutcome>;
  download(sessionId: string, url: string, filename: string): Promise<BrowserActionOutcome>;
  upload(sessionId: string, target: { selector: string }, sandboxRelativePath: string): Promise<BrowserActionOutcome>;
  openTab(sessionId: string, url?: string): Promise<BrowserActionOutcome>;
  closeTab(sessionId: string, tabIndex: number): Promise<BrowserActionOutcome>;
}

/**
 * Computer-control (desktop/OS-level automation) provider interface -
 * defined for architecture completeness only. See
 * tools/computer/mockProvider.ts: this phase implements ONLY a mock, every
 * operation honestly NOT_IMPLEMENTED. Real desktop-level mouse/keyboard/
 * screen control requires a GUI environment this sandbox does not have;
 * building a fake provider that claims to control a desktop would violate
 * this project's honesty discipline (section 71).
 */
export interface ComputerProvider {
  name: string;
  isConfigured(): boolean;
  moveMouse(x: number, y: number): Promise<BrowserActionOutcome>;
  clickMouse(x: number, y: number): Promise<BrowserActionOutcome>;
  doubleClick(x: number, y: number): Promise<BrowserActionOutcome>;
  rightClick(x: number, y: number): Promise<BrowserActionOutcome>;
  scroll(direction: "up" | "down", amount: number): Promise<BrowserActionOutcome>;
  typeText(text: string): Promise<BrowserActionOutcome>;
  pressKey(key: string): Promise<BrowserActionOutcome>;
  screenshot(): Promise<BrowserActionOutcome>;
  locateVisualTarget(description: string): Promise<BrowserActionOutcome>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<BrowserActionOutcome>;
  resize(width: number, height: number): Promise<BrowserActionOutcome>;
  focusWindow(title: string): Promise<BrowserActionOutcome>;
}
