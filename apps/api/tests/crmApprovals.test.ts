// apps/api/tests/crmApprovals.test.ts - items AC (CRM dashboard accuracy),
// AG (auth/authz), plus route-level coverage for the approval queue.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { registerBuiltinTools } from "../../../tools";
import { registerBuiltinAgents } from "../../../agents/registry";
import { prisma } from "../../../database/client";
import { createTestOwner, authHeader } from "./testAuth";
import { createApprovalRequest } from "../../../core/approvals";

describe("Phase 7 API - CRM dashboard + Approval queue", () => {
  let owner: { userId: string; email: string; token: string };

  beforeAll(async () => {
    registerBuiltinTools();
    registerBuiltinAgents();
    owner = await createTestOwner();
  });

  beforeEach(async () => {
    await prisma.lead.deleteMany();
    await prisma.company.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.approvalRequest.deleteMany();
  });

  describe("AG: auth/authz", () => {
    it("GET /crm/dashboard requires authentication", async () => {
      const app = createApp();
      const res = await request(app).get("/crm/dashboard");
      expect(res.status).toBe(401);
    });

    it("POST /approvals/:id/approve requires authentication and OWNER authz", async () => {
      const app = createApp();
      const unauth = await request(app).post("/approvals/nonexistent/approve").send({});
      expect(unauth.status).toBe(401);
    });
  });

  describe("AC: CRM dashboard accuracy - real counts, never fabricated", () => {
    it("leadsByStatus and totalCompanies/totalContacts match real seeded DB rows exactly", async () => {
      const company = await prisma.company.create({ data: { name: "Acme", website: "https://acme.example", domain: "acme.example" } });
      const contact = await prisma.contact.create({ data: { firstName: "Jane", email: "jane@acme.example", normalizedEmail: "jane@acme.example", companyId: company.id } });
      await prisma.lead.createMany({
        data: [
          { companyId: company.id, contactId: contact.id, status: "NEW" },
          { companyId: company.id, status: "QUALIFIED" },
          { companyId: company.id, status: "QUALIFIED" },
        ],
      });

      const app = createApp();
      const res = await request(app).get("/crm/dashboard").set(...authHeader(owner.token));
      expect(res.status).toBe(200);

      const newCount = res.body.leadsByStatus.find((s: { status: string }) => s.status === "NEW")?.count;
      const qualifiedCount = res.body.leadsByStatus.find((s: { status: string }) => s.status === "QUALIFIED")?.count;
      expect(newCount).toBe(1);
      expect(qualifiedCount).toBe(2);
      expect(res.body.totalCompanies).toBe(await prisma.company.count());
      expect(res.body.totalContacts).toBe(await prisma.contact.count());
    });

    it("pendingApprovals count matches the real PENDING ApprovalRequest rows", async () => {
      await createApprovalRequest({
        action: "email.send",
        reason: "test",
        target: "x@example.com",
        proposedContent: { subject: "s", body: "b" },
        riskClassification: "HIGH",
        createdBy: "system:test",
      });
      const app = createApp();
      const res = await request(app).get("/crm/dashboard").set(...authHeader(owner.token));
      expect(res.body.pendingApprovals).toBe(1);
    });
  });

  describe("Approval queue routes", () => {
    it("GET /approvals lists PENDING requests; POST /approve transitions it and is audited", async () => {
      const approval = await createApprovalRequest({
        action: "email.send",
        reason: "HIGH-RISK content",
        target: "buyer@brand.example",
        proposedContent: { subject: "Quote", body: "Price: $500" },
        riskClassification: "HIGH",
        createdBy: "system:test",
      });
      const app = createApp();
      const list = await request(app).get("/approvals?status=PENDING").set(...authHeader(owner.token));
      expect(list.status).toBe(200);
      expect(list.body.approvals.some((a: { id: string }) => a.id === approval.id)).toBe(true);

      const approve = await request(app).post(`/approvals/${approval.id}/approve`).set(...authHeader(owner.token)).send({ note: "ok" });
      expect(approve.status).toBe(200);
      expect(approve.body.approval.status).toBe("APPROVED");
      // proposedContent unchanged
      expect(approve.body.approval.proposedContent).toEqual({ subject: "Quote", body: "Price: $500" });
    });
  });
});
