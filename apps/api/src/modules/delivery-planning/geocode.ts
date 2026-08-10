import type { PrismaClient } from "@prisma/client";

export function serializeAddressGeo(addr: {
  id: bigint;
  latitude: unknown;
  longitude: unknown;
  geocodeStatus: string;
  geocodedAddress: string | null;
  geocodedAt: Date | null;
  locationAccuracy: string | null;
  manualLocationConfirmed: boolean;
}) {
  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: addr.id.toString(),
    latitude: toNum(addr.latitude),
    longitude: toNum(addr.longitude),
    geocodeStatus: addr.geocodeStatus,
    geocodedAddress: addr.geocodedAddress,
    geocodedAt: addr.geocodedAt?.toISOString() ?? null,
    locationAccuracy: addr.locationAccuracy,
    manualLocationConfirmed: addr.manualLocationConfirmed,
  };
}

export type GeocodeResult = {
  status: "ok" | "ambiguous" | "failed";
  latitude?: number;
  longitude?: number;
  geocodedAddress?: string;
  locationAccuracy?: string;
  candidates?: Array<{ latitude: number; longitude: number; label: string }>;
  message?: string;
};

/**
 * Geocode adapter。
 * - 若設 GOOGLE_MAPS_API_KEY：呼叫 Geocoding API
 * - 否則：不自動猜測，回傳 failed，需人工在地圖確認
 */
export async function geocodeAddressLine(addressLine: string): Promise<GeocodeResult> {
  const trimmed = addressLine.trim();
  if (!trimmed) return { status: "failed", message: "地址空白" };

  const key = (process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
  if (!key) {
    return {
      status: "failed",
      message: "未設定 GOOGLE_MAPS_API_KEY；請管理員在地圖上手動確認座標",
    };
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", trimmed);
    url.searchParams.set("language", "zh-TW");
    url.searchParams.set("region", "tw");
    url.searchParams.set("key", key);
    const res = await fetch(url);
    const data = (await res.json()) as {
      status: string;
      results?: Array<{
        formatted_address?: string;
        geometry?: { location?: { lat: number; lng: number }; location_type?: string };
        partial_match?: boolean;
      }>;
      error_message?: string;
    };
    if (data.status !== "OK" || !data.results?.length) {
      return {
        status: "failed",
        message: data.error_message ?? `geocode status=${data.status}`,
      };
    }
    if (data.results.length > 1 || data.results[0]?.partial_match) {
      return {
        status: "ambiguous",
        candidates: data.results.slice(0, 5).map((r) => ({
          latitude: r.geometry?.location?.lat ?? 0,
          longitude: r.geometry?.location?.lng ?? 0,
          label: r.formatted_address ?? trimmed,
        })),
        message: "地址可能有多個候選，請人工確認",
      };
    }
    const top = data.results[0]!;
    const lat = top.geometry?.location?.lat;
    const lng = top.geometry?.location?.lng;
    if (lat == null || lng == null) {
      return { status: "failed", message: "無座標結果" };
    }
    return {
      status: "ok",
      latitude: lat,
      longitude: lng,
      geocodedAddress: top.formatted_address ?? trimmed,
      locationAccuracy: top.geometry?.location_type ?? undefined,
    };
  } catch (e) {
    return { status: "failed", message: String(e) };
  }
}

export async function applyGeocodeToAddress(
  prisma: PrismaClient,
  addressId: bigint,
): Promise<{
  addressId: string;
  result: GeocodeResult;
  address: ReturnType<typeof serializeAddressGeo> | null;
}> {
  const addr = await prisma.deliveryAddress.findUnique({ where: { id: addressId } });
  if (!addr) throw new Error("ADDRESS_NOT_FOUND");
  const result = await geocodeAddressLine(addr.addressLine);
  if (result.status === "ok" && result.latitude != null && result.longitude != null) {
    await prisma.deliveryAddress.update({
      where: { id: addressId },
      data: {
        latitude: result.latitude,
        longitude: result.longitude,
        geocodeStatus: "ok",
        geocodedAddress: result.geocodedAddress ?? null,
        geocodedAt: new Date(),
        locationAccuracy: result.locationAccuracy ?? null,
        manualLocationConfirmed: false,
      },
    });
  } else if (result.status === "ambiguous") {
    await prisma.deliveryAddress.update({
      where: { id: addressId },
      data: {
        geocodeStatus: "ambiguous",
        geocodedAt: new Date(),
      },
    });
  } else {
    await prisma.deliveryAddress.update({
      where: { id: addressId },
      data: {
        geocodeStatus: "failed",
        geocodedAt: new Date(),
      },
    });
  }
  const updated = await prisma.deliveryAddress.findUnique({ where: { id: addressId } });
  return {
    addressId: addressId.toString(),
    result,
    address: updated ? serializeAddressGeo(updated) : null,
  };
}

export async function confirmAddressLocation(
  prisma: PrismaClient,
  args: { addressId: bigint; latitude: number; longitude: number; geocodedAddress?: string | null },
) {
  const updated = await prisma.deliveryAddress.update({
    where: { id: args.addressId },
    data: {
      latitude: args.latitude,
      longitude: args.longitude,
      geocodeStatus: "manual_confirmed",
      geocodedAddress: args.geocodedAddress ?? undefined,
      geocodedAt: new Date(),
      manualLocationConfirmed: true,
      locationAccuracy: "manual",
    },
  });
  return serializeAddressGeo(updated);
}
