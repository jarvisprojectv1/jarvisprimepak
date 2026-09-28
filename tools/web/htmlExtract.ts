// tools/web/htmlExtract.ts - dependency-light HTML text extraction (Phase 6,
// item 3). Regex/string based, not a full DOM - sufficient for "get the
// title and readable text, strip scripts/styles". Never executes any script
// content; script/style bodies are discarded, not run.

export interface ExtractedHtml {
  title: string | null;
  text: string;
  canonicalUrl: string | null;
}

function stripTags(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractHtml(html: string): ExtractedHtml {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : null;

  const canonicalMatch = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(html);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : null;

  // Also drop HTML comments (a common place to hide prompt-injection text on
  // an adversarial page) - they are never treated as instructions regardless,
  // but stripping them keeps extracted text closer to what a human reader
  // would actually see.
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ");
  cleaned = stripTags(cleaned, "script");
  cleaned = stripTags(cleaned, "style");
  cleaned = stripTags(cleaned, "noscript");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = decodeEntities(cleaned);
  const text = cleaned.replace(/\s+/g, " ").trim();

  return { title, text, canonicalUrl };
}
