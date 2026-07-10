import { Prisma, type PrismaClient } from "@prisma/client";

export const PROMOTION_RULE_PREPAID_TOPUP_BONUS = "prepaid_topup_bonus";
export const PROMOTION_RULE_DISPENSER_PURCHASE_GIFT = "dispenser_purchase_gift";

export type DraftOrderLine = {
  productId: bigint;
  qty: number;
  unitPrice: Prisma.Decimal | null;
  billingType: string;
  linePurpose: "delivery" | "prepaid_barrel_topup";
  invoiceMode: string | null;
  isPromotionGift?: boolean;
  promotionRuleKey?: string | null;
  promotionNote?: string | null;
};

export type PromotionPreviewMessage = {
  ruleKey: string;
  message: string;
  giftLines: Array<{
    productId: string;
    productName?: string;
    qty: number;
    linePurpose: string;
    promotionNote?: string | null;
  }>;
};

type PrepaidTopupBonusConfig = {
  minBarrels: number;
  bonusBarrels: number;
};

function parsePrepaidTopupBonusConfig(raw: unknown): PrepaidTopupBonusConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const minBarrels = Math.floor(Number(o.minBarrels ?? 0));
  const bonusBarrels = Math.floor(Number(o.bonusBarrels ?? 0));
  return {
    minBarrels: Number.isFinite(minBarrels) && minBarrels > 0 ? minBarrels : 0,
    bonusBarrels: Number.isFinite(bonusBarrels) && bonusBarrels > 0 ? bonusBarrels : 0,
  };
}

function isPaidLine(line: DraftOrderLine): boolean {
  return !line.isPromotionGift;
}

function sumPaidPrepaidTopupByProduct(lines: DraftOrderLine[]): Map<bigint, number> {
  const m = new Map<bigint, number>();
  for (const l of lines) {
    if (!isPaidLine(l)) continue;
    if ((l.linePurpose ?? "delivery") !== "prepaid_barrel_topup") continue;
    if (l.qty <= 0) continue;
    m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
  }
  return m;
}

function makeGiftLine(
  base: Pick<DraftOrderLine, "productId" | "qty" | "linePurpose" | "billingType" | "invoiceMode">,
  ruleKey: string,
  note: string,
): DraftOrderLine {
  return {
    ...base,
    unitPrice: new Prisma.Decimal(0),
    isPromotionGift: true,
    promotionRuleKey: ruleKey,
    promotionNote: note,
  };
}

function applyPrepaidTopupBonus(
  paidLines: DraftOrderLine[],
  config: PrepaidTopupBonusConfig,
  productNames: Map<bigint, string>,
): { giftLines: DraftOrderLine[]; messages: PromotionPreviewMessage[] } {
  const giftLines: DraftOrderLine[] = [];
  const messages: PromotionPreviewMessage[] = [];
  if (config.minBarrels <= 0 || config.bonusBarrels <= 0) return { giftLines, messages };

  const topupByProduct = sumPaidPrepaidTopupByProduct(paidLines);
  for (const [productId, paidQty] of topupByProduct) {
    const bonusQty = Math.floor(paidQty / config.minBarrels) * config.bonusBarrels;
    if (bonusQty <= 0) continue;
    const productName = productNames.get(productId) ?? "商品";
    const note = `預收滿 ${config.minBarrels} 桶贈 ${config.bonusBarrels} 桶`;
    const gift = makeGiftLine(
      {
        productId,
        qty: bonusQty,
        linePurpose: "prepaid_barrel_topup",
        billingType: "cash",
        invoiceMode: null,
      },
      PROMOTION_RULE_PREPAID_TOPUP_BONUS,
      note,
    );
    giftLines.push(gift);
    messages.push({
      ruleKey: PROMOTION_RULE_PREPAID_TOPUP_BONUS,
      message: `${productName}：儲值 ${paidQty} 桶，贈送 ${bonusQty} 桶`,
      giftLines: [
        {
          productId: productId.toString(),
          productName,
          qty: bonusQty,
          linePurpose: "prepaid_barrel_topup",
          promotionNote: note,
        },
      ],
    });
  }
  return { giftLines, messages };
}

type DispenserRuleRow = {
  triggerProductId: bigint;
  giftProductId: bigint;
  giftQtyPerUnit: number;
  triggerProduct: { name: string; isActive: boolean };
  giftProduct: { name: string; isActive: boolean };
};

