import type { Express, Request, Response } from "express";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isDeliveryPlanningEnabled } from "./flag.js";
import { applyGeocodeToAddress, confirmAddressLocation } from "./geocode.js";
import { parseDeliveryConstraints } from "./parseConstraints.js";
import { optimizeSuggestDriver, loadPlan, serializePlanPayload } from "./suggestOptimize.js";
import { optimizeShiftOneClick } from "./shiftOptimize.js";
import { listShiftBoard, parseZoneFilter } from "./shiftBoard.js";
import { publishPlan, cancelPlan, patchPlanStops } from "./publish.js";
import { writePlanningAudit } from "./audit.js";
import { parseShiftCode, parseYmd } from "./shiftSla.js";
import {
  cutoffConfigFromSettings,
  loadPlanningSettings,
  slaConfigFromSettings,
  upsertPlanningSettings,
} from "./settings.js";

type AuthUser = {
  id: bigint;
  employeeCode: string;
  name: string;
  role: string;
  driverId: bigint | null;
};

type RegisterArgs = {
  app: Express;
  prisma: PrismaClient;
  getAuthUser: (req: Request) => AuthUser | null;
  requireRole: (req: Request, res: Response, roles: readonly string[]) => AuthUser | null;
  toBigInt: (value: unknown) => bigint | null;
};

function parseRunZoneIds(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((x) => String(x)).filter((x) => /^\d+$/.test(x)))];
}

function parseDriverZones(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [driverId, zones] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(driverId) || !Array.isArray(zones)) continue;
    const ids = [...new Set(zones.map((x) => String(x)).filter((x) => /^\d+$/.test(x)))];
    if (ids.length) out[driverId] = ids;
  }
  return Object.keys(out).length ? out : undefined;
}

function requirePlanningEnabled(_req: Request, res: Response): boolean {
  if (!isDeliveryPlanningEnabled()) {
    res.status(404).json({ ok: false, message: "AI 派單功能未啟用" });
    return false;
  }
  return true;
}

