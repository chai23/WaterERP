/** Creates a disposable local database; never runs the API against the configured business database. */
import "dotenv/config";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configured = new URL(process.env.DATABASE_URL!);
assert(["localhost", "127.0.0.1"].includes(configured.hostname));
const name = `watererp_append_${Date.now()}_test`;
const admin = new PrismaClient();
configured.hostname = "127.0.0.1";
configured.pathname = `/${name}`;
const socket = createServer();
await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
const address = socket.address();
assert(address && typeof address !== "string");
const port = address.port;
await new Promise<void>(resolve => socket.close(() => resolve()));
const env = { ...process.env, DATABASE_URL: configured.toString(), LEGACY_DATABASE_URL: configured.toString(),
  PORT: String(port), HOST: "127.0.0.1", JWT_SECRET: randomUUID(), NODE_ENV: "development",
  REPORT_TEST_API: `http://127.0.0.1:${port}`, LINE_CHANNEL_ACCESS_TOKEN: "", LINE_CHANNEL_SECRET: "" };
let server: ChildProcess | undefined;
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const file of ["database/schema.sql", "database/migrations/006_role_permissions.sql"]) {
    const run = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "db", "execute",
      "--schema", path.join(root, "apps/api/prisma/schema.prisma"), "--file", path.join(root, file)], { env, encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  }
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: path.join(root, "apps/api"), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  server.stderr?.on("data", data => process.stderr.write(data));
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${env.REPORT_TEST_API}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, "Isolated API failed to start");
  for (const script of ["e2e-report-append.mjs", "e2e-report-topup.mjs"]) {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [`scripts/${script}`], { cwd: path.join(root, "apps/api"), env, windowsHide: true, stdio: "inherit" });
      child.on("error", reject); child.on("exit", resolve);
    });
    assert.equal(code, 0, script);
  }
  console.log(`All report append checks passed. Isolated database retained: ${name}`);
} finally {
  if (server && server.exitCode === null) {
    const child = server;
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
  }
  await admin.$disconnect();
}
