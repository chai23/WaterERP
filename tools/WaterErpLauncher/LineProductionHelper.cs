using System.Text.RegularExpressions;

namespace WaterErpLauncher;

internal sealed class LineProductionCheckResult
{
    public List<string> Errors { get; } = new();
    public List<string> Warnings { get; } = new();

    public bool Ok => Errors.Count == 0;

    public string FormatMessage()
    {
        var sb = new System.Text.StringBuilder();
        if (Errors.Count > 0)
        {
            sb.AppendLine("【必須修正】");
            foreach (var e in Errors)
                sb.AppendLine("・" + e);
            sb.AppendLine();
        }
        if (Warnings.Count > 0)
        {
            sb.AppendLine("【建議注意】");
            foreach (var w in Warnings)
                sb.AppendLine("・" + w);
        }
        if (Ok && Warnings.Count == 0)
            sb.AppendLine("LINE 訂水正式設定檢查通過。");
        return sb.ToString().TrimEnd();
    }
}

/// <summary>
/// 正式部署 LINE LIFF 訂水前的環境檢查（.env / 建置產物 / URL）。
/// </summary>
internal static class LineProductionHelper
{
    private static readonly Regex EnvLine = new(
        @"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$",
        RegexOptions.Compiled);

    public static Dictionary<string, string> ParseEnvFile(string path)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path))
            return map;

        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
                continue;
            var m = EnvLine.Match(line);
            if (!m.Success)
                continue;
            var key = m.Groups[1].Value;
            var value = m.Groups[2].Value.Trim();
            if (value.Length >= 2)
            {
                var q = value[0];
                if ((q == '"' || q == '\'') && value[^1] == q)
                    value = value[1..^1];
            }
            map[key] = value;
        }
        return map;
    }

    private static bool IsTruthy(string? v) =>
        string.Equals(v, "1", StringComparison.OrdinalIgnoreCase)
        || string.Equals(v, "true", StringComparison.OrdinalIgnoreCase)
        || string.Equals(v, "yes", StringComparison.OrdinalIgnoreCase);

    private static bool HasNonEmpty(Dictionary<string, string> env, string key) =>
        env.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v);

    /// <param name="requireBuiltDist">啟動服務時為 true；僅檢查設定／建置前為 false。</param>
    public static LineProductionCheckResult Check(string projectRoot, string liffUrl, bool requireBuiltDist)
    {
        var result = new LineProductionCheckResult();
        if (string.IsNullOrWhiteSpace(projectRoot) || !Directory.Exists(projectRoot))
        {
            result.Errors.Add("專案根目錄無效。");
            return result;
        }

        var apiEnvPath = Path.Combine(projectRoot, "apps", "api", ".env");
        var liffEnvPath = Path.Combine(projectRoot, "apps", "web-liff", ".env");
        var liffEnvExample = Path.Combine(projectRoot, "apps", "web-liff", ".env.example");
        var liffDist = Path.Combine(projectRoot, "apps", "web-liff", "dist", "index.html");

        if (!File.Exists(apiEnvPath))
        {
            result.Errors.Add("找不到 apps\\api\\.env。");
        }
        else
        {
            var api = ParseEnvFile(apiEnvPath);
            if (!HasNonEmpty(api, "LINE_CHANNEL_ACCESS_TOKEN"))
                result.Errors.Add("apps\\api\\.env 未設定 LINE_CHANNEL_ACCESS_TOKEN（Messaging API Channel access token）。");
            if (!HasNonEmpty(api, "LINE_CHANNEL_SECRET"))
                result.Errors.Add("apps\\api\\.env 未設定 LINE_CHANNEL_SECRET（Webhook 簽章驗證）。");
            if (!HasNonEmpty(api, "LINE_LOGIN_CHANNEL_ID") && !HasNonEmpty(api, "LINE_CHANNEL_ID"))
                result.Errors.Add("apps\\api\\.env 未設定 LINE_LOGIN_CHANNEL_ID（LIFF Login Channel ID）。");

            if (IsTruthy(api.GetValueOrDefault("LIFF_DEV_BYPASS")))
                result.Errors.Add("正式環境請關閉 LIFF_DEV_BYPASS（刪除或改為 0）。");
            if (IsTruthy(api.GetValueOrDefault("LINE_OTP_DEV_MODE")))
                result.Errors.Add("正式環境請關閉 LINE_OTP_DEV_MODE（OTP 應走 LINE 推播，勿回傳開發用驗證碼）。");
            if (IsTruthy(api.GetValueOrDefault("LINE_OTP_SKIP")))
                result.Warnings.Add("已開啟 LINE_OTP_SKIP（略過手機驗證碼）。僅供測試，正式上線請關閉。");
        }

        if (!File.Exists(liffEnvPath))
        {
            result.Errors.Add(
                "找不到 apps\\web-liff\\.env。請複製 .env.example 後填入 VITE_LIFF_ID（建置時會寫入靜態檔，改完必須重新建置）。");
            if (File.Exists(liffEnvExample))
                result.Warnings.Add("範本：apps\\web-liff\\.env.example");
        }
        else
        {
            var liff = ParseEnvFile(liffEnvPath);
            if (!HasNonEmpty(liff, "VITE_LIFF_ID"))
                result.Errors.Add("apps\\web-liff\\.env 未設定 VITE_LIFF_ID（LINE Developers → LIFF → LIFF app ID）。");
            if (IsTruthy(liff.GetValueOrDefault("VITE_LIFF_DEV_BYPASS")))
                result.Errors.Add("正式環境請關閉 VITE_LIFF_DEV_BYPASS（刪除或改為 0），否則會跳過真正的 LINE Login。");
        }

        if (requireBuiltDist && !File.Exists(liffDist))
            result.Errors.Add("尚未建置 LIFF 靜態檔（apps\\web-liff\\dist）。請先按「建置專案」。");

        var url = (liffUrl ?? "").Trim();
        if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            result.Warnings.Add(
                "LIFF 網址目前為 HTTP。LINE 官方 LIFF Endpoint 實務上通常需要 HTTPS；若 Console 無法驗證，請改用網域 + SSL，或確認 LINE 開發者設定允許目前網址。");
        }

        if (!string.IsNullOrEmpty(url) && !url.Contains("/liff", StringComparison.OrdinalIgnoreCase))
            result.Warnings.Add("LIFF 訂水網址建議以 /liff/ 結尾（與 Nginx 設定一致）。");

        return result;
    }
}
