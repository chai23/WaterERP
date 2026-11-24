/** Isolated MySQL/API authorization regression. Never changes configured business data. */
import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { catalog, defaults, validateMatrix, apiPermissions } from "../src/modules/permissions/policy.js";
import { canAccessPath, setMenuPermissions } from "../../web-admin/src/rolePermissions.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const name = `watererp_permissions_test_${Date.now()}`;
const configured = new URL(process.env.DATABASE_URL!);
assert(["localhost", "127.0.0.1"].includes(configured.hostname));
const adminDb = new PrismaClient();
configured.pathname = `/${name}`;
const testUrl = configured.toString();
const db = new PrismaClient({ datasources: { db: { url: testUrl } } });
const port = 3112;
const env = { ...process.env, DATABASE_URL: testUrl, LEGACY_DATABASE_URL: testUrl, PORT: String(port), HOST: "127.0.0.1", JWT_SECRET: "permissions-isolated-regression-secret-2026", NODE_ENV: "development" };
let server: ChildProcess | undefined;
async function api(route: string, token = "", method = "GET", body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
}
async function start() {
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(root, "apps/api"), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr?.on("data", b => process.stderr.write(b));
  for (let i = 0; i < 80; i++) { try { if ((await api("/health")).status === 200) return; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error("Isolated API did not start");
}
async function stop() { if (server && server.exitCode === null) { const child = server; await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); }); } }
let count = 0;
const pass = (s: string) => console.log(`PASS ${++count}: ${s}`);
try {
  assert.equal(catalog.length, 38);
  assert.equal(new Set(catalog.map(m => m.key)).size, 38);
  // Every declared back-office route must have an explicit policy, including new modules.
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
  for (const file of walk(path.join(root, "apps/api/src"))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/app\.(get|post|put|patch|delete)\("(\/api\/[^"?]+)"/g)) {
      const route = match[2]!;
      // The print agent authenticates with its own agent credentials.
      if (route.startsWith("/api/print-agent/")) continue;
      const required = apiPermissions(match[1]!.toUpperCase(), route.replace(/:[A-Za-z]+/g, "1"));
      assert(required === null || required.length > 0, `Unmapped: ${match[1]} ${route}`);
      for (const key of required ?? []) assert(catalog.some(m => m.key === key), `Unknown menu ${key}`);
    }
  }
  for (const menu of catalog) {
    setMenuPermissions([menu.key]);
    for (const other of catalog) assert.equal(canAccessPath("warehouse", other.path), other.key === menu.key);
  }
  setMenuPermissions([]);
  assert.equal(canAccessPath("warehouse", "/expenses/edit/1"), false);
  setMenuPermissions(["expenses.query"]);
  assert.equal(canAccessPath("warehouse", "/expenses/edit/1"), true);
  assert.equal(canAccessPath("warehouse", "/unknown"), false);
  assert.equal(canAccessPath("driver", "/overview"), false);
  pass("38 menus and direct URLs gated; back-office API routes explicitly mapped");
  const bad = defaults(); bad.driver["orders.new"] = true; assert.throws(() => validateMatrix(bad));
  const locked = defaults(); locked.admin.overview = false; assert.throws(() => validateMatrix(locked));
  pass("admin and driver invariants validated");
  await adminDb.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const file of ["database/schema.sql", "database/migrations/006_role_permissions.sql"]) {
    const r = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "execute", "--schema", path.join(root, "apps/api/prisma/schema.prisma"), "--file", path.join(root, file)], { env, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  for (const role of ["admin", "warehouse", "driver"]) await db.user.create({ data: { employeeCode: role, name: role, role, passwordHash: await bcrypt.hash("PermissionTest2026!", 4) } });
  await start();
  const login = async (role: string) => (await api("/auth/login", "", "POST", { employeeCode: role, password: "PermissionTest2026!" })).data.token as string;
  const admin = await login("admin"), staff = await login("warehouse"), driver = await login("driver");
  assert(admin && staff && driver);
  assert.equal((await api("/settings/permissions")).status, 401);
  assert.equal((await api("/settings/permissions", staff)).status, 403);
  assert.equal((await api("/settings/permissions", driver)).status, 403);
  const initial = await api("/settings/permissions", admin);
  assert.equal(initial.status, 200); assert.equal(initial.data.revision, 0);
  assert.deepEqual(initial.data.matrix, defaults());
  pass("authentication, admin-only settings, default matrix");
  assert.equal((await api("/sales-orders", staff, "POST", {})).status, 403);
  let matrix = defaults(); matrix.warehouse["orders.new"] = true;
  let saved = await api("/settings/permissions", admin, "PUT", { revision: 0, matrix });
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, 1);
  const invalidOrder = await api("/sales-orders", staff, "POST", {});
  assert.equal(invalidOrder.status, 400); // Authorized, but invalid input; no business mutation.
  assert((await api("/permissions/me", staff)).data.permissions.includes("orders.new"));
  assert.equal((await api("/settings/permissions", staff, "PUT", { revision: 1, matrix })).status, 403);
  pass("newly granted role passes API checks; staff cannot edit matrix");
  matrix.warehouse["orders.new"] = false;
  saved = await api("/settings/permissions", admin, "PUT", { revision: 1, matrix });
  assert.equal(saved.status, 200);
  assert.equal((await api("/sales-orders", staff, "POST", {})).status, 403);
  assert(!(await api("/permissions/me", staff)).data.permissions.includes("orders.new"));
  pass("revocation takes effect with existing login tokens");
  assert.equal((await api("/settings/permissions", admin, "PUT", { revision: 0, matrix })).status, 409);
  assert.equal((await api("/settings/permissions", admin, "PUT", { revision: 2, matrix: bad })).status, 400);
  const short = structuredClone(matrix); delete short.warehouse["data.users"];
  assert.equal((await api("/settings/permissions", admin, "PUT", { revision: 2, matrix: short })).status, 400);
  pass("stale writes and invalid matrices rejected");
  const writes = await Promise.all([api("/settings/permissions", admin, "PUT", { revision: 2, matrix }), api("/settings/permissions", admin, "PUT", { revision: 2, matrix })]);
  assert.deepEqual(writes.map(x => x.status).sort(), [200, 409]);
  assert.equal(await db.operationAuditLog.count({ where: { action: "role_permissions.update" } }), 3);
  pass("concurrent saves serialized and audit records persisted");
  matrix = defaults(); for (const m of catalog) matrix.warehouse[m.key] = false;
  assert.equal((await api("/settings/permissions", admin, "PUT", { revision: 3, matrix })).status, 200);
  for (const route of ["/customers", "/products", "/sales-orders", "/expense-vouchers", "/accounting/summary", "/users", "/admin/backup-export"]) assert.equal((await api(route, staff)).status, 403, route);
  assert.deepEqual((await api("/permissions/me", staff)).data.permissions, []);
  pass("all-denied role cannot read protected APIs directly");
  await stop(); await start();
  assert.equal((await api("/settings/permissions", admin)).data.revision, 4);
  assert.equal((await api("/sales-orders", staff, "POST", {})).status, 403);
  assert.equal(await db.salesOrder.count(), 0);
  pass("settings survive restart; no order created by rejected requests");
  console.log(`All ${count} checks passed. Isolated database retained: ${name}`);
} finally { await stop(); await Promise.all([db.$disconnect(), adminDb.$disconnect()]); }
