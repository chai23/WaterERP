import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

export const ADMIN_EMPLOYEE_CODE = "admin";
export const ADMIN_NAME = "系統管理員";
export const ADMIN_PASSWORD = "admin123";

/** 確保存在 role=admin 的系統管理員帳號（employee_code=admin）。 */
export async function ensureAdminUser(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { employeeCode: ADMIN_EMPLOYEE_CODE } });
  if (existing) {
    if (existing.role !== "admin" || existing.phone != null) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { role: "admin", isActive: true, phone: null },
      });
      console.log(`已更新既有帳號 ${ADMIN_EMPLOYEE_CODE}（admin，phone 清空）`);
    } else {
      console.log(`帳號 ${ADMIN_EMPLOYEE_CODE} 已存在（role=admin）`);
    }
    return;
  }

  const user = await prisma.user.create({
    data: {
      employeeCode: ADMIN_EMPLOYEE_CODE,
      name: ADMIN_NAME,
      phone: null,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      role: "admin",
      isActive: true,
    },
  });
  console.log(`已建立管理員：${ADMIN_EMPLOYEE_CODE}（id=${user.id}）`);
  console.log(`登入帳號：${ADMIN_EMPLOYEE_CODE}，密碼：${ADMIN_PASSWORD}`);
}

/**
 * 建立 id=1 的系統管理員（供舊庫人員轉換後使用，與 API DEFAULT_CREATOR_USER_ID 一致）。
 * 呼叫前應已清空 users；匯入舊人員前呼叫，使後續使用者自 id=2 起編號。
 */
export async function ensureAdminUserId1(prisma: PrismaClient): Promise<void> {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const existing = await prisma.user.findUnique({ where: { id: 1n } });
  if (existing) {
    if (existing.employeeCode !== ADMIN_EMPLOYEE_CODE) {
      throw new Error(`users.id=1 已存在且員編為 ${existing.employeeCode}，無法建立系統管理員`);
    }
    await prisma.user.update({
      where: { id: 1n },
      data: {
        name: ADMIN_NAME,
        phone: null,
        passwordHash,
        role: "admin",
        isActive: true,
      },
    });
    console.log(`已更新系統管理員 id=1（${ADMIN_EMPLOYEE_CODE}）`);
  } else {
    await prisma.user.create({
      data: {
        id: 1n,
        employeeCode: ADMIN_EMPLOYEE_CODE,
        name: ADMIN_NAME,
        phone: null,
        passwordHash,
        role: "admin",
        isActive: true,
      },
    });
    console.log(`已建立系統管理員 id=1（${ADMIN_EMPLOYEE_CODE}，密碼 ${ADMIN_PASSWORD}）`);
  }
  await prisma.$executeRawUnsafe(`ALTER TABLE users AUTO_INCREMENT = 2`);
}
