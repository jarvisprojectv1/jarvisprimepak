// core/skills/registry.ts - Skill Registry + lifecycle (Phase 6, items
// 11-14). FOUNDATION ONLY, by explicit design (see docs/PHASE6_WEB_RESEARCH.md):
//
//   DISCOVERED -> CANDIDATE -> ANALYZING -> (REJECTED | TESTING) -> VERIFIED
//   -> ACTIVATABLE -> ACTIVE (OWNER-only, never automatic) | DISABLED | DEPRECATED
//
// ACTIVATABLE is the ceiling any automatic process may reach. Moving a skill
// from ACTIVATABLE to ACTIVE requires an explicit OWNER action (see
// apps/api/src/routes/skills.ts) and, even then, does NOT wire the skill
// into the tool/agent registry - that would require dynamic code loading,
// which is explicitly out of scope (see the non-negotiables: "no automatic
// execution of arbitrary downloaded code"). "ACTIVE" here is a tracked
// status only, not live capability injection - this file's own comments and
// the phase report are both explicit about that limitation.
//
// "Test in sandbox" (a real code-execution sandbox) is honestly scoped out:
// TESTING is a real, reachable status, but nothing in this phase actually
// executes candidate code to get there - see runTestingStub() below, which
// returns NOT_IMPLEMENTED rather than fabricate a PASSED test result.
import { prisma } from "../../database/client";
import { writeAuditLog } from "../../security/audit";
import { identityToActorString, type Identity } from "../auth/identity";
import { runStaticAnalysis } from "./staticAnalysis";

export type ActivationStatus =
  | "DISCOVERED"
  | "CANDIDATE"
  | "ANALYZING"
  | "TESTING"
  | "VERIFIED"
  | "ACTIVATABLE"
  | "ACTIVE"
  | "REJECTED"
  | "DISABLED"
  | "DEPRECATED";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface CreateCandidateInput {
  name: string;
  description?: string;
  source: string;
  capabilities?: string[];
  requiredPermissions?: string[];
  dependencies?: string[];
  riskLevel?: RiskLevel;
}

async function auditTransition(identity: Identity, candidateId: string, from: string, to: string, detail?: string) {
  await writeAuditLog({
    actor: identityToActorString(identity),
    action: "skills.transition",
    target: candidateId,
    meta: { from, to, detail },
  });
}

export async function createCandidate(input: CreateCandidateInput, identity: Identity) {
  const candidate = await prisma.skillCandidate.create({
    data: {
      name: input.name,
      description: input.description,
      source: input.source,
      capabilities: input.capabilities ? JSON.stringify(input.capabilities) : null,
      requiredPermissions: input.requiredPermissions ? JSON.stringify(input.requiredPermissions) : null,
      dependencies: input.dependencies ? JSON.stringify(input.dependencies) : null,
      riskLevel: input.riskLevel ?? "MEDIUM",
      activationStatus: "DISCOVERED",
    },
  });
  await auditTransition(identity, candidate.id, "none", "DISCOVERED", `Candidate "${input.name}" discovered.`);
  return candidate;
}

/** DISCOVERED -> CANDIDATE: a discovered skill gap becomes a formal candidate (no code analysis yet). */
export async function promoteToCandidate(id: string, identity: Identity) {
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "DISCOVERED") {
    throw new Error(`Cannot promote to CANDIDATE from "${row.activationStatus}".`);
  }
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "CANDIDATE" } });
  await auditTransition(identity, id, "DISCOVERED", "CANDIDATE");
  return updated;
}

/**
 * CANDIDATE -> ANALYZING -> (REJECTED | TESTING): runs real static analysis
 * over `sourceText`. Any dangerous pattern hit REJECTS the candidate
 * terminally; a clean scan advances it to TESTING.
 */
