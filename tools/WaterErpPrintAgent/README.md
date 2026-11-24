# WaterERP 點陣套印助手

在接有點陣機且已安裝驅動程式的 Windows 電腦上，確認有 .NET 8 Desktop Runtime 和 Microsoft Edge WebView2 Runtime。從專案根目錄建置後，開啟輸出資料夾內的 `WaterErpPrintAgent.exe`。

```powershell
dotnet build tools/WaterErpPrintAgent -c Release
```

執行檔與相依檔案在 `tools/WaterErpPrintAgent/bin/Release/net8.0-windows`。若要移到開單電腦，請一起複製整個資料夾。

## 正式訂單套印

1. 部署新版 WaterERP API 與後台，並在目標資料庫執行 `npm run db:schema-apply` 套用佇列資料表。
2. 開啟助手，填入 ERP 根網址並選好 Windows 點陣印表機。遠端 ERP 使用 HTTPS，本機可用 `http://localhost:3000`。
3. 點助手的「複製配對碼」。在開單瀏覽器的「訂單列印版面」貼上配對碼，按「儲存列印方式」，再在助手按「啟用接單」。
4. 助手開啟時，從訂單查詢或訂單詳情點「套印」。如有開啟「建立訂單後自動列印」，開單成功後也會送到相同印表機。
5. 要切回瀏覽器列印，在「訂單列印版面」清空配對碼並儲存。若畫面顯示送印結果待確認，先檢查實際出紙和 Windows 列印佇列，再決定是否補印。

## 使用假單試印

1. 到 WaterERP「訂單列印版面」，用「下載列印助手測試檔」匯出目前畫面上的版面與假訂單。
2. 在助手開啟測試檔，確認顯示的紙張尺寸與實際連續紙相符。在 Windows 驅動程式選用對應紙型與走紙方式。
3. 在助手選擇點陣機，先送印 1 份確認中文、條碼和格線位置，再送印 20 份比對首張與末張，檢查有無多走紙或累積偏移。
4. 「已送至印表機」代表送印 API 回報成功。請在現場確認實際出紙。
