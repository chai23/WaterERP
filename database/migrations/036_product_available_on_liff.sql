-- 商品：是否開放 LINE 客戶訂水選單

ALTER TABLE `products`
  ADD COLUMN `available_on_liff` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否顯示於 LINE LIFF 訂水選單' AFTER `consumes_prepaid_barrel`;
