/** 二樓以上搬運獎金：樓層顯示與計獎判斷 */

export function formatDeliveryFloor(floor: number | null | undefined): string {
  if (floor == null) return "未設定";
  if (floor < 0) return `地下${Math.abs(floor)}樓`;
  return `${floor}樓`;
}

/** 二樓以上或地下樓計入搬運獎金 */
export function isFloorBonusEligible(floor: number | null | undefined): boolean {
  if (floor == null) return false;
  return floor >= 2 || floor < 0;
}

export type FloorBonusLineInput = {
  lineId: string;
  productName: string;
  qtyOrdered: number;
  qtyDelivered: number;
  upstairsQty: string;
};

export function buildFloorBonusLines(
  lines: Array<{
    id?: string | number;
    linePurpose?: string | null;
    qtyOrdered?: number | null;
    qtyDelivered?: number | null;
    product?: { name?: string; consumesPrepaidBarrel?: boolean } | null;
  }> | undefined,
): FloorBonusLineInput[] {
  return (lines ?? [])
    .filter((line) => (line.linePurpose ?? "delivery") !== "prepaid_barrel_topup")
    .filter((line) => line.product?.consumesPrepaidBarrel === true)
    .filter((line) => line.id != null)
    .map((line) => {
      const qtyOrdered = Math.max(0, Math.floor(Number(line.qtyOrdered ?? 0)));
      const qtyDelivered = Math.max(0, Math.floor(Number(line.qtyDelivered ?? 0)));
      const effective = qtyDelivered > 0 ? qtyDelivered : qtyOrdered;
      return {
        lineId: String(line.id),
        productName: line.product?.name ?? "商品",
        qtyOrdered,
        qtyDelivered: effective,
        upstairsQty: "",
      };
    });
}

export function orderHasFloorBonusProducts(
  lines: Array<{
    id?: string | number;
    linePurpose?: string | null;
    qtyOrdered?: number | null;
    qtyDelivered?: number | null;
    product?: { name?: string; consumesPrepaidBarrel?: boolean } | null;
  }> | undefined,
): boolean {
  return (lines ?? []).some(
    (line) =>
      (line.linePurpose ?? "delivery") !== "prepaid_barrel_topup" &&
      line.product?.consumesPrepaidBarrel === true,
  );
}
