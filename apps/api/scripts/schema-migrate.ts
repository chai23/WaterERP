import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiRoot, "../..");
const migrationsDir = path.join(repoRoot, "database", "migrations");
const BASELINE = "001_baseline.sql";

type StatusPayload = {
  ok: boolean;
  applied: string[];
  pending: string[];
  latest: string | null;
  message?: string;
  dryRun?: boolean;
  wouldApply?: string[];
  appliedNow?: string[];
};

function isExcluded(filename: string): boolean {
  return filename.toLowerCase().includes("clear") || filename.toLowerCase().includes("reset_data");
}

function listMigrations(): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`找不到 migrations 目錄：${migrationsDir}`);
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/i.test(name))
    .filter((name) => !isExcluded(name))
    .sort((a, b) => Number(a.slice(0, 3)) - Number(b.slice(0, 3)));
}

async function ensureTrackingTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`applied_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function tableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*) AS cnt
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${table}
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function recordApplied(prisma: PrismaClient, filename: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT IGNORE INTO schema_migrations (id) VALUES ('${filename.replace(/'/g, "''")}')`,
  );
}

async function getAppliedIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM schema_migrations ORDER BY id ASC`;
  return rows.map((row) => row.id);
}

/**
 * 舊版曾把 003～055 寫進追蹤表。摺疊後只保留目前 migrations 目錄裡的檔名。
 * 已有完整庫（有 users）但還沒有 001 標記時，直接視為基線已套用，避免對正式庫再跑建表。
 */
async function reconcileTracking(prisma: PrismaClient): Promise<string | undefined> {
  await ensureTrackingTable(prisma);
  const current = listMigrations();
  const currentSet = new Set(current);
  const applied = await getAppliedIds(prisma);
  const obsolete = applied.filter((id) => !currentSet.has(id));
  for (const id of obsolete) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM \`schema_migrations\` WHERE \`id\` = '${id.replace(/'/g, "''")}'`,
    );
  }

  const afterPrune = new Set(await getAppliedIds(prisma));
  if (current.includes(BASELINE) && !afterPrune.has(BASELINE) && (await tableExists(prisma, "users"))) {
    await recordApplied(prisma, BASELINE);
    return obsolete.length > 0
      ? `已將舊的 ${obsolete.length} 筆升級紀錄摺疊為 ${BASELINE}`
      : `既有資料庫已標記為 ${BASELINE}`;
  }
  if (obsolete.length > 0) {
    return `已清除 ${obsolete.length} 筆不再使用的升級紀錄`;
  }
  return undefined;
}

function runMigrationFile(filename: string): void {
  const filePath = path.join(migrationsDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到 migration 檔案：${filePath}`);
  }
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "db", "execute", "--schema", "prisma/schema.prisma", "--file", filePath],
    {
      cwd: apiRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || `執行失敗：${filename}`);
  }
}

async function repairFalseApplied(prisma: PrismaClient): Promise<string[]> {
  await ensureTrackingTable(prisma);
  const applied = await getAppliedIds(prisma);
  const removed: string[] = [];
  if (applied.includes(BASELINE) && !(await tableExists(prisma, "users"))) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM \`schema_migrations\` WHERE \`id\` = '${BASELINE.replace(/'/g, "''")}'`,
    );
    removed.push(BASELINE);
  }
  return removed;
}

function printJson(payload: StatusPayload): void {
  console.log(JSON.stringify(payload));
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run");
const repair = args.includes("--repair");

const prisma = new PrismaClient();

try {
  let message: string | undefined;
  if (repair) {
    const repaired = await repairFalseApplied(prisma);
    message =
      repaired.length > 0 ? `已清除 ${repaired.length} 筆誤標紀錄，請再執行升級結構` : "未發現誤標紀錄";
  }

  const reconcileMessage = await reconcileTracking(prisma);
  if (!message) message = reconcileMessage;

  const all = listMigrations();
  const applied = await getAppliedIds(prisma);
  const appliedSet = new Set(applied);
  const pending = all.filter((name) => !appliedSet.has(name));
  const latest = all.length > 0 ? all[all.length - 1]! : null;

  if (!apply) {
    printJson({
      ok: true,
      applied,
      pending,
      latest,
      message,
      ...(repair ? { appliedNow: [] } : {}),
    });
    process.exit(0);
  }

  if (dryRun) {
    printJson({ ok: true, applied, pending, latest, dryRun: true, wouldApply: pending, message });
    process.exit(0);
  }

  const appliedNow: string[] = [];
  for (const filename of pending) {
    runMigrationFile(filename);
    await recordApplied(prisma, filename);
    appliedNow.push(filename);
  }

  printJson({
    ok: true,
    applied: [...applied, ...appliedNow],
    pending: [],
    latest,
    appliedNow,
    message,
  });
} catch (error) {
  printJson({
    ok: false,
    applied: [],
    pending: [],
    latest: null,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
