-- =============================================================================
-- 重建空庫（會刪除 water_erp 全部資料）— 僅建立空資料庫
-- =============================================================================
-- 建議用專案指令（會一併匯入最新 schema.sql）：
--   CONFIRM=YES npm run db:rebuild-empty
--
-- 或手動兩步（在專案根目錄）：
--   mysql -u帳號 -p -e "DROP DATABASE IF EXISTS water_erp; CREATE DATABASE water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
--   mysql -u帳號 -p water_erp < database/schema.sql
-- =============================================================================

SET NAMES utf8mb4;
DROP DATABASE IF EXISTS `water_erp`;
CREATE DATABASE `water_erp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
