# AI 自動派單 — API Contracts

> 所有下列路由僅在 `DELIVERY_PLANNING_ENABLED=true` 時可用；否則 `404`。  
> 權限：`admin` 或 `dispatcher` JWT（與現有派單頁一致）。  
> **不信任** LLM 回傳的 ID／數值；後端一律以 DB 重查驗證。

既有派單 API（`POST /api/delivery-assignments`、`POST /api/orders/batch-assign` 等）**不在本文件變更範圍**。

---

## 0. 共用型別

```ts
type IdString = string; // BigInt 對外字串

type PlanStatus = "draft" | "pending_review" | "published" | "cancelled";
type PlanMode = "shift_one_click" | "suggest_driver" | "full_route";

type UnassignedReasonCode =
  | "NO_GEOCODE"
  | "NO_CAPACITY"
  | "NO_DRIVER"
  | "DEFER_NEXT_SHIFT"
  | "TIME_WINDOW"
  | "WORK_HOURS"
  | "LOCKED_ASSIGNMENT"
  | "CREDIT_LOCK"
  | "OTHER";
```

錯誤回應沿用現有 API 風格（例如 `{ error: string, details?: unknown }`）。

---

## 1. `POST /api/ai/parse-delivery-constraints`

將備註／偏好文字轉成結構化條件（**不寫入正式派單**）。

### Request

