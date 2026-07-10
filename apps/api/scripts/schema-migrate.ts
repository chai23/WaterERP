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

const EXCLUDED = new Set([
  "004_reset_data_keep_single_admin.sql",
  "008_clear_all_sales_orders.sql",
  "019_clear_transaction_data_keep_masters.sql",
]);

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
  if (EXCLUDED.has(filename)) return true;
  return filename.toLowerCase().includes("clear");
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

async function columnExists(prisma: PrismaClient, table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*) AS cnt
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ${table} AND column_name = ${column}
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function indexExists(prisma: PrismaClient, table: string, indexName: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ cnt: bigint }[]>`
    SELECT COUNT(*) AS cnt
    FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = ${table} AND index_name = ${indexName}
  `;
  return Number(rows[0]?.cnt ?? 0) > 0;
}

type MigrationProbe = (prisma: PrismaClient) => Promise<boolean>;

const MIGRATION_PROBES: Record<string, MigrationProbe> = {
  "003_delivery_settlement.sql": (p) => columnExists(p, "delivery_assignments", "settlement_outcome"),
  "005_customer_barrels_on_site.sql": (p) => columnExists(p, "customers", "barrels_on_site"),
  "006_office_settlement_gate.sql": (p) => columnExists(p, "delivery_assignments", "driver_reported_at"),
  "007_product_counts_deposit_barrel.sql": (p) => columnExists(p, "products", "counts_deposit_barrel"),
  "009_customer_billing_three_ways.sql": (p) => tableExists(p, "customer_ledger_entries"),
  "010_monthly_cutoff_fifo.sql": (p) => columnExists(p, "sales_orders", "monthly_received_amount"),
  "011_line_billing_subtotals.sql": (p) => columnExists(p, "sales_orders", "cash_subtotal"),
  "012_ar_sop_rebuild.sql": (p) => tableExists(p, "ar_documents"),
  "013_prepaid_barrel_semantics.sql": (p) => columnExists(p, "products", "consumes_prepaid_barrel"),
  "014_pending_prepaid_topup_barrels.sql": (p) => columnExists(p, "sales_orders", "pending_prepaid_topup_barrels"),
  "015_prepaid_product_balances.sql": (p) => tableExists(p, "customer_prepaid_product_balances"),
  "016_customer_code.sql": (p) => columnExists(p, "customers", "customer_code"),
  "017_product_code.sql": (p) => columnExists(p, "products", "product_code"),
  "018_billing_statements_tax_invoices.sql": (p) => tableExists(p, "billing_statements"),
  "020_customer_master_extended.sql": (p) => columnExists(p, "customers", "contact_name"),
  "021_address_zones_affiliated_companies.sql": (p) => tableExists(p, "address_zones"),
  "022_customer_master_fk_complete.sql": (p) => columnExists(p, "customers", "address_zone_id"),
  "023_address_barrels_on_site.sql": (p) => columnExists(p, "delivery_addresses", "barrels_on_site"),
  "024_driver_capacity_limits.sql": (p) => columnExists(p, "drivers", "max_order_count"),
  "025_print_slogans.sql": (p) => tableExists(p, "print_slogans"),
  "026_barrel_pickups.sql": (p) => tableExists(p, "barrel_pickups"),
  "027_order_announcements.sql": (p) => tableExists(p, "order_announcements"),
  "028_expense_vouchers.sql": (p) => tableExists(p, "expense_vouchers"),
  "029_tax_invoices_extended.sql": (p) => columnExists(p, "tax_invoices", "external_invoice_no"),
  "030_floor_delivery_bonus.sql": (p) => tableExists(p, "floor_delivery_bonus_records"),
  "031_floor_bonus_multiple_records.sql": (p) => indexExists(p, "floor_delivery_bonus_records", "idx_floor_bonus_line_assignment_floor"),
  "032_delivery_check_received.sql": (p) => columnExists(p, "delivery_assignments", "check_received"),
  "033_barrel_movements.sql": (p) => tableExists(p, "barrel_movements"),
};

async function bootstrapFromExistingDb(prisma: PrismaClient): Promise<void> {
  await ensureTrackingTable(prisma);
  const countRows = await prisma.$queryRaw<{ cnt: bigint }[]>`SELECT COUNT(*) AS cnt FROM schema_migrations`;
  if (Number(countRows[0]?.cnt ?? 0) > 0) return;
  if (!(await tableExists(prisma, "users"))) return;

  const all = listMigrations();
  let markThrough = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const file = all[i]!;
    const probe = MIGRATION_PROBES[file];
    if (probe && (await probe(prisma))) {
      markThrough = i;
      break;
    }
  }
  if (markThrough < 0) return;

  for (let i = 0; i <= markThrough; i++) {
    await recordApplied(prisma, all[i]!);
  }
}

async function getApplied(prisma: PrismaClient): Promise<string[]> {
  await ensureTrackingTable(prisma);
  await bootstrapFromExistingDb(prisma);
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM schema_migrations ORDER BY id ASC`;
  return rows.map((row) => row.id);
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

async function recordApplied(prisma: PrismaClient, filename: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT IGNORE INTO schema_migrations (id) VALUES ('${filename.replace(/'/g, "''")}')`,
  );
}

function printJson(payload: StatusPayload): void {
  console.log(JSON.stringify(payload));
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRun = args.includes("--dry-run");

const prisma = new PrismaClient();

try {
  const all = listMigrations();
  const applied = await getApplied(prisma);
  const appliedSet = new Set(applied);
  const pending = all.filter((name) => !appliedSet.has(name));
  const latest = all.length > 0 ? all[all.length - 1]! : null;

  if (!apply) {
    printJson({ ok: true, applied, pending, latest });
    process.exit(0);
  }

  if (dryRun) {
    printJson({ ok: true, applied, pending, latest, dryRun: true, wouldApply: pending });
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
