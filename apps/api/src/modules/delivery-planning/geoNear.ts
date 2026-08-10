/** 直線距離（公里）。未做路網／車程，僅供未分區就近併入。 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function toCoord(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > 180) return null;
  return n;
}

export function formatNearKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km < 10 ? km.toFixed(1) : String(Math.round(km))}km`;
}

/** 未分區就近分數：越近越高；無參考點時略加空路線。 */
export function unzonedProximityScore(km: number | null, emptyRoute: boolean): number {
  if (km == null) return emptyRoute ? 10 : 0;
  if (km <= 0.5) return 90;
  if (km <= 1.2) return 65;
  if (km <= 2.5) return 40;
  if (km <= 4) return 18;
  return -20;
}