```json
{
  "salesOrderId": "123",
  "noteText": "上午十點前送到，週三管理員下午不在，送達前先打電話。",
  "persist": false
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `salesOrderId` | 建議 | 有則後端載入訂單日／既有欄位交叉驗證 |
| `noteText` | 是 | 來源可為地址 notes + 訂單 remark |
| `persist` | 否 | `true` 時僅寫入訂單可空時窗欄位草稿建議，**仍不派單**；預設 false |

### Response `200`

```json
{
  "requiredTimeWindow": { "start": "08:00", "end": "10:00" },
  "preferredTimeWindow": null,
  "unavailableWindows": [
    { "weekday": 3, "start": "12:00", "end": "18:00" }
  ],
  "callBeforeMinutes": 30,
  "serviceDurationMinutes": null,
  "allowEarlyDelivery": false,
  "allowLateDelivery": false,
  "timeWindowPriority": "required",
  "confidence": 0.94,
  "requiresReview": false,
  "rawModelMeta": {
    "modelVersion": "gpt-5-...",
    "promptVersion": "constraints-v1"
  }
}
```

後端必須：

1. Structured outputs 限制 schema  
2. 寫入 `delivery_planning_audit_logs`（`action=parse_constraints`）  
3. 若 `confidence < 門檻` 或 `requiresReview`，UI 標示人工確認  

---

## 2. `POST /api/delivery-plans/optimize`

產生該日該班**最新一份未發布草稿**。若已有 `draft`／`pending_review`，先刪除（含路線／站點）再寫入新稿；已 `published` 的方案保留。`version` 僅對剩餘方案遞增，UI 不展示版本號。

### Request

```json
{
  "planDate": "2026-08-11",
  "shift": "pm",
  "mode": "shift_one_click",
  "driverIds": ["1", "2"]
}
```

相容舊模式：

```json
{
  "planDate": "2026-08-08",
  "mode": "suggest_driver",
  "salesOrderIds": ["101", "102"],
  "driverIds": ["1", "2"],
  "weightProfileKey": "weights.v1"
}
```

| 欄位 | 說明 |
|------|------|
| `mode` | 預設 `shift_one_click`；亦可 `suggest_driver`；MVP-B：`full_route` |
| `shift` | `shift_one_click` 必填：`am` 或 `pm` |
| `salesOrderIds` | 僅 `suggest_driver`；省略則取該日未派佇列 |
| `driverIds` | 省略則取該日該班 `driver_attendance.is_on_duty=1`（`shift` 為 am/pm 或 all） |
| `zoneId` | `shift_one_click` 可選：地區 id／`all`／`none` |
| `salesOrderIds` | `shift_one_click` 可選：只排這些未分配單 |
| `driverZones` | `shift_one_click` 可選：`{ [driverId]: zoneId[] }` 本班主跑區，優先派同區單 |

看板：`GET /api/delivery-plans/shift-board?planDate=&shift=&zoneId=` 回傳該地區未分配＋當日已分配訂單，並附 `summary`（截單、必送未排、必送缺座標、司機超載、分區統計、每位司機本班已派／草稿／熟悉區）。
| `includeAlreadyAssigned` | 預設 false |

### Response `200`

```json
{
  "plan": {
    "id": "9001",
    "planDate": "2026-08-08",
    "version": 3,
    "status": "draft",
    "mode": "suggest_driver",
    "algorithmVersion": "rules-v1",
    "totalDistanceMeters": null,
    "totalDriveMinutes": null,
    "unassignedCount": 1
  },
  "routes": [
    {
      "id": "501",
      "driverId": "1",
      "vehicleId": "10",
      "totalBarrelQty": 42,
      "stops": [
        {
          "id": "801",
          "salesOrderId": "101",
          "stopSequence": 1,
          "etaAt": null,
          "aiExplanation": null,
          "hasHardViolation": false
        }
      ]
    }
  ],
  "unassigned": [
    {
      "salesOrderId": "102",
      "reasonCode": "NO_GEOCODE",
      "reasonText": "地址尚未確認座標，不可自動正式派單"
    }
  ]
}
```

`suggest_driver` 時：`stopSequence` 可暫以建議順序或 1..n 佔位；`etaAt` 可為 null。  
`full_route` 時：必須填 ETA／距離／行車分鐘（引擎輸出經後端驗證後寫入）。

---

## 3. `GET /api/delivery-plans/:id`

回傳單一方案完整內容（同上 `plan` + `routes` + `unassigned`）。

查詢參數（可選）：`?includeExplanations=true`

---

## 4. `PATCH /api/delivery-plans/:id/stops`

僅允許 `status in (draft, pending_review)`。只改草稿，不碰正式 assignment。

### Request

```json
{
  "moves": [
    {
      "salesOrderId": "101",
      "toDriverId": "2",
      "toSequence": 3,
      "manualAdjustReason": "客戶指定熟識司機"
    }
  ],
  "recomputeEta": true
}
```

後端重算該受影響路線的 sequence（必要時 ETA）；記錄 audit。

---

## 5. `POST /api/delivery-plans/:id/reoptimize`

對現有 plan 再跑引擎（可固定已拖曳／已鎖站點）。

### Request

```json
{
  "lockStopIds": ["801"],
  "mode": "full_route"
}
```

同日同班只保留**一份未發布草稿**：先刪舊 `draft`／`pending_review`，再寫入新稿。已發布方案不刪。

---

## 6. `POST /api/delivery-plans/:id/publish`

將草稿轉為正式 `DeliveryAssignment`。**唯一正式寫入口橋接。**

### 行為（固定）

1. Flag 與權限檢查  
2. Plan 必須為 `draft` 或 `pending_review`  
3. **硬限制逐站驗證**（見 §8）；失敗的站點不建立 assignment  
4. 對通過的站點呼叫與現有派單**行為等價**的 `createDeliveryAssignment(...)`（內部重用，非複製規則）  
5. 語意對齊 `batch-assign`：**逐筆** `succeeded` / `skipped`，不因單筆失敗回滾已成功筆  
6. 成功筆寫入 `route_sequence`、`route_stop_id`（可空關聯）、可選 `estimatedDeliveryAt` / `estimatedDeliverySlot`  
7. Plan → `published`（若有 skipped，仍可 published，並在回應列出）；audit `action=publish`

### Request

```json
{
  "assignmentDate": "2026-08-08",
  "onlyStopIds": null
}
```

### Response `200`

```json
{
  "planId": "9001",
  "status": "published",
  "succeeded": [
    { "salesOrderId": "101", "assignmentId": "7001", "driverId": "1" }
  ],
  "skipped": [
    {
      "salesOrderId": "102",
      "reason": "already has active assignment"
    }
  ]
}
```

### 硬限制（publish 前，缺一不可派該站）

| 檢查 | 說明 |
|------|------|
| 司機當日出勤 | `driver_attendance.is_on_duty`（該班 `am`/`pm` 優先，其次 `all`） |
| 車輛可用 | 若有 vehicle：`is_active` |
| 配送日 | 與 plan／order 日期一致 |
| 容量 | 不超過司機 `max_order_count` / `max_barrel_qty`（含當日已派） |
| 強制時窗 | `time_window_priority=required` 時 ETA 必須落入窗（`full_route`）；`suggest_driver` 至少做可行性粗檢 |
| 工時 | 不超出司機當日工時 |
| 座標 | `geocode_status in ('ok','manual_confirmed')` |
| 必送缺座標 | 方案相關必送單缺座標 → **整批不可發布** |
| 截單 | 已過 `shift.am.cutoff`／`shift.pm.cutoff` → **不可 optimize／publish** |
| 鎖定 | 已有進行中 assignment、或配送中任務不可改派 |
| 既有業務 | 信用鎖、訂單狀態等與現有 assign API 相同 |

人工派單 API **第一版不套用**容量硬擋（避免改變現況）。

---

## 7. `POST /api/delivery-plans/:id/cancel`

```json
{ "reason": "改人工派單" }
```

僅取消草稿／待確認方案；**不刪除**已因 publish 產生的 assignment。

---

## 8. `GET /api/delivery-plans/:id/explanations`

回傳各 stop 的 `aiExplanation`；若尚未產生，可同步觸發 LLM 說明（寫入 stop + audit）。Payload 最小化個資。

---

## 9. 輔助 API（MVP-A 建議）

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/delivery-addresses/:id/geocode` | 觸發 geocode；ambiguous 不自動正式用。**客戶主檔亦用，不依賴 planning flag** |
| `PATCH` | `/api/delivery-addresses/:id/location` | 人工確認 lat/lng → `manual_confirmed`。**客戶主檔亦用，不依賴 planning flag** |
| `PUT` | `/api/drivers/:id/attendance` | upsert 該日該班出勤（`shift`: `am`｜`pm`｜`all`，可帶 `runZoneIds`） |
| `GET` | `/api/drivers/attendance?workDate=&shift=` | 出勤班表 roster（上班／請假＋本班跑區 `runZoneIds`） |
| `GET` | `/api/delivery-plans?planDate=` | 列出當日方案版本 |
| `GET` | `/api/delivery-planning/settings` | 讀取規劃設定（SLA＋截單 `shift.am.cutoff`／`shift.pm.cutoff`） |
| `PUT` | `/api/delivery-planning/settings` | 覆寫：`{ "settings": { "sla.general_shifts": "4", "sla.after_scheduled_shifts": "", "patrol.early_shifts": "1", "patrol.late_shifts": "1", "shift.am.cutoff": "15:00", "shift.pm.cutoff": "10:00" } }` |

地圖 matrix／OR-Tools 為內部 adapter，不直接暴露給前端。

---

## 10. 明確不新增的寫入行為

- 禁止 `POST /api/ai/assign` 一類直接派單捷徑  
- 禁止前端帶 OpenAI key  
- 禁止 publish 繞過信用鎖／進行中 assignment 檢查  

---

## 11. 模組掛載（實作提示）

```text
apps/api/src/modules/delivery-planning/
  routes.ts          # 掛到 index.ts：if (env.flag) app.use(...)
  parseConstraints.ts
  optimize.ts
  publish.ts         # → shared createDeliveryAssignment
  geocoding/
  optimizer/         # adapter；MVP-A 可為 rules engine
  audit.ts
```

`index.ts` **只掛載 router**，避免複製巨型派單邏輯。
