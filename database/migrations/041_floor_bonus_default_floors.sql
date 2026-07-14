-- 預設搬運樓層單價改為僅 3、2、-1 樓

DELETE FROM `payroll_floor_bonus_rates`
WHERE `floor` NOT IN (2, 3, -1);

INSERT INTO `payroll_floor_bonus_rates` (`floor`, `wage`)
SELECT f.floor_no, COALESCE((SELECT `floor_bonus_wage` FROM `payroll_settings` WHERE `id` = 1), 0)
FROM (
  SELECT 3 AS floor_no UNION ALL SELECT 2 UNION ALL SELECT -1
) AS f
WHERE NOT EXISTS (
  SELECT 1 FROM `payroll_floor_bonus_rates` r WHERE r.`floor` = f.floor_no
);
