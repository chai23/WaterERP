-- 未收回空桶改為依送貨地址分開計算
-- 執行前請備份。既有 customers.barrels_on_site 會遷移至「預設地址」或 id 最小之地址。

ALTER TABLE `delivery_addresses`
  ADD COLUMN `barrels_on_site` INT NOT NULL DEFAULT 0
    COMMENT '此送貨點未收回空桶數：核銷送達時依押桶商品與回桶數自動增減，亦可手動調整'
    AFTER `is_default`;

UPDATE `delivery_addresses` da
INNER JOIN (
  SELECT
    c.`id` AS `customer_id`,
    c.`barrels_on_site`,
    COALESCE(
      (
        SELECT da2.`id`
        FROM `delivery_addresses` da2
        WHERE da2.`customer_id` = c.`id` AND da2.`is_default` = 1
        ORDER BY da2.`id` ASC
        LIMIT 1
      ),
      (
        SELECT da3.`id`
        FROM `delivery_addresses` da3
        WHERE da3.`customer_id` = c.`id`
        ORDER BY da3.`id` ASC
        LIMIT 1
      )
    ) AS `target_addr_id`
  FROM `customers` c
) x ON da.`id` = x.`target_addr_id`
SET da.`barrels_on_site` = x.`barrels_on_site`;

UPDATE `customers` SET `barrels_on_site` = 0;
