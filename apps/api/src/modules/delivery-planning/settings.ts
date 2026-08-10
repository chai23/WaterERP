import type { PrismaClient } from "@prisma/client";
import { addCalendarDays, isSunday, type ShiftCode } from "./shiftSla.js";

const DEFAULTS: Record<string, string> = {
  "shift.am.start": "08:00",
  "shift.am.end": "12:00",
  "shift.pm.start": "13:00",
  "shift.pm.end": "17:30",
  "shift.am.cutoff": "15:00",
  "shift.pm.cutoff": "10:00",
  "sla.general_shifts": "4",
  "sla.after_scheduled_shifts": "",
  "patrol.early_shifts": "1",
  "patrol.late_shifts": "1",
};

export const PLANNING_SETTING_KEYS = [
  "sla.general_shifts",
  "sla.after_scheduled_shifts",
  "patrol.early_shifts",
  "patrol.late_shifts",
  "shift.am.cutoff",
  "shift.pm.cutoff",
] as const;

export type SlaConfig = {
  generalShifts: number;
  patrolEarlyShifts: number;
  patrolLateShifts: number;
  /** null＝不另依預定日；0＝過了預定日當天 pm 就必送 */
  afterScheduledShifts: number | null;
};

export const DEFAULT_SLA_CONFIG: SlaConfig = {
  generalShifts: 4,
  patrolEarlyShifts: 1,
  patrolLateShifts: 1,
  afterScheduledShifts: null,
};

export type CutoffConfig = {
  am: string;
  pm: string;
};

export const DEFAULT_CUTOFF_CONFIG: CutoffConfig = { am: "15:00", pm: "10:00" };

function parseIntInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export function slaConfigFromSettings(settings: Record<string, string>): SlaConfig {
  const afterRaw = (settings["sla.after_scheduled_shifts"] ?? "").trim();
  let afterScheduledShifts: number | null = null;
  if (afterRaw !== "") {
    const n = Number(afterRaw);
    if (Number.isInteger(n) && n >= 0 && n <= 20) afterScheduledShifts = n;
  }
  return {
    generalShifts: parseIntInRange(settings["sla.general_shifts"], 1, 20, 4),
    patrolEarlyShifts: parseIntInRange(settings["patrol.early_shifts"], 0, 10, 1),
    patrolLateShifts: parseIntInRange(settings["patrol.late_shifts"], 0, 10, 1),
    afterScheduledShifts,
  };
}

export function cutoffConfigFromSettings(settings: Record<string, string>): CutoffConfig {
  return {
    am: normalizeHm(settings["shift.am.cutoff"]) ?? DEFAULT_CUTOFF_CONFIG.am,
    pm: normalizeHm(settings["shift.pm.cutoff"]) ?? DEFAULT_CUTOFF_CONFIG.pm,
  };
}

export async function upsertPlanningSettings(
  prisma: PrismaClient,
  patch: Record<string, string>,
  actorUserId?: bigint | null,
): Promise<Record<string, string>> {
  const allowed = new Set<string>(PLANNING_SETTING_KEYS);
  const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`不允許修改：${unknown.join("、")}`);

  for (const [key, raw] of Object.entries(patch)) {
    let value = String(raw ?? "").trim();
    if (key === "sla.after_scheduled_shifts") {
      if (value !== "") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 20) {
          throw new Error("超過預定日後班次數須為 0–20 的整數，或留空表示不另依預定日");
        }
      }
    } else if (key === "sla.general_shifts") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("一般單最晚班次數須為 1–20");
    } else if (key === "patrol.early_shifts" || key === "patrol.late_shifts") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error("巡單提前／延後班次數須為 0–10");
    } else if (key === "shift.am.cutoff" || key === "shift.pm.cutoff") {
      const hm = normalizeHm(value);
      if (!hm) throw new Error("截單時間須為 HH:mm（例如 10:00）");
      value = hm;
    }
    await prisma.deliveryPlanningSetting.upsert({
      where: { settingKey: key },
      create: { settingKey: key, settingValue: value, updatedByUserId: actorUserId ?? null },
      update: { settingValue: value, updatedByUserId: actorUserId ?? null },
    });
  }
  return loadPlanningSettings(prisma);
}

export async function loadPlanningSettings(prisma: PrismaClient): Promise<Record<string, string>> {
  const rows = await prisma.deliveryPlanningSetting.findMany();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.settingKey] = r.settingValue;
  return out;
}

function parseHm(v: string | undefined): { hh: number; mm: number } | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return { hh, mm };
}

export function normalizeHm(v: string | undefined): string | null {
  const p = parseHm(v);
  if (!p) return null;
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

export function prevBusinessYmd(ymd: string): string {
  let prev = addCalendarDays(ymd, -1);
  while (isSunday(prev)) prev = addCalendarDays(prev, -1);
  return prev;
}

export type ShiftCutoff = {
  at: Date;
  ymd: string;
  hm: string;
  label: string;
  passed: boolean;
};

/** 上午班截單＝配送日前一個營業日 `shift.am.cutoff`；下午班截單＝配送日當天 `shift.pm.cutoff` */
export function shiftCutoffAt(
  planDate: string,
  shift: ShiftCode,
  settings: Record<string, string>,
  now = new Date(),
): ShiftCutoff | null {
  const key = shift === "am" ? "shift.am.cutoff" : "shift.pm.cutoff";
  const hm = parseHm(settings[key]);
  if (!hm) return null;
  const ymd = shift === "am" ? prevBusinessYmd(planDate) : planDate;
  const at = new Date(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
    hm.hh,
    hm.mm,
    0,
    0,
  );
  const hmLabel = `${String(hm.hh).padStart(2, "0")}:${String(hm.mm).padStart(2, "0")}`;
  return {
    at,
    ymd,
    hm: hmLabel,
    label: `${ymd} ${hmLabel}`,
    passed: now.getTime() > at.getTime(),
  };
}

export function assertShiftNotPastCutoff(
  planDate: string,
  shift: ShiftCode,
  settings: Record<string, string>,
  now = new Date(),
): void {
  const c = shiftCutoffAt(planDate, shift, settings, now);
  if (c?.passed) {
    throw new Error(`已過本班截單時間（${c.label}），不可再排程或發布`);
  }
}
