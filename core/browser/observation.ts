// core/browser/observation.ts - Bounded Observation Model (Phase 10,
// sections 34-38).
//
// If browser-observed page content ever reaches an LLM prompt (e.g. a
// future Brain step deciding what to do next based on page state), it must
// go through a BOUNDED structure - relevant text/title/URL, NOT the entire
// raw HTML - then through core/research/trustBoundary.ts's
// wrapExternalBrowserContent() before interpolation into any prompt. This
// directly reduces both prompt-injection surface and token cost. As of this
// phase there is no live LLM call site that consumes this (deterministic,
// DOM-based action selection only - see tools/browser/browserTool.ts's
// header comment), matching the exact precedent Phase 8/9 set for
// wrapExternalWhatsAppContent()/wrapExternalVoiceContent(): the boundary
// exists before the capability that would need it, not after.
export interface BoundedObservation {
  url: string;
  domain: string;
  title: string | null;
  /** Truncated, whitespace-collapsed visible text - never raw HTML. */
  text: string;
  truncated: boolean;
  observedAt: string;
}

const MAX_OBSERVATION_CHARS = 4000;

export function buildBoundedObservation(input: { url: string; domain: string; title: string | null; rawText: string }): BoundedObservation {
  const collapsed = input.rawText.replace(/\s+/g, " ").trim();
  const truncated = collapsed.length > MAX_OBSERVATION_CHARS;
  return {
    url: input.url,
    domain: input.domain,
    title: input.title,
    text: truncated ? collapsed.slice(0, MAX_OBSERVATION_CHARS) : collapsed,
    truncated,
    observedAt: new Date().toISOString(),
  };
}
