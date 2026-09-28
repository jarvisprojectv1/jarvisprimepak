// apps/api/src/routes/approvals.ts - the Owner Approval Queue HTTP surface
// (Phase 7, item 26). Approve/reject require "approval.decide", which
// core/authz grants ONLY to OWNER (see core/authz/index.ts) - a SYSTEM/
// AGENT/SERVICE identity can never approve its own queued request.
import { Router } from "express";
import { listApprovalRequests, getApprovalRequest, approveRequest, rejectRequest } from "../../../../core/approvals";
import { requireAuth, requireAuthz } from "../middleware/auth";

export const approvalsRouter = Router();

approvalsRouter.get("/", requireAuth, requireAuthz("approval.read"), async (req, res) => {
  const status = typeof req.query.status === "string" ? (req.query.status as "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED") : undefined;
  res.json({ approvals: await listApprovalRequests(status) });
});

approvalsRouter.get("/:id", requireAuth, requireAuthz("approval.read"), async (req, res) => {
  const approval = await getApprovalRequest(req.params.id);
  if (!approval) {
    res.status(404).json({ error: "Approval request not found." });
    return;
  }
  res.json({ approval });
});

approvalsRouter.post("/:id/approve", requireAuth, requireAuthz("approval.decide"), async (req, res) => {
  try {
    const approval = await approveRequest(req.params.id, req.identity!.label, req.body?.note);
    res.json({ approval });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

approvalsRouter.post("/:id/reject", requireAuth, requireAuthz("approval.decide"), async (req, res) => {
  try {
    const approval = await rejectRequest(req.params.id, req.identity!.label, req.body?.note);
    res.json({ approval });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
