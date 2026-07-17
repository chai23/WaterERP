/** 二樓以上搬運獎金：樓層顯示 */

export function formatDeliveryFloor(floor: number | null | undefined): string {
  if (floor == null) return "未設定";
  if (floor < 0) return `地下${Math.abs(floor)}樓`;
  return `${floor}樓`;
}
