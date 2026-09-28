// core/crm/businessConfig.ts - Business configuration as DATA (Phase 7, item
// 11). Prime Pak's product categories/positioning/certifications live in the
// ProductCategory table, never hardcoded as business claims in TypeScript.
// Draft generation (core/business/emailDraft.ts) and quote preparation
// (core/business/quote.ts) may ONLY cite facts present here - anything else
// becomes an explicit placeholder, never an invention.
import { prisma } from "../../database/client";

export interface ProductCategoryData {
  id: string;
  name: string;
  description: string | null;
  positioning: string | null;
  certifications: string[];
  minOrderQuantity: string | null;
  productionTimeNotes: string | null;
  costingRules: { unit: string; baseUnitCost: number; currency: string } | null;
}

function toData(row: {
  id: string;
  name: string;
  description: string | null;
  positioning: string | null;
  certifications: string | null;
  minOrderQuantity: string | null;
  productionTimeNotes: string | null;
  costingRulesJson: string | null;
}): ProductCategoryData {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    positioning: row.positioning,
    certifications: row.certifications ? (JSON.parse(row.certifications) as string[]) : [],
    minOrderQuantity: row.minOrderQuantity,
    productionTimeNotes: row.productionTimeNotes,
    costingRules: row.costingRulesJson ? JSON.parse(row.costingRulesJson) : null,
  };
}

export async function listProductCategories(): Promise<ProductCategoryData[]> {
  const rows = await prisma.productCategory.findMany({ orderBy: { name: "asc" } });
  return rows.map(toData);
}

export async function getProductCategory(name: string): Promise<ProductCategoryData | null> {
  const row = await prisma.productCategory.findUnique({ where: { name } });
  return row ? toData(row) : null;
}

export interface UpsertProductCategoryInput {
  name: string;
  description?: string;
  positioning?: string;
  certifications?: string[];
  minOrderQuantity?: string;
  productionTimeNotes?: string;
  costingRules?: { unit: string; baseUnitCost: number; currency: string };
}

export async function upsertProductCategory(input: UpsertProductCategoryInput): Promise<ProductCategoryData> {
  const data = {
    description: input.description,
    positioning: input.positioning,
    certifications: input.certifications ? JSON.stringify(input.certifications) : undefined,
    minOrderQuantity: input.minOrderQuantity,
    productionTimeNotes: input.productionTimeNotes,
    costingRulesJson: input.costingRules ? JSON.stringify(input.costingRules) : undefined,
  };
  const row = await prisma.productCategory.upsert({
    where: { name: input.name },
    update: data,
    create: { name: input.name, ...data },
  });
  return toData(row);
}

/**
 * Seeds a small, honest starting set of Prime Pak's real product categories
 * as DATA rows - editable via POST/PATCH, never a hardcoded business claim
 * in logic. Deliberately conservative: no certifications/prices are seeded
 * that this sandbox cannot verify are accurate; an operator fills those in
 * via the API before drafts/quotes can cite them. Idempotent (upsert).
 */
export async function seedDefaultProductCategories(): Promise<void> {
  const defaults: UpsertProductCategoryInput[] = [
    {
      name: "Corrugated Packaging",
      description: "Corrugated cartons and boxes for shipping and retail packaging.",
      positioning: "Core Prime Pak Packages product line.",
    },
    {
      name: "Garment Trims & Tags",
      description: "Hang tags, care labels, and garment trims for apparel exporters.",
      positioning: "Serves apparel/garment export customers.",
    },
    {
      name: "Flexible Packaging",
      description: "Poly bags, pouches, and flexible film packaging.",
      positioning: "Serves general packaging needs across industries.",
    },
  ];
  for (const d of defaults) {
    await upsertProductCategory(d);
  }
}
