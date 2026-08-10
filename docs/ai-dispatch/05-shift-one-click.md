# 班次制一鍵排程

與既有 AI 派單**同一套系統**（同一 flag `DELIVERY_PLANNING_ENABLED`、同一 `DeliveryPlan`、同一 publish → `DeliveryAssignment`）。  
ChatGPT 只負責備註理解／解釋；**進哪一班、派給誰由規則引擎決定**。

人工派單（`POST /api/delivery-assignments`、`batch-assign`）、核銷、司機端**零行為變更**。關 flag 後不顯示班次分頁。

---

## 調度 SOP

| 時機 | 一鍵目標 |
|------|----------|
| 上午排程 | **今天下午**（`planDate=今天`, `shift=pm`） |
| 下午排程 | **明天上午**（週日跳過；`shift=am`） |

每位司機每班最多一趟。請假司機該班 `driver_attendance.is_on_duty=false`，不進入可用名單。  
分區**不綁死**司機；分區只做路線骨架與熟悉度加分。  
**未分區但已確認座標**：用直線距離併入「已排站點最近」的司機（約 0.5km 內等同同區加分；超過約 4km 則略扣分）。不是路網車程；完整地圖／OR-Tools 仍屬 MVP-B。

預設工時（`delivery_planning_settings`，班次排程「排程規則」可改，不寫死程式）：

| 班別 | 配送 | 排程時機 | 截單（可調） |
|------|------|----------|------|
| 上午 `am` | 08:00–12:00 | 前一日下午 | 前日 `shift.am.cutoff`（預設 15:00） |
| 下午 `pm` | 13:00–17:30 | 當日上午 | 當日 `shift.pm.cutoff`（預設 10:00） |

營業班次：週一–六每日 am／pm；**週日不算班**。

---

## SLA 與訂單種類

設定鍵在 `delivery_planning_settings`，班次排程頁可改；引擎與開單都讀同一套。

| 種類 `order_kind` | 最晚應送 | 最早可送 |
|-------------------|----------|----------|
| `general` | 成立當下所屬班次起算 **`sla.general_shifts` 個營業班**（預設 4） | 無（或開單指定） |
| `general`（有預定日） | 可另加 **`sla.after_scheduled_shifts`**：預定日 pm 再 +N 班內必送；**留空＝不另用預定日**；**0＝過了預定日當天就必送** | — |
| `patrol` | 到期日後 **`patrol.late_shifts` 班**（預設 1） | 到期日前 **`patrol.early_shifts` 班**（預設 1） |
| `replenishment` / `emergency` | 當班必送 | — |

巡單 `preferred_shift=any`。已過 latest 的巡單＝**逾期必送**，不可自動延後。

開單時自動寫入：一般單填 `latest_date` + `latest_shift`；巡單產生（`generate-patrol` 或備註 `【週期巡查】`）寫 `order_kind=patrol` 與 ±N 班視窗。

---

## 進班優先（分層，非單一總分）

1. **必送**：`dispatch_locked`／`dispatch_priority=must|urgent`／補送／緊急／指定本班／逾期（含逾期巡單）
2. **到期巡單**（`scheduled_delivery_date`＝本班日期）
3. **延後 N 班內**的巡單（`patrol.late_shifts`）
4. **一般單**：`latest_shift` 升冪 → 成立時間升冪；優先插入與巡單同 `AddressZone` 的路線
5. **可提前 N 班**的未來巡單（`patrol.early_shifts`，有容量才進）

容量不足時自動延後順序：

1. 可提前巡單  
2. 未到 latest 的新一般單  
3. 未到 latest 的舊一般單  

**必送不可自動延後。** 未排入列出 `reason_code`（如 `DEFER_NEXT_SHIFT`、`NO_GEOCODE`、`NO_CAPACITY`）與建議下一班。

第一版工時粗估：預設服務分鐘 + 每桶 + 每樓層 + 同區站間約 8～12 分鐘。未分區單用經緯度直線就近併入，**尚未做真實路網**。MVP-B 再換成矩陣／OR-Tools，**不改進班優先規則**。

---

## 一鍵 API

`POST /api/delivery-plans/optimize`（flag 開、`admin`／`dispatcher`）

```json
{
  "planDate": "2026-08-11",
  "shift": "pm",
  "mode": "shift_one_click",
  "driverIds": ["1"],
  "zoneId": "3",
  "salesOrderIds": ["101", "102"]
}
```

- `GET /api/delivery-plans/shift-board?planDate=&shift=&zoneId=all|none|<id>`：列出該地區未分配＋當日已分配訂單
- `zoneId`：`all`＝全部、`none`＝未分區、或地區 id
- `salesOrderIds`：只排勾選的未分配單；省略則依地區／班次規則全抓
- 省略 `driverIds`：取該日該班 `driver_attendance.is_on_duty=true`
- 出勤 API：`PUT /api/drivers/:id/attendance` 現需帶 `shift`（`am`｜`pm`｜`all`）
- 草稿確認後 `POST /api/delivery-plans/:id/publish` → `createDeliveryAssignment`（寫入 `assignment_shift`）
- **同日同班只留最新未發布草稿**：再按「一鍵排該班」會刪舊 `draft`／`pending_review` 再建新稿；已發布方案保留
- 舊模式 `mode=suggest_driver` 仍可用

UI：日期 → 班別 → **出勤班表（上班／請假，指定本班跑哪個區）** → 篩選訂單 → 一鍵排該班（不再另選地區）。  
本班總覽顯示：截單、必送未排、必送缺座標、司機超載。  
**本班司機 × 區域**：已派／草稿分區，以及每位司機本班主跑區（寫入該日該班出勤，換日期再回來仍在；一鍵排程會優先往那些區塞；未指定則只依熟悉區加分）。  
已過截單或必送缺座標時，**不可排程／發布**（後端硬擋）。
