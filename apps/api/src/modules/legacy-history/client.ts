import { PrismaClient } from "@prisma/client";

const LEGACY_DB = "database";

let legacyClient: PrismaClient | null = null;
let legacyUrlCached: string | null = null;

export function resolveLegacyDatabaseUrl(): string | null {
  const legacyUrl = process.env.LEGACY_DATABASE_URL?.trim();
  if (legacyUrl) return legacyUrl;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  return url.replace(/\/[^/?]+(\?.*)?$/, `/${LEGACY_DB}$1`);
}

export function describeDbUrl(url: string): string {
  try {
    const normalized = url.includes("://") ? url.replace(/^mysql:\/\//i, "http://") : `http://${url}`;
    const u = new URL(normalized);
    const db = u.pathname.replace(/^\//, "") || LEGACY_DB;
    return `${u.hostname}:${u.port || "3306"}/${db}`;
  } catch {
    return "（無法解析連線字串）";
  }
}

/** 舊庫唯讀 Prisma client（lazy singleton）。未設定連線時回傳 null。 */
export function getLegacyPrisma(): PrismaClient | null {
  const url = resolveLegacyDatabaseUrl();
  if (!url) return null;
  if (legacyClient && legacyUrlCached === url) return legacyClient;
  if (legacyClient) {
    void legacyClient.$disconnect().catch(() => undefined);
  }
  legacyClient = new PrismaClient({ datasources: { db: { url } } });
  legacyUrlCached = url;
  return legacyClient;
}

export async function disconnectLegacyPrisma(): Promise<void> {
  if (!legacyClient) return;
  const c = legacyClient;
  legacyClient = null;
  legacyUrlCached = null;
  await c.$disconnect().catch(() => undefined);
}
