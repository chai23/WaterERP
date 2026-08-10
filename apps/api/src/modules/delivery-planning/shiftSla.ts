/** 營業班次：週一–六，每日 am／pm；週日不計班。 */

export type ShiftCode = "am" | "pm";

export type ShiftKey = {
  date: string;
  shift: ShiftCode;
};

export const GENERAL_SLA_SHIFTS = 4;

/** Prisma `@db.Date`：UTC 午夜表示曆日（與 index.ts parseLocalYmdToDbDate 一致） */
export function parseYmd(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** 本地曆日（牆鐘／「現在」用） */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addCalendarDays(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  if (!d) throw new Error(`invalid ymd ${ymd}`);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdFromDbDate(d) ?? ymd;
}

export function isSunday(ymd: string): boolean {
  const d = parseYmd(ymd);
  return d ? d.getUTCDay() === 0 : false;
}

export function nextShift(key: ShiftKey): ShiftKey {
  if (key.shift === "am") return { date: key.date, shift: "pm" };
  let next = addCalendarDays(key.date, 1);
  while (isSunday(next)) next = addCalendarDays(next, 1);
  return { date: next, shift: "am" };
}

export function prevShift(key: ShiftKey): ShiftKey {
  if (key.shift === "pm") return { date: key.date, shift: "am" };
  let prev = addCalendarDays(key.date, -1);
  while (isSunday(prev)) prev = addCalendarDays(prev, -1);
  return { date: prev, shift: "pm" };
}

export function addShifts(key: ShiftKey, n: number): ShiftKey {
  let cur = key;
  if (n >= 0) {
    for (let i = 0; i < n; i++) cur = nextShift(cur);
  } else {
    for (let i = 0; i < -n; i++) cur = prevShift(cur);
  }
  return cur;
}

export function compareShift(a: ShiftKey, b: ShiftKey): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.shift === b.shift) return 0;
  return a.shift === "am" ? -1 : 1;
}

export function shiftContaining(at: Date): ShiftKey {
  let ymd = toYmd(at);
  if (isSunday(ymd)) {
    let next = addCalendarDays(ymd, 1);
    while (isSunday(next)) next = addCalendarDays(next, 1);
    return { date: next, shift: "am" };
  }
  const hours = at.getHours();
  return { date: ymd, shift: hours < 12 ? "am" : "pm" };
}

export function generalLatestFromCreatedAt(createdAt: Date, slaShifts = GENERAL_SLA_SHIFTS): ShiftKey {
  return addShifts(shiftContaining(createdAt), Math.max(1, slaShifts));
}

/** 一般單有效最晚班：成立＋SLA、訂單已寫 latest、（可選）預定日後寬限，取最早者 */
export function generalEffectiveLatest(
  createdAt: Date,
  scheduledYmd: string | null,
  storedLatest: ShiftKey | null,
  generalShifts: number,
  afterScheduledShifts: number | null,
): ShiftKey {
  const candidates: ShiftKey[] = [generalLatestFromCreatedAt(createdAt, generalShifts)];
  if (storedLatest) candidates.push(storedLatest);
  if (afterScheduledShifts != null && scheduledYmd) {
    candidates.push(addShifts({ date: scheduledYmd, shift: "pm" }, afterScheduledShifts));
  }
  return candidates.reduce((a, b) => (compareShift(a, b) <= 0 ? a : b));
}

/** 巡單到期日視窗：最早＝到期日 am 往前 N 班，最晚＝到期日 pm 往後 N 班 */
export function patrolWindow(
  dueDateYmd: string,
  earlyShifts = 1,
  lateShifts = 1,
): { earliest: ShiftKey; latest: ShiftKey } {
  const earlyN = Math.max(0, Math.floor(earlyShifts));
  const lateN = Math.max(0, Math.floor(lateShifts));
  return {
    earliest: addShifts({ date: dueDateYmd, shift: "am" }, -earlyN),
    latest: addShifts({ date: dueDateYmd, shift: "pm" }, lateN),
  };
}

export type PatrolClass = "overdue" | "on_due" | "early" | "late" | "out";

export function classifyPatrolForShift(
  dueDateYmd: string,
  target: ShiftKey,
  earlyShifts = 1,
  lateShifts = 1,
): PatrolClass {
  const { earliest, latest } = patrolWindow(dueDateYmd, earlyShifts, lateShifts);
  if (compareShift(target, earliest) < 0) return "out";
  if (compareShift(target, latest) > 0) return "overdue";
  if (target.date === dueDateYmd) return "on_due";
  if (compareShift(target, { date: dueDateYmd, shift: "am" }) < 0) return "early";
  if (compareShift(target, { date: dueDateYmd, shift: "pm" }) > 0) return "late";
  return "on_due";
}

export function parseShiftCode(v: unknown): ShiftCode | null {
  return v === "am" || v === "pm" ? v : null;
}

export function formatShiftLabel(shift: string): string {
  if (shift === "am") return "上午";
  if (shift === "pm") return "下午";
  return shift;
}

export function suggestedNextShift(target: ShiftKey): ShiftKey {
  return nextShift(target);
}

export function shiftMinutes(shift: ShiftCode): number {
  return shift === "am" ? 240 : 270;
}

/** Prisma `@db.Date`（UTC 午夜）→ YYYY-MM-DD */
export function ymdFromDbDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
