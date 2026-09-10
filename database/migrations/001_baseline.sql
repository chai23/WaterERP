-- =============================================================================
-- 001 基線標記（不建表）
-- =============================================================================
-- 完整資料庫結構以 database/schema.sql 為準。
--
-- 新伺服器建全新空庫：
--   1. CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   2. mysql -u... -p water_erp < database/schema.sql
--   或：CONFIRM=YES npm run db:rebuild-empty
--
-- 本檔只做版本追蹤起點。匯入 schema.sql 時會寫入 schema_migrations = 001_baseline.sql。
-- 之後若要幫「已在跑的舊庫」加欄位／新表，再新增 002_xxx.sql。
-- =============================================================================

SELECT 1;
