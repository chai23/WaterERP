# WaterERP AI 自動派單 — 設計包

本目錄為設計文件與 SQL 草案／正式 migration 對照。

> **MVP-A + 班次一鍵排程已實作**（flag：`DELIVERY_PLANNING_ENABLED`）。  
> 結構已併入 `database/schema.sql`（基線 `001_baseline.sql`）。本目錄 SQL 僅供設計對照。

| 文件 | 說明 |
|------|------|
| [01-data-model.md](./01-data-model.md) | 資料模型與欄位說明 |
| [02-api-contracts.md](./02-api-contracts.md) | 新 API JSON contract 與 publish 硬限制 |
| [03-admin-ui-ia.md](./03-admin-ui-ia.md) | 後台 UI：預設人工、AI／班次可隱藏 |
| [04-phased-implementation.md](./04-phased-implementation.md) | MVP-A／B 階段 |
| [05-shift-one-click.md](./05-shift-one-click.md) | 班次制一鍵排程規則（與 AI 同一 flag／Plan／publish） |
| [database/](./database/) | 051～055 forward SQL |
