// core/business/intelligence/companyProfile.test.ts - Phase 11, section 3:
// the "Prime Pak itself has 25+ years" claim must never appear, while the
// allowed "backed by ... via its production backbone" phrasing is fine.
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../../database/client";
import { getCompanyProfile, seedCompanyProfile, DEFAULT_COMPANY_PROFILE, checkForDisallowedClaims } from "./companyProfile";

beforeEach(async () => {
  await prisma.setting.deleteMany({ where: { key: "business.company_profile" } });
});

describe("companyProfile - factual accuracy guard", () => {
  it("getCompanyProfile() returns the seeded defaults when unset", async () => {
    const profile = await getCompanyProfile();
    expect(profile.legalName).toBe(DEFAULT_COMPANY_PROFILE.legalName);
    expect(profile.productionBackbone).toBe("MM Printing Agency");
  });

  it("seedCompanyProfile() is idempotent", async () => {
    await seedCompanyProfile();
    await seedCompanyProfile();
    const count = await prisma.setting.count({ where: { key: "business.company_profile" } });
    expect(count).toBe(1);
  });

  it("the default manufacturingExpertiseStatement never claims Prime Pak itself has 25+ years", async () => {
    const profile = await getCompanyProfile();
    const check = checkForDisallowedClaims(profile.manufacturingExpertiseStatement);
    expect(check.ok).toBe(true);
    expect(profile.manufacturingExpertiseStatement).toContain("production backbone");
  });

  it("rejects text that falsely ages Prime Pak itself", () => {
    const bad1 = checkForDisallowedClaims("Prime Pak has 25+ years of manufacturing experience.");
    expect(bad1.ok).toBe(false);
    const bad2 = checkForDisallowedClaims("Prime Pak Packages has 25 years of manufacturing experience in the industry.");
    expect(bad2.ok).toBe(false);
  });

  it("allows the correct attribution phrasing", () => {
    const good = checkForDisallowedClaims("Backed by 25+ years of manufacturing expertise via its production backbone, MM Printing Agency.");
    expect(good.ok).toBe(true);
  });
});
