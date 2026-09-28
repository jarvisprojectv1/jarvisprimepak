// core/research/synthesisTypes.ts - the Structured Research Synthesis
// Contract (Phase 6.1, items 4-7). Pure types + schema validation, mirroring
// core/brain/plan.ts's Plan type/validatePlan() pattern exactly: the LLM
// produces this as JSON, it is parsed tolerantly (fenced code block allowed)
// and then validated BEFORE anything in it is trusted - a malformed shape
// fails closed, just like a malformed Plan.
export type FindingClassification = "FACT" | "SOURCE_CLAIM" | "ANALYSIS" | "UNCERTAINTY";

export interface ResearchFinding {
  id: string;
  statement: string;
  classification: FindingClassification;
  /** ResearchEvidence ids (this run's) that support this finding. Empty = unsupported, rejected by the grounding validator. */
  evidenceIds: string[];
  /** ResearchSource ids (this run's) this finding draws on. */
  sourceIds: string[];
}

export interface ResearchContradiction {
  description: string;
  conflictingSourceIds: string[];
}

export interface ResearchSynthesis {
  summary: string;
  findings: ResearchFinding[];
  /** Evidence ids actually cited by the surviving findings (recomputed post-grounding, never trusted verbatim from the model - see synthesis.ts). */
  evidence: string[];
  uncertainties: string[];
  contradictions: ResearchContradiction[];
  /** Source ids actually cited by the surviving findings (recomputed post-grounding). */
  sources: string[];
  /** 0 (low confidence) - 1 (certain). Never fabricated as 1.0 - reflects real corroboration/uncertainty. */
  confidence: number;
  followUpQuestions: string[];
}

export interface SynthesisSchemaValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Raw, not-yet-grounded shape of what the model may have produced. Only
 * checks the JSON *shape* is sane (types present, arrays are arrays) - it
 * does NOT check that ids referenced actually exist (that is the grounding
 * validator's job, run separately, since it needs the run's real evidence/
 * source id sets which this pure-shape validator has no access to).
 */
export function validateSynthesisShape(candidate: unknown): SynthesisSchemaValidation {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    return { valid: false, errors: ["Synthesis output must be a JSON object."] };
  }
  const s = candidate as Partial<ResearchSynthesis>;

  if (typeof s.summary !== "string" || s.summary.trim().length === 0) {
    errors.push("synthesis.summary is required and must be a non-empty string.");
  }
  if (!Array.isArray(s.findings)) {
    errors.push("synthesis.findings must be an array.");
  } else {
    s.findings.forEach((f, i) => {
      const label = `findings[${i}]`;
      if (!f || typeof f !== "object") {
        errors.push(`${label} must be an object.`);
        return;
      }
      const finding = f as Partial<ResearchFinding>;
      if (typeof finding.id !== "string" || !finding.id) errors.push(`${label}.id is required.`);
      if (typeof finding.statement !== "string" || !finding.statement) errors.push(`${label}.statement is required.`);
      if (!["FACT", "SOURCE_CLAIM", "ANALYSIS", "UNCERTAINTY"].includes(finding.classification as string)) {
        errors.push(`${label}.classification must be one of FACT|SOURCE_CLAIM|ANALYSIS|UNCERTAINTY.`);
      }
      if (!Array.isArray(finding.evidenceIds) || finding.evidenceIds.some((id) => typeof id !== "string")) {
        errors.push(`${label}.evidenceIds must be an array of strings.`);
      }
      if (finding.sourceIds !== undefined && (!Array.isArray(finding.sourceIds) || finding.sourceIds.some((id) => typeof id !== "string"))) {
        errors.push(`${label}.sourceIds must be an array of strings if present.`);
      }
    });
  }
  if (s.uncertainties !== undefined && (!Array.isArray(s.uncertainties) || s.uncertainties.some((u) => typeof u !== "string"))) {
    errors.push("synthesis.uncertainties must be an array of strings if present.");
  }
  if (s.contradictions !== undefined) {
    if (!Array.isArray(s.contradictions)) {
      errors.push("synthesis.contradictions must be an array if present.");
    } else {
      s.contradictions.forEach((c, i) => {
        const contradiction = c as Partial<ResearchContradiction>;
        if (!contradiction || typeof contradiction.description !== "string") {
          errors.push(`contradictions[${i}].description is required.`);
        }
        if (!Array.isArray(contradiction?.conflictingSourceIds)) {
          errors.push(`contradictions[${i}].conflictingSourceIds must be an array.`);
        }
      });
    }
  }
  if (s.followUpQuestions !== undefined && (!Array.isArray(s.followUpQuestions) || s.followUpQuestions.some((q) => typeof q !== "string"))) {
    errors.push("synthesis.followUpQuestions must be an array of strings if present.");
  }
  if (s.confidence !== undefined && (typeof s.confidence !== "number" || s.confidence < 0 || s.confidence > 1)) {
    errors.push("synthesis.confidence must be a number between 0 and 1 if present.");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parses the LLM's raw text output as JSON and validates its shape.
 * Reuses the exact same tolerance as core/brain/plan.ts's
 * parseAndValidatePlan(): tolerate a fenced ```json code block, otherwise
 * parse the raw text directly. Malformed JSON and a schema-invalid shape are
 * both handled identically - fail closed, nothing downstream is trusted.
 */
export function parseAndValidateSynthesis(
  raw: string
): { synthesis: ResearchSynthesis } | { synthesis: null; errors: string[] } {
  let parsed: unknown;
  try {
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const jsonText = fenceMatch ? fenceMatch[1] : raw;
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { synthesis: null, errors: [`Synthesis output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const validation = validateSynthesisShape(parsed);
  if (!validation.valid) {
    return { synthesis: null, errors: validation.errors };
  }
  const s = parsed as ResearchSynthesis;
  return {
    synthesis: {
      summary: s.summary,
      findings: s.findings,
      evidence: Array.isArray(s.evidence) ? s.evidence : [],
      uncertainties: Array.isArray(s.uncertainties) ? s.uncertainties : [],
      contradictions: Array.isArray(s.contradictions) ? s.contradictions : [],
      sources: Array.isArray(s.sources) ? s.sources : [],
      confidence: typeof s.confidence === "number" ? s.confidence : 0.5,
      followUpQuestions: Array.isArray(s.followUpQuestions) ? s.followUpQuestions : [],
    },
  };
}
