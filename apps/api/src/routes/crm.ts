// apps/api/src/routes/crm.ts - CRM dashboard + pipeline routes (Phase 7,
// items 12, 21, 24). Every dashboard number is a real DB aggregate - no
// fabricated counts (see core/reports/crmDashboard.test.ts's item AC).
import { Router } from "express";
import { prisma } from "../../../../database/client";
import { requireAuth, requireAuthz } from "../middleware/auth";
import { runLeadResearchWorkflow } from "../../../../core/crm/leadWorkflow";
import { listProductCategories, upsertProductCategory } from "../../../../core/crm/businessConfig";
import { prepareQuote, markQuoteReadyForApproval } from "../../../../core/business/quote";
import { listActivityForEntity } from "../../../../core/crm/activity";

export const crmRouter = Router();

crmRouter.get("/dashboard", requireAuth, requireAuthz("crm.read"), async (_req, res) => {
  const [leadsByStatus, followUpsDue, pendingApprovals, unresolvedDuplicates, totalCompanies, totalContacts] = await Promise.all([
    prisma.lead.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.task.count({ where: { title: { contains: "Follow" }, status: { in: ["PENDING", "QUEUED", "WAITING"] } } }),
    prisma.approvalRequest.count({ where: { status: "PENDING" } }),
    prisma.company.count({ where: { possibleDuplicate: true } }).then(async (c) => c + (await prisma.contact.count({ where: { possibleDuplicate: true } }))),
    prisma.company.count(),
    prisma.contact.count(),
  ]);

  res.json({
    leadsByStatus: leadsByStatus.map((r) => ({ status: r.status, count: r._count.status })),
    followUpsDue,
    pendingApprovals,
    unresolvedPossibleDuplicates: unresolvedDuplicates,
    totalCompanies,
    totalContacts,
  });
});

crmRouter.get("/leads", requireAuth, requireAuthz("crm.read"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const leads = await prisma.lead.findMany({ where: status ? { status } : undefined, orderBy: { updatedAt: "desc" }, take: 100, include: { company: true, contact: true } });
  res.json({ leads });
});

crmRouter.get("/leads/:id", requireAuth, requireAuthz("crm.read"), async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, include: { company: true, contact: true } });
  if (!lead) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  const activity = lead.contactId ? await listActivityForEntity(lead.id) : [];
  res.json({ lead, activity });
});

// Item 12: kicks off the research -> CRM -> qualify -> next-action task tree.
crmRouter.post("/leads/from-research", requireAuth, requireAuthz("crm.write"), async (req, res) => {
  const { companyName, website, contactFirstName, contactLastName, contactEmail, source } = req.body ?? {};
  if (typeof companyName !== "string" || !companyName.trim()) {
    res.status(400).json({ error: "companyName is required." });
    return;
  }
  const result = await runLeadResearchWorkflow({ companyName, website, contactFirstName, contactLastName, contactEmail, source });
  res.json({ result });
});

crmRouter.get("/business-config/product-categories", requireAuth, requireAuthz("crm.read"), async (_req, res) => {
  res.json({ productCategories: await listProductCategories() });
});

crmRouter.post("/business-config/product-categories", requireAuth, requireAuthz("crm.write"), async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required." });
    return;
  }
  const category = await upsertProductCategory(req.body);
  res.json({ category });
});

// Item 21: quote preparation - never autonomously priced beyond configured costing rules.
crmRouter.post("/quotes/prepare", requireAuth, requireAuthz("crm.write"), async (req, res) => {
  const { lineItems, clientId, companyId, leadId } = req.body ?? {};
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    res.status(400).json({ error: "lineItems (non-empty array) is required." });
    return;
  }
  const quote = await prepareQuote({ lineItems, clientId, companyId, leadId });
  res.json({ quote });
});

crmRouter.post("/quotes/:id/ready-for-approval", requireAuth, requireAuthz("crm.write"), async (req, res) => {
  try {
    await markQuoteReadyForApproval(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
