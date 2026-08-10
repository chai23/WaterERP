-- =============================================================================
-- WaterERP：出勤班表本班跑區（依日期＋班別記住司機區域）
-- 加法；不改人工派單。
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE `driver_attendance`
  ADD COLUMN `run_zone_ids_json` JSON NULL DEFAULT NULL COMMENT '本班主跑 AddressZone id 陣列' AFTER `note`;
