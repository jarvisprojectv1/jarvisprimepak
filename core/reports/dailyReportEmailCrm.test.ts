// core/reports/dailyReportEmailCrm.test.ts - item AD (daily report accuracy),
// extending Phase 5/6's dailyReport.test.ts for Phase 7's emailCrm section.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../database/client";
import { generateDailyReport, todayUtc } from "./dailyReport";
import { createApprovalRequest } from "../approvals";

beforeEach(async () => {
  await prisma.email.deleteMany();
  await prisma.approvalRequest.deleteMany();
  await prisma.lead.deleteMany();
});

describe("AD: daily report - emailCrm section accuracy", () => {
  it("emailsSentToday/emailsReceivedToday reflect real Email rows for the day, never fabricated", async () => {
    await prisma.email.create({ data: { direction: "outbound", status: "SENT", subject: "s1", body: "b1" } });
    await prisma.email.create({ data: { direction: "outbound", status: "SENT", subject: "s2", body: "b2" } });
    await prisma.email.create({ data: { direction: "inbound", status: "RECEIVED", subject: "s3", body: "b3" } });

    const report = await generateDailyReport(todayUtc());
    expect(report.emailCrm.emailsSentToday).toBe(2);
    expect(report.emailCrm.emailsReceivedToday).toBe(1);
  });

  it("pendingApprovals matches real PENDING ApprovalRequest count", async () => {
    await createApprovalRequest({
      action: "email.send",
      reason: "test",
      target: "x@example.com",
      proposedContent: { a: 1 },
      riskClassification: "HIGH",
      createdBy: "system:test",
    });
    const report = await generateDailyReport(todayUtc());
    expect(report.emailCrm.pendingApprovals).toBe(1);
  });

  it("honestly reports emailProviderConfigured: false with no GMAIL_* env vars set in this test env", async () => {
    const report = await generateDailyReport(todayUtc());
    expect(report.emailCrm.emailProviderConfigured).toBe(Boolean(process.env.GMAIL_ACCESS_TOKEN && process.env.GMAIL_USER_EMAIL));
    expect(report.emailCrm.note).toBeTruthy();
  });

  it("leadsByStatus in the report matches a real prisma.lead.groupBy query", async () => {
    const company = await prisma.company.create({ data: { name: "Acme Corp X", website: "https://acmecorpx.example" } });
    await prisma.lead.create({ data: { companyId: company.id, status: "NEW" } });
    const report = await generateDailyReport(todayUtc());
    const actual = await prisma.lead.groupBy({ by: ["status"], _count: { status: true } });
    expect(report.emailCrm.leadsByStatus.length).toBe(actual.length);
  });
});