export async function analyzeCandidate(id: string, sourceText: string, identity: Identity) {
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "CANDIDATE") {
    throw new Error(`Cannot analyze from "${row.activationStatus}".`);
  }
  await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "ANALYZING" } });
  await auditTransition(identity, id, "CANDIDATE", "ANALYZING");

  const analysis = runStaticAnalysis(sourceText);
  if (!analysis.passed) {
    const reason = `Static analysis rejected: ${analysis.findings.map((f) => f.pattern).join(", ")}`;
    const updated = await prisma.skillCandidate.update({
      where: { id },
      data: { activationStatus: "REJECTED", securityStatus: "REJECTED", rejectionReason: reason },
    });
    await auditTransition(identity, id, "ANALYZING", "REJECTED", reason);
    return { candidate: updated, analysis };
  }

  const updated = await prisma.skillCandidate.update({
    where: { id },
    data: { activationStatus: "TESTING", securityStatus: "PASSED" },
  });
  await auditTransition(identity, id, "ANALYZING", "TESTING", "Static analysis passed.");
  return { candidate: updated, analysis };
}

/**
 * TESTING -> VERIFIED: honestly scoped stub. A real code-execution sandbox
 * for arbitrary discovered skill code is out of scope for this phase (see
 * file header and the non-negotiables). This records testStatus as
 * NOT_IMPLEMENTED and does NOT advance the candidate automatically - a human
 * (OWNER) must review and manually move it forward via verifyCandidate()
 * below, which stands in for "I have reviewed this skill myself".
 */
export async function runTestingStub(id: string, identity: Identity) {
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "TESTING") {
    throw new Error(`Cannot run testing stub from "${row.activationStatus}".`);
  }
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { testStatus: "NOT_IMPLEMENTED" } });
  await auditTransition(identity, id, "TESTING", "TESTING", "Sandboxed execution testing is NOT_IMPLEMENTED in this phase - requires manual OWNER review to proceed.");
  return updated;
}

/** TESTING -> VERIFIED: an explicit, human (OWNER) confirmation step - never automatic. */
export async function verifyCandidate(id: string, identity: Identity) {
  if (identity.kind !== "OWNER") {
    throw new Error("Only OWNER may verify a skill candidate.");
  }
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "TESTING") {
    throw new Error(`Cannot verify from "${row.activationStatus}".`);
  }
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "VERIFIED" } });
  await auditTransition(identity, id, "TESTING", "VERIFIED", "Manually verified by OWNER.");
  return updated;
}

/** VERIFIED -> ACTIVATABLE: the ceiling any automatic process may reach. */
export async function markActivatable(id: string, identity: Identity) {
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "VERIFIED") {
    throw new Error(`Cannot mark ACTIVATABLE from "${row.activationStatus}".`);
  }
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "ACTIVATABLE" } });
  await auditTransition(identity, id, "VERIFIED", "ACTIVATABLE");
  return updated;
}

/**
 * ACTIVATABLE -> ACTIVE: OWNER-only, never automatic (enforced here, not
 * just by the API route's requireAuthz - defense in depth). IMPORTANT: this
 * does NOT wire the skill into any tool/agent registry - it flips a tracked
 * status field only. No code from `source`/`capabilities` is ever loaded,
 * imported, or executed by this function or anything it calls.
 */
export async function activateSkill(id: string, identity: Identity) {
  if (identity.kind !== "OWNER") {
    throw new Error("Only OWNER may activate a skill.");
  }
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  if (row.activationStatus !== "ACTIVATABLE") {
    throw new Error(`Cannot activate from "${row.activationStatus}".`);
  }
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "ACTIVE" } });
  await auditTransition(identity, id, "ACTIVATABLE", "ACTIVE", "Activated by OWNER. Status tracking only - no capability injection occurs.");
  return updated;
}

export async function rejectCandidate(id: string, reason: string, identity: Identity) {
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.skillCandidate.update({
    where: { id },
    data: { activationStatus: "REJECTED", rejectionReason: reason },
  });
  await auditTransition(identity, id, row.activationStatus, "REJECTED", reason);
  return updated;
}

export async function disableSkill(id: string, identity: Identity) {
  if (identity.kind !== "OWNER") {
    throw new Error("Only OWNER may disable an active skill.");
  }
  const row = await prisma.skillCandidate.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.skillCandidate.update({ where: { id }, data: { activationStatus: "DISABLED" } });
  await auditTransition(identity, id, row.activationStatus, "DISABLED");
  return updated;
}

export async function getCandidate(id: string) {
  return prisma.skillCandidate.findUnique({ where: { id } });
}

export async function listCandidates() {
  return prisma.skillCandidate.findMany({ orderBy: { createdAt: "desc" } });
}
