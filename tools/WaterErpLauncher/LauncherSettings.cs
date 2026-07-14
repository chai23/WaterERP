using System.Text.Json;

namespace WaterErpLauncher;

internal sealed class LauncherSettings
{
    public string ProjectRoot { get; set; } = "";
    public string NginxRoot { get; set; } = @"C:\nginx-1.31.2";
    public string ApiBaseUrl { get; set; } = "http://125.228.16.160";
    public string AdminUrl { get; set; } = "http://125.228.16.160/";
    public string DriverUrl { get; set; } = "http://125.228.16.160/driver/";
    public string LiffUrl { get; set; } = "http://125.228.16.160/liff/";
    public string GitBranch { get; set; } = "main";

    /// <summary>正式部署：啟動 Nginx，前端走 build 後的靜態檔。</summary>
    public bool UseProductionMode { get; set; } = true;

    /// <summary>開發模式：啟動 API 時是否一併執行 npm run dev:admin。</summary>
    public bool StartAdminDevWithApi { get; set; } = false;

    /// <summary>開發模式：啟動 API 時是否一併執行 npm run dev:driver。</summary>
    public bool StartDriverDevWithApi { get; set; } = false;

    /// <summary>開發模式：啟動 API 時是否一併執行 npm run dev:liff（LINE 訂水）。</summary>
    public bool StartLiffDevWithApi { get; set; } = false;

    /// <summary>ngrok 固定免費網域（不含 https://）。</summary>
    public string NgrokDomain { get; set; } = NgrokHelper.DefaultDomain;

    /// <summary>正式模式啟動服務時是否一併開啟 ngrok HTTPS 隧道（LINE 測試用）。</summary>
    public bool StartNgrokWithServices { get; set; } = false;

    private static string SettingsPath =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WaterErpLauncher",
            "settings.json");

    public static LauncherSettings Load()
    {
        try
        {
            if (!File.Exists(SettingsPath))
                return new LauncherSettings();
            var json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<LauncherSettings>(json) ?? new LauncherSettings();
        }
        catch
        {
            return new LauncherSettings();
        }
    }

    public void Save()
    {
        var dir = Path.GetDirectoryName(SettingsPath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(SettingsPath, json);
    }
}
