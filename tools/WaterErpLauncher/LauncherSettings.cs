using System.Text.Json;

namespace WaterErpLauncher;

internal sealed class LauncherSettings
{
    public string ProjectRoot { get; set; } = "";
    public string NginxRoot { get; set; } = @"C:\nginx-1.31.2";
    public string MySqlServiceName { get; set; } = "MySQL80";
    public string ApiBaseUrl { get; set; } = "http://125.228.16.160";
    public string AdminUrl { get; set; } = "http://125.228.16.160/";
    public string DriverUrl { get; set; } = "http://125.228.16.160/driver/";
    public string LiffUrl { get; set; } = "http://125.228.16.160/liff/";
    public string GitBranch { get; set; } = "main";

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
