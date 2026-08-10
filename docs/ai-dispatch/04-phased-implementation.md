# AI 自動派單 — 分階段實作

> 本次已完成：**設計文件 + SQL 草案**（本目錄）。  
> MVP-A／班次一鍵排程已落地；下列後續階段另開任務實作。

相關：

- [01-data-model.md](./01-data-model.md)
- [02-api-contracts.md](./02-api-contracts.md)
- [03-admin-ui-ia.md](./03-admin-ui-ia.md)

---

## 階段總覽

```mermaid
flowchart LR
  Design[設計_已完成]
  MvpA[MVP-A_資料與建議司機]
  MvpB[MVP-B_完整路線]
  Dyn[動態重排]
  Learn[資料學習]
  Design --> MvpA --> MvpB --> Dyn --> Learn
```

| 階段 | 預估 | 交付 |
|------|------|------|
| 設計（本次） | — | `docs/ai-dispatch/**` |
| MVP-A | 3～5 週 | 051+052+053+**054 班次／SLA**、geocode、出勤、parse、`shift_one_click`／suggest_driver |
| MVP-B | 4～7 週 | 矩陣、OR-Tools、地圖、publish 完整 ETA、司機排序 |
| 動態重排 | 3～5 週 | 插單／延誤事件、局部重算 |
| 資料學習 | 1～3 個月資料後 | 服務時間校正、權重調整 |

---

## 階段 0 — 設計（已完成驗收項）

- [x] API contract 與 publish 銜接既有 assignment  
- [x] UI IA：預設 = 人工派單  
- [x] 禁止修改端點／檔案清單  

**明確未做（設計階段）**：當時未改 `index.ts`、未改 UI、未將 SQL 放入正式 `database/migrations/`。

---

## 階段 1 — MVP-A（已實作，flag 預設關）

### 已落地

1. `database/migrations/051～055`；Prisma／`schema.sql` 已同步  
2. `DELIVERY_PLANNING_ENABLED` 預設 false；`registerDeliveryPlanningRoutes`  
3. Geocode adapter（Google 或人工確認）+ attendance API（含 `shift`）  
4. `parse-delivery-constraints`（OpenAI Responses 或 heuristic 備援）  
5. `optimize` mode=`shift_one_click`（預設）／`suggest_driver` + `publish`（重用 `createDeliveryAssignment`，寫入 `assignment_shift`）  
6. 派單頁：flag 開時顯示「班次排程」；預設人工  
7. 開單／巡單產生寫入 `order_kind` 與 SLA 班次（一般 4 班、巡單 ±1）  

### 啟用方式

```bash
# apps/api/.env
DELIVERY_PLANNING_ENABLED=true
# 選填
OPENAI_API_KEY=...
GOOGLE_MAPS_API_KEY=...
```

### 不做（仍屬後續）

- OR-Tools、距離矩陣、地圖路線（未分區直線就近併入已在 MVP-A）  
- 改人工派單 API 行為（容量硬擋僅 AI publish）  
- 改司機端  
- 自然語言調度指令  

### 通過標準（MVP-A）

- Flag 關：與導入前 UI／API 無差異  
- Flag 開：可產生建議並人工確認後 publish  
- 無座標訂單不可 publish  
- 超載不可 publish（AI 路徑）  
- OpenAI 失敗時人工派單仍可用  

---

## 階段 2 — MVP-B

### 做

1. 複製 053，建 Plan／Route／Stop  
2. 距離／時間矩陣 + 快取  
3. OR-Tools（或同等）sidecar／adapter，`mode=full_route`  
4. 後台地圖與拖曳、`PATCH stops`、`reoptimize`  
5. Publish 寫入 `route_sequence`／ETA  
6. 司機端：有 sequence 則排序 + 導航連結  

### 不做

- 塞車／跳站動態重算  
- 權重設定頁可延後（先用 `weights.v1`）  

### 通過標準（MVP-B）

- 平行測試 ≥ 20 配送日（對照人工）  
- 強制時段符合率、超載率、定位正確率等見原規劃書 KPI  
- 地圖／引擎中斷 → 人工派單仍可用  

---

## 階段 3 — 動態重排

### 做

- `POST /api/driver/route-events`（塞車、未送達、跳站）  
- 僅重算未完成站點  
- 緊急插單 `reoptimize`  
- 客戶 ETA 通知（可選）  

事件表用獨立 migration；關閉事件處理即可停用，不影響已發布派單。  

---

## 階段 4 — 資料學習

- 依歷史校正服務時間、路況、區域效率  
- 分析 AI 接受率與改派原因  
- 調整權重（設定頁）  

權重調整寫入 `weight_profile_key`／設定值即可，通常不必改表。

---

## 實作順序建議（MVP-A 任務拆解）

1. DB 051/052 + Prisma（flag 仍關，僅結構）  
2. 回歸測試人工路徑（**必過**）  
3. Geocode + 地址確認 UI  
4. Attendance API + 簡單後台  
5. Parse constraints  
6. Suggest optimize + publish  
7. OrderAssign 模式切換（預設人工）  
8. 開 flag 於測試環境平行跑  

---

## 明確不做清單（全專案護欄）

| 項目 | 原因 |
|------|------|
| ChatGPT 單獨算最短路 | 不適合作 CVRPTW |
| LLM 直接寫 assignment | 安全與稽核 |
| 第一版對人工 API enforce 容量 | 避免改變現況行為 |
| 強制歷史地址一次全定位才准派單 | 人工備援必須可用 |
| 前端持有 OpenAI／地圖秘密金鑰 | 安全 |
| 對正式庫執行整份 `schema.sql` | 含 DROP，會毀資料 |
| 清資料類 migration | 與派單無關且危險 |

---

## 程式目錄約定（實作時）

```text
apps/api/src/modules/delivery-planning/
docs/ai-dispatch/                     # 本設計包（已存在）
database/migrations/051_*.sql         # 僅在階段開始時從草案複製
```

Feature branch 建議名：`feature/ai-dispatch-planning`。
