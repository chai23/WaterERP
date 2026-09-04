/**
 * 重建空的 water_erp（刪光資料後匯入最新 database/schema.sql）
 * 用法：
 *   macOS/Linux: CONFIRM=YES npm run db:rebuild-empty
 *   Windows CMD: set CONFIRM=YES&& npm run db:rebuild-empty
 *   Windows PowerShell: $env:CONFIRM="YES"; npm run db:rebuild-empty
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(apiRoot, "../..");
const schemaFile = path.join(repoRoot, "database", "schema.sql");

if (process.env.CONFIRM !== "YES") {
  console.error(
    JSON.stringify({
      ok: false,
      message:
        "此操作會刪除 water_erp 全部資料。確認後請執行：CONFIRM=YES npm run db:rebuild-empty（Windows 請用 set CONFIRM=YES&& npm run db:rebuild-empty）",
    }),
  );
  process.exit(1);
}

if (!fs.existsSync(schemaFile)) {
  console.error(JSON.stringify({ ok: false, message: `找不到 ${schemaFile}` }));
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(JSON.stringify({ ok: false, message: "缺少 DATABASE_URL（請檢查 apps/api/.env）" }));
  process.exit(1);
}

/** 連到 mysql 系統庫，才能 DROP 目前的業務庫 */
function adminDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace(/\/([^/?]+)(\?|$)/, "/mysql$2");
}

function runPrismaSqlFile(filePath: string): void {
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
    throw new Error(detail || `執行失敗：${filePath}`);
  }
}

const admin = new PrismaClient({
  datasources: { db: { url: adminDatabaseUrl(url) } },
});

try {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`water_erp\``);
  await admin.$executeRawUnsafe(
    `CREATE DATABASE \`water_erp\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await admin.$disconnect();
  runPrismaSqlFile(schemaFile);
  console.log(
    JSON.stringify({
      ok: true,
      message: "已重建空的 water_erp，並匯入最新 database/schema.sql（含完整表與結構追蹤）",
    }),
  );
} catch (error) {
  try {
    await admin.$disconnect();
  } catch {
    /* ignore */
  }
  console.error(
    JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
