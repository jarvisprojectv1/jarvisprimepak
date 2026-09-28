// core/events/sources.ts - Event Source interfaces (Phase 5, requirement
// #13: "foundation only").
//
// Only SYSTEM, SCHEDULE, TASK, and USER categories have a real publish path
// in this phase (SYSTEM/SCHEDULE from Phase 2/3, TASK now published by
// core/worker per the loop, USER via the resume-task route - see
// apps/api/src/routes/tasks.ts). CRM/EMAIL/WEB/MARKET/VOICE/CALENDAR each get
// a real TypeScript interface here and an explicit NOT_IMPLEMENTED stub
// class - never a fake success, following the same honesty pattern as
// tools/browser.ts, tools/voice.ts, etc. Building a real adapter for any of
// these (a CRM webhook receiver, an IMAP/Graph email poller, a web
// monitoring crawler, a market-data feed, a voice/telephony inbound
// listener, a calendar push-notification receiver) is explicitly out of
// scope for this phase.
import type { EventInput, PersistedEvent } from "./index";

export interface EventSource {
  /** A short, stable name for logs/health checks. */
  readonly name: string;
  /** Starts listening/polling. Must be idempotent (calling twice is a no-op). */
  start(): Promise<void>;
  /** Stops listening/polling. Must be safe to call even if never started. */
  stop(): Promise<void>;
  /** Whether start() has been called and stop() has not. */
  isRunning(): boolean;
}

/** Base publish helper every real adapter would use - never called directly by a NOT_IMPLEMENTED stub. */
export type PublishFn = (event: EventInput) => Promise<PersistedEvent>;

function notImplementedSource(name: string): EventSource {
  let running = false;
  return {
    name,
    async start() {
      running = false; // NOT_IMPLEMENTED: never actually starts anything.
    },
    async stop() {
      running = false;
    },
    isRunning() {
      return running;
    },
  };
}

/** CRM changes (e.g. a lead created/updated in an external CRM) -> CRM.* events. */
export interface CRMEventSource extends EventSource {}
export class NotImplementedCRMEventSource implements CRMEventSource {
  private readonly base = notImplementedSource("crm-event-source");
  name = this.base.name;
  start = this.base.start;
  stop = this.base.stop;
  isRunning = this.base.isRunning;
}

/** Inbound email (e.g. IMAP/Graph push) -> EMAIL.* events (reserved category - no schema yet either). */
export interface EmailEventSource extends EventSource {}
export class NotImplementedEmailEventSource implements EmailEventSource {
  private readonly base = notImplementedSource("email-event-source");
  name = this.base.name;
  start = this.base.start;
  stop = this.base.stop;
  isRunning = this.base.isRunning;
}

/**
 * Web monitoring (Phase 6, item 7): a bounded, CONFIGURED polling source over
 * `ResearchTopic` rows -> WEB.* events. This is now REAL (not a stub) - see
 * core/events/webEventSource.ts for the implementation. The interface stays
 * here so every other EventSource keeps its documented shape in one place.
 */
export interface WebEventSource extends EventSource {}

/** Market/pricing data feed -> MARKET.* events (reserved). */
export interface MarketEventSource extends EventSource {}
export class NotImplementedMarketEventSource implements MarketEventSource {
  private readonly base = notImplementedSource("market-event-source");
  name = this.base.name;
  start = this.base.start;
  stop = this.base.stop;
  isRunning = this.base.isRunning;
}

/** Inbound voice/telephony events -> VOICE.* events (reserved). Explicitly NOT cold-calling/voice biometrics - out of scope entirely, not just unimplemented. */
export interface VoiceEventSource extends EventSource {}
export class NotImplementedVoiceEventSource implements VoiceEventSource {
  private readonly base = notImplementedSource("voice-event-source");
  name = this.base.name;
  start = this.base.start;
  stop = this.base.stop;
  isRunning = this.base.isRunning;
}

/** Calendar push notifications (e.g. Google Calendar watch channel) -> CALENDAR.* events (reserved). */
export interface CalendarEventSource extends EventSource {}
export class NotImplementedCalendarEventSource implements CalendarEventSource {
  private readonly base = notImplementedSource("calendar-event-source");
  name = this.base.name;
  start = this.base.start;
  stop = this.base.stop;
  isRunning = this.base.isRunning;
}