function applyDispenserPurchaseGifts(
  paidLines: DraftOrderLine[],
  rules: DispenserRuleRow[],
): { giftLines: DraftOrderLine[]; messages: PromotionPreviewMessage[] } {
  const giftLines: DraftOrderLine[] = [];
  const messages: PromotionPreviewMessage[] = [];
  const ruleByTrigger = new Map(rules.map((r) => [r.triggerProductId, r]));

  for (const line of paidLines) {
    if (!isPaidLine(line)) continue;
    if ((line.linePurpose ?? "delivery") !== "delivery") continue;
    if (line.qty <= 0) continue;
    const rule = ruleByTrigger.get(line.productId);
    if (!rule || !rule.triggerProduct.isActive || !rule.giftProduct.isActive) continue;
    const giftQty = line.qty * rule.giftQtyPerUnit;
    if (giftQty <= 0) continue;
    const note = `購買 ${rule.triggerProduct.name} 贈送`;
    const gift = makeGiftLine(
      {
        productId: rule.giftProductId,
        qty: giftQty,
        linePurpose: "delivery",
        billingType: line.billingType,
        invoiceMode: line.invoiceMode,
      },
      PROMOTION_RULE_DISPENSER_PURCHASE_GIFT,
      note,
    );
    giftLines.push(gift);
    messages.push({
      ruleKey: PROMOTION_RULE_DISPENSER_PURCHASE_GIFT,
      message: `購買 ${rule.triggerProduct.name} ${line.qty} 台，贈送 ${rule.giftProduct.name} ${giftQty} 桶`,
      giftLines: [
        {
          productId: rule.giftProductId.toString(),
          productName: rule.giftProduct.name,
          qty: giftQty,
          linePurpose: "delivery",
          promotionNote: note,
        },
      ],
    });
  }
  return { giftLines, messages };
}

export async function loadPromotionContext(prisma: PrismaClient) {
  const [prepaidRule, dispenserMaster, dispenserRules, products] = await Promise.all([
    prisma.promotionRule.findUnique({ where: { ruleKey: PROMOTION_RULE_PREPAID_TOPUP_BONUS } }),
    prisma.promotionRule.findUnique({ where: { ruleKey: PROMOTION_RULE_DISPENSER_PURCHASE_GIFT } }),
    prisma.promotionDispenserGiftRule.findMany({
      where: { isActive: true },
      include: { triggerProduct: true, giftProduct: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    }),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);
  const productNames = new Map(products.map((p) => [p.id, p.name]));
  return { prepaidRule, dispenserMaster, dispenserRules, productNames };
}

export async function applyPromotions(
  prisma: PrismaClient,
  lines: DraftOrderLine[],
): Promise<{ lines: DraftOrderLine[]; messages: PromotionPreviewMessage[] }> {
  const paidLines = lines.filter(isPaidLine);
  const ctx = await loadPromotionContext(prisma);
  const allGiftLines: DraftOrderLine[] = [];
  const allMessages: PromotionPreviewMessage[] = [];

  if (ctx.prepaidRule?.isEnabled) {
    const config = parsePrepaidTopupBonusConfig(ctx.prepaidRule.config);
    const { giftLines, messages } = applyPrepaidTopupBonus(paidLines, config, ctx.productNames);
    allGiftLines.push(...giftLines);
    allMessages.push(...messages);
  }

  if (ctx.dispenserMaster?.isEnabled && ctx.dispenserRules.length > 0) {
    const { giftLines, messages } = applyDispenserPurchaseGifts(paidLines, ctx.dispenserRules);
    allGiftLines.push(...giftLines);
    allMessages.push(...messages);
  }

  return { lines: [...paidLines, ...allGiftLines], messages: allMessages };
}

export function validatePrepaidTopupBonusConfig(config: unknown): { ok: true; data: PrepaidTopupBonusConfig } | { ok: false; message: string } {
  const parsed = parsePrepaidTopupBonusConfig(config);
  if (parsed.minBarrels <= 0) return { ok: false, message: "滿額桶數 N 須為正整數" };
  if (parsed.bonusBarrels <= 0) return { ok: false, message: "贈送桶數 M 須為正整數" };
  return { ok: true, data: parsed };
}

export function serializePromotionRule(row: {
  id: bigint;
  ruleKey: string;
  displayName: string;
  description: string | null;
  isEnabled: boolean;
  config: unknown;
  sortOrder: number;
}) {
  return {
    id: row.id.toString(),
    ruleKey: row.ruleKey,
    displayName: row.displayName,
    description: row.description,
    isEnabled: row.isEnabled,
    config: row.config,
    sortOrder: row.sortOrder,
  };
}

export function serializeDispenserGiftRule(row: {
  id: bigint;
  triggerProductId: bigint;
  giftProductId: bigint;
  giftQtyPerUnit: number;
  isActive: boolean;
  sortOrder: number;
  triggerProduct?: { id: bigint; name: string; productCode: string | null } | null;
  giftProduct?: { id: bigint; name: string; productCode: string | null } | null;
}) {
  return {
    id: row.id.toString(),
    triggerProductId: row.triggerProductId.toString(),
    giftProductId: row.giftProductId.toString(),
    giftQtyPerUnit: row.giftQtyPerUnit,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    triggerProduct: row.triggerProduct
      ? {
          id: row.triggerProduct.id.toString(),
          name: row.triggerProduct.name,
          productCode: row.triggerProduct.productCode,
        }
      : null,
    giftProduct: row.giftProduct
      ? {
          id: row.giftProduct.id.toString(),
          name: row.giftProduct.name,
          productCode: row.giftProduct.productCode,
        }
      : null,
  };
}