export function registerDeliveryPlanningRoutes(args: RegisterArgs): void {
  const { app, prisma, getAuthUser, requireRole, toBigInt } = args;

  /** 即使 flag 關閉也可查詢，供前端決定是否顯示切換 */
  app.get("/api/delivery-planning/status", (req, res) => {
    const auth = getAuthUser(req);
    if (!auth) {
      res.status(401).json({ ok: false, message: "請先登入" });
      return;
    }
    res.json({
      ok: true,
      data: {
        enabled: isDeliveryPlanningEnabled(),
        hasOpenAiKey: Boolean((process.env.OPENAI_API_KEY ?? "").trim()),
        hasGoogleMapsKey: Boolean((process.env.GOOGLE_MAPS_API_KEY ?? "").trim()),
      },
    });
  });

  app.post("/api/ai/parse-delivery-constraints", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const body = req.body as {
        salesOrderId?: unknown;
        noteText?: unknown;
        persist?: unknown;
      };
      const noteText = typeof body.noteText === "string" ? body.noteText : "";
      const salesOrderId = toBigInt(body.salesOrderId);
      const result = await parseDeliveryConstraints(prisma, {
        noteText,
        salesOrderId,
        persist: Boolean(body.persist),
        actorUserId: auth.id,
      });
      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  /** 客戶主檔／排程共用：不依賴 DELIVERY_PLANNING_ENABLED */
  app.post("/api/delivery-addresses/:id/geocode", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: "id 無效" });
        return;
      }
      const out = await applyGeocodeToAddress(prisma, id);
      res.json({ ok: true, data: out });
    } catch (e) {
      const msg = String(e);
      res.status(msg.includes("ADDRESS_NOT_FOUND") ? 404 : 500).json({ ok: false, message: msg });
    }
  });

  app.patch("/api/delivery-addresses/:id/location", async (req, res) => {
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      const body = req.body as {
        latitude?: unknown;
        longitude?: unknown;
        geocodedAddress?: unknown;
      };
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        res.status(400).json({ ok: false, message: "id / latitude / longitude 必填" });
        return;
      }
      const updated = await confirmAddressLocation(prisma, {
        addressId: id,
        latitude,
        longitude,
        geocodedAddress: typeof body.geocodedAddress === "string" ? body.geocodedAddress : null,
      });
      res.json({ ok: true, data: updated });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.put("/api/drivers/:driverId/attendance", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const driverId = toBigInt(req.params.driverId);
      const body = req.body as {
        workDate?: unknown;
        shift?: unknown;
        isOnDuty?: unknown;
        workStartTime?: unknown;
        workEndTime?: unknown;
        note?: unknown;
        runZoneIds?: unknown;
      };
      const workDateStr = typeof body.workDate === "string" ? body.workDate.trim() : "";
      if (!driverId || !/^\d{4}-\d{2}-\d{2}$/.test(workDateStr)) {
        res.status(400).json({ ok: false, message: "driverId / workDate(YYYY-MM-DD) 必填" });
        return;
      }
      const shiftRaw = typeof body.shift === "string" ? body.shift.trim() : "all";
      const shift = shiftRaw === "am" || shiftRaw === "pm" || shiftRaw === "all" ? shiftRaw : "all";
      const workDate = parseYmd(workDateStr);
      if (!workDate) {
        res.status(400).json({ ok: false, message: "workDate 無效" });
        return;
      }
      const parseTime = (v: unknown): Date | null => {
        if (typeof v !== "string" || !/^\d{2}:\d{2}/.test(v)) return null;
        const [hh, mm] = v.split(":").map(Number);
        return new Date(Date.UTC(1970, 0, 1, hh!, mm!, 0));
      };
      let runZoneIds: string[] | undefined;
      if (body.runZoneIds !== undefined) {
        const parsed = parseRunZoneIds(body.runZoneIds);
        if (parsed == null) {
          res.status(400).json({ ok: false, message: "runZoneIds 須為區域 id 陣列" });
          return;
        }
        runZoneIds = parsed;
      }
      const row = await prisma.driverAttendance.upsert({
        where: { driverId_workDate_shift: { driverId, workDate, shift } },
        create: {
          driverId,
          workDate,
          shift,
          isOnDuty: body.isOnDuty === false ? false : true,
          workStartTime: parseTime(body.workStartTime),
          workEndTime: parseTime(body.workEndTime),
          note: typeof body.note === "string" ? body.note : null,
          runZoneIdsJson: runZoneIds ?? Prisma.JsonNull,
        },
        update: {
          isOnDuty: body.isOnDuty === false ? false : body.isOnDuty === true ? true : undefined,
          workStartTime: body.workStartTime !== undefined ? parseTime(body.workStartTime) : undefined,
          workEndTime: body.workEndTime !== undefined ? parseTime(body.workEndTime) : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          runZoneIdsJson: runZoneIds,
        },
      });
      res.json({
        ok: true,
        data: {
          ...row,
          id: row.id.toString(),
          driverId: row.driverId.toString(),
          runZoneIds: parseRunZoneIds(row.runZoneIdsJson) ?? [],
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/drivers/attendance", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const workDateStr = typeof req.query.workDate === "string" ? req.query.workDate.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(workDateStr)) {
        res.status(400).json({ ok: false, message: "workDate=YYYY-MM-DD 必填" });
        return;
      }
      const shiftQ = typeof req.query.shift === "string" ? req.query.shift.trim() : "";
      const shift = shiftQ === "am" || shiftQ === "pm" ? shiftQ : "";
      const workDate = parseYmd(workDateStr);
      if (!workDate) {
        res.status(400).json({ ok: false, message: "workDate 無效" });
        return;
      }
      const drivers = await prisma.driver.findMany({
        where: { isActive: true },
        include: { user: true, vehicle: true },
        orderBy: { id: "asc" },
      });
      const rows = await prisma.driverAttendance.findMany({
        where: {
          workDate,
          ...(shift ? { shift: { in: [shift, "all"] } } : {}),
        },
      });
      const attByDriver = new Map<string, (typeof rows)[number]>();
      for (const a of rows) {
        const key = a.driverId.toString();
        const prev = attByDriver.get(key);
        if (!prev || (shift && a.shift === shift)) attByDriver.set(key, a);
      }
      const roster = drivers.map((d) => {
        const att = attByDriver.get(d.id.toString());
        const status = !att ? "unset" : att.isOnDuty ? "on" : "off";
        return {
          driverId: d.id.toString(),
          name: d.user?.name ?? `司機#${d.id.toString()}`,
          plateNo: d.vehicle?.plateNo ?? null,
          maxOrderCount: d.maxOrderCount,
          maxBarrelQty: d.maxBarrelQty,
          shift: att?.shift ?? (shift || "all"),
          status,
          isOnDuty: att?.isOnDuty ?? null,
          note: att?.note ?? null,
          runZoneIds: parseRunZoneIds(att?.runZoneIdsJson),
        };
      });
      res.json({ ok: true, data: { workDate: workDateStr, shift: shift || null, roster } });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/delivery-planning/settings", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const settings = await loadPlanningSettings(prisma);
      res.json({
        ok: true,
        data: {
          settings,
          sla: slaConfigFromSettings(settings),
          cutoff: cutoffConfigFromSettings(settings),
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.put("/api/delivery-planning/settings", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const body = req.body as { settings?: unknown };
      if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
        res.status(400).json({ ok: false, message: "settings 須為物件" });
        return;
      }
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.settings as Record<string, unknown>)) {
        if (v == null) patch[k] = "";
        else patch[k] = String(v);
      }
      const settings = await upsertPlanningSettings(prisma, patch, auth.id);
      await writePlanningAudit(prisma, {
        action: "update_settings",
        inputSummary: patch,
        outputSummary: {
          sla: slaConfigFromSettings(settings),
          cutoff: cutoffConfigFromSettings(settings),
        },
        actorUserId: auth.id,
      });
      res.json({
        ok: true,
        data: {
          settings,
          sla: slaConfigFromSettings(settings),
          cutoff: cutoffConfigFromSettings(settings),
        },
      });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/delivery-plans/shift-board", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const planDate = typeof req.query.planDate === "string" ? req.query.planDate.trim() : "";
      const shift = parseShiftCode(req.query.shift);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate) || !shift) {
        res.status(400).json({ ok: false, message: "planDate=YYYY-MM-DD 與 shift=am|pm 必填" });
        return;
      }
      const data = await listShiftBoard(prisma, {
        planDate,
        shift,
        zone: parseZoneFilter(req.query.zoneId),
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/delivery-plans/optimize", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const body = req.body as {
        planDate?: unknown;
        shift?: unknown;
        mode?: unknown;
        salesOrderIds?: unknown;
        driverIds?: unknown;
        zoneId?: unknown;
        driverZones?: unknown;
        weightProfileKey?: unknown;
      };
      const planDate = typeof body.planDate === "string" ? body.planDate.trim() : "";
      const mode = typeof body.mode === "string" ? body.mode : "shift_one_click";
      const driverIds = Array.isArray(body.driverIds)
        ? body.driverIds.map((x) => toBigInt(x)).filter((x): x is bigint => x != null)
        : undefined;

      if (mode === "shift_one_click") {
        const shift = parseShiftCode(body.shift);
        if (!shift) {
          res.status(400).json({ ok: false, message: "shift 須為 am 或 pm" });
          return;
        }
        const salesOrderIds = Array.isArray(body.salesOrderIds)
          ? body.salesOrderIds.map((x) => toBigInt(x)).filter((x): x is bigint => x != null)
          : undefined;
        const zoneRaw = typeof body.zoneId === "string" ? body.zoneId.trim() : body.zoneId;
        const zoneId =
          zoneRaw === "none" || zoneRaw === null
            ? null
            : zoneRaw === "all" || zoneRaw === undefined || zoneRaw === ""
              ? undefined
              : toBigInt(zoneRaw);
        if (zoneRaw != null && zoneRaw !== "" && zoneRaw !== "all" && zoneRaw !== "none" && zoneId == null) {
          res.status(400).json({ ok: false, message: "zoneId 無效" });
          return;
        }
        const data = await optimizeShiftOneClick(prisma, {
          planDate,
          shift,
          driverIds,
          salesOrderIds,
          zoneId,
          driverZones: parseDriverZones(body.driverZones),
          actorUserId: auth.id,
        });
        res.status(201).json({ ok: true, data });
        return;
      }

      if (mode !== "suggest_driver") {
        res.status(400).json({
          ok: false,
          message: "僅支援 mode=shift_one_click 或 suggest_driver",
        });
        return;
      }
      const salesOrderIds = Array.isArray(body.salesOrderIds)
        ? body.salesOrderIds.map((x) => toBigInt(x)).filter((x): x is bigint => x != null)
        : undefined;
      const data = await optimizeSuggestDriver(prisma, {
        planDate,
        salesOrderIds,
        driverIds,
        weightProfileKey: typeof body.weightProfileKey === "string" ? body.weightProfileKey : undefined,
        actorUserId: auth.id,
      });
      res.status(201).json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/delivery-plans", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const planDateStr = typeof req.query.planDate === "string" ? req.query.planDate.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(planDateStr)) {
        res.status(400).json({ ok: false, message: "planDate 必填" });
        return;
      }
      const planDate = parseYmd(planDateStr);
      if (!planDate) {
        res.status(400).json({ ok: false, message: "planDate 無效" });
        return;
      }
      const rows = await prisma.deliveryPlan.findMany({
        where: { planDate },
        orderBy: { version: "desc" },
        take: 20,
      });
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/delivery-plans/:id", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: "id 無效" });
        return;
      }
      const full = await loadPlan(prisma, id);
      if (!full) {
        res.status(404).json({ ok: false, message: "找不到方案" });
        return;
      }
      res.json({ ok: true, data: serializePlanPayload(id, full) });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });

  app.patch("/api/delivery-plans/:id/stops", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      const body = req.body as { moves?: unknown };
      if (!id || !Array.isArray(body.moves)) {
        res.status(400).json({ ok: false, message: "id / moves 必填" });
        return;
      }
      const moves = body.moves.map((m) => {
        const row = m as {
          salesOrderId?: unknown;
          toDriverId?: unknown;
          toSequence?: unknown;
          manualAdjustReason?: unknown;
        };
        const salesOrderId = toBigInt(row.salesOrderId);
        const toDriverId = toBigInt(row.toDriverId);
        const toSequence = Number(row.toSequence);
        if (!salesOrderId || !toDriverId || !Number.isFinite(toSequence)) {
          throw new Error("moves 參數錯誤");
        }
        return {
          salesOrderId,
          toDriverId,
          toSequence,
          manualAdjustReason:
            typeof row.manualAdjustReason === "string" ? row.manualAdjustReason : null,
        };
      });
      const data = await patchPlanStops(prisma, { planId: id, moves, actorUserId: auth.id });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/delivery-plans/:id/publish", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: "id 無效" });
        return;
      }
      const body = req.body as { assignmentDate?: unknown; onlyStopIds?: unknown };
      const onlyStopIds = Array.isArray(body.onlyStopIds)
        ? body.onlyStopIds.map((x) => toBigInt(x)).filter((x): x is bigint => x != null)
        : null;
      const data = await publishPlan(prisma, {
        planId: id,
        assignmentDate: typeof body.assignmentDate === "string" ? body.assignmentDate : undefined,
        onlyStopIds,
        actorUserId: auth.id,
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.post("/api/delivery-plans/:id/cancel", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: "id 無效" });
        return;
      }
      const body = req.body as { reason?: unknown };
      const data = await cancelPlan(prisma, {
        planId: id,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        actorUserId: auth.id,
      });
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, message: String(e) });
    }
  });

  app.get("/api/delivery-plans/:id/explanations", async (req, res) => {
    if (!requirePlanningEnabled(req, res)) return;
    const auth = requireRole(req, res, ["admin", "dispatcher"]);
    if (!auth) return;
    try {
      const id = toBigInt(req.params.id);
      if (!id) {
        res.status(400).json({ ok: false, message: "id 無效" });
        return;
      }
      const full = await loadPlan(prisma, id);
      if (!full) {
        res.status(404).json({ ok: false, message: "找不到方案" });
        return;
      }
      const explanations = full.routes.flatMap((r) =>
        r.stops.map((s) => ({
          stopId: s.id.toString(),
          salesOrderId: s.salesOrderId.toString(),
          orderNo: s.salesOrder.orderNo,
          driverId: r.driverId.toString(),
          explanation: s.aiExplanation,
          manualAdjustReason: s.manualAdjustReason,
        })),
      );
      res.json({ ok: true, data: { planId: id.toString(), explanations } });
    } catch (e) {
      res.status(500).json({ ok: false, message: String(e) });
    }
  });
}
