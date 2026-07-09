-- 商品「計入押桶」：核銷送達時用於客戶未收回空桶計算（不依賴單位欄位）

ALTER TABLE `products`
  ADD COLUMN `counts_deposit_barrel` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '核銷送達時是否計入客戶未收回空桶（與單位無關）'
    AFTER `unit`;

-- 舊資料：先前以「單位=桶」推斷者，遷移為勾選計入押桶（之後請以商品主檔為準）
UPDATE `products`
SET `counts_deposit_barrel` = 1
WHERE TRIM(`unit`) = '桶';
