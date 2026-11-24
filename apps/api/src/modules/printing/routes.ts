import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Express, Request, Response } from "express";

type Database = PrismaClient | Prisma.TransactionClient;
type JobRow = { id: string; status: string; payload: string | null };

function stationHash(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

async function expireJobs(db: Database, station: string) {
  await db.$executeRaw`
    UPDATE order_print_jobs SET status = IF(status = 'claimed', 'unknown', 'expired'), payload = NULL
    WHERE station_hash = ${station} AND (
      (status = 'queued' AND created_at < UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE) OR
      (status = 'claimed' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL 2 MINUTE)
    )`;
}

function route(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    void handler(req, res).catch((error: unknown) => {
      console.error("Order print queue request failed", error instanceof Error ? error.name : "Unknown error");
      res.status(503).json({ message: "列印服務暫時無法使用，請確認資料庫已套用版本更新。" });
    });
  };
}

export function registerPrintAgentRoutes(app: Express, db: PrismaClient) {
  app.post("/api/print-agent/claim", route(async (req, res) => {
    const station = stationHash(req.get("X-Print-Station"));
    if (!station) return res.sendStatus(401);
    const result = await db.$transaction(async tx => {
      const [device] = await tx.$queryRaw<{ station_hash: string }[]>`
        SELECT station_hash FROM order_print_stations WHERE station_hash = ${station} FOR UPDATE`;
      if (!device) return undefined;
      await tx.$executeRaw`UPDATE order_print_stations SET last_seen = UTC_TIMESTAMP(3) WHERE station_hash = ${station}`;
      await expireJobs(tx, station);
      const [current] = await tx.$queryRaw<JobRow[]>`
        SELECT id FROM order_print_jobs WHERE station_hash = ${station} AND status = 'claimed' LIMIT 1`;
      if (current) return null;
      const [job] = await tx.$queryRaw<JobRow[]>`
        SELECT id, payload FROM order_print_jobs WHERE station_hash = ${station} AND status = 'queued'
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`;
      if (!job?.payload) return null;
      await tx.$executeRaw`UPDATE order_print_jobs SET status = 'claimed', claimed_at = UTC_TIMESTAMP(3), payload = NULL
        WHERE id = ${job.id}`;
      return { id: job.id, document: JSON.parse(job.payload) as unknown };
    });
    return result === undefined ? res.sendStatus(401) : res.json({ job: result });
  }));

  app.post("/api/print-agent/result", route(async (req, res) => {
    const station = stationHash(req.get("X-Print-Station"));
    if (!station) return res.sendStatus(401);
    const { id, status } = req.body ?? {};
    if (typeof id !== "string" || id.length !== 36 || !["submitted", "failed", "unknown"].includes(status))
      return res.sendStatus(400);
    await db.$executeRaw`UPDATE order_print_jobs SET status = ${status}
      WHERE id = ${id} AND station_hash = ${station} AND status IN ('claimed', 'unknown')`;
    return res.sendStatus(204);
  }));
}

export function registerOrderPrintRoutes(app: Express, db: PrismaClient, userId: (req: Request) => bigint | undefined) {
  app.post("/api/order-print/station", route(async (req, res) => {
    if (!userId(req)) return res.sendStatus(401);
    const station = stationHash(req.body?.stationKey);
    if (!station) return res.status(400).json({ message: "請輸入助手顯示的配對碼。" });
    await db.$executeRaw`INSERT IGNORE INTO order_print_stations (station_hash) VALUES (${station})`;
    return res.sendStatus(204);
  }));

  app.post("/api/order-print/jobs", route(async (req, res) => {
    const user = userId(req);
    if (!user) return res.sendStatus(401);
    const station = stationHash(req.body?.stationKey);
    const { orderNo, pageWidthMm, pageHeightMm, html } = req.body ?? {};
    const validSize = (size: unknown) => typeof size === "number" && size >= 20 && size <= 1000;
    if (!station || typeof orderNo !== "string" || !orderNo || orderNo.length > 64 ||
        !validSize(pageWidthMm) || !validSize(pageHeightMm) || typeof html !== "string" ||
        Buffer.byteLength(html) > 200_000 || !/^<!DOCTYPE html>\s*<html lang="zh-Hant">\s*<head>/.test(html)) {
      return res.status(400).json({ message: "列印資料格式有誤。" });
    }
    const order = await db.salesOrder.findFirst({ where: { orderNo }, select: { id: true } });
    if (!order) return res.status(404).json({ message: "找不到要套印的訂單。" });
    const job = await db.$transaction(async tx => {
      const [device] = await tx.$queryRaw<{ online: number | bigint }[]>`
        SELECT COALESCE(last_seen >= UTC_TIMESTAMP(3) - INTERVAL 20 SECOND, 0) AS online
        FROM order_print_stations WHERE station_hash = ${station} FOR UPDATE`;
      if (!device || Number(device.online) !== 1) return null;
      await expireJobs(tx, station);
      const [existing] = await tx.$queryRaw<JobRow[]>`
        SELECT id, status FROM order_print_jobs WHERE station_hash = ${station} AND user_id = ${user}
          AND order_no = ${orderNo} AND (status IN ('queued', 'claimed') OR
            (status = 'submitted' AND created_at >= UTC_TIMESTAMP(3) - INTERVAL 5 SECOND))
        ORDER BY created_at DESC LIMIT 1`;
      if (existing) return { id: existing.id, status: existing.status };
      const id = randomUUID();
      const payload = JSON.stringify({ version: 1, pageWidthMm, pageHeightMm, html });
      await tx.$executeRaw`INSERT INTO order_print_jobs (id, station_hash, user_id, order_no, payload, status, created_at)
        VALUES (${id}, ${station}, ${user}, ${orderNo}, ${payload}, 'queued', UTC_TIMESTAMP(3))`;
      return { id, status: "queued" };
    });
    return job ? res.status(202).json(job) : res.status(409).json({ message: "列印助手離線。請開啟助手、選擇印表機並啟用接單。" });
  }));

  app.get("/api/order-print/jobs/:id", route(async (req, res) => {
    const user = userId(req);
    if (!user) return res.sendStatus(401);
    const [job] = await db.$queryRaw<{ station_hash: string }[]>`
      SELECT station_hash FROM order_print_jobs WHERE id = ${req.params.id} AND user_id = ${user}`;
    if (!job) return res.sendStatus(404);
    await expireJobs(db, job.station_hash);
    const [current] = await db.$queryRaw<JobRow[]>`
      SELECT id, status FROM order_print_jobs WHERE id = ${req.params.id} AND user_id = ${user}`;
    return res.json(current);
  }));
}
