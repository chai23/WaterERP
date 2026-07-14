using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace WaterErpLauncher;

internal sealed class NgrokTunnelStatus
{
    public bool Running { get; init; }
    public string? PublicUrl { get; init; }
    public string? Error { get; init; }
}

/// <summary>
/// LINE 測試用暫用 HTTPS 隧道（ngrok）：啟動／停止／查詢公開網址。
/// </summary>
internal static class NgrokHelper
{
    public const string DefaultDomain = "gawk-luckiness-freeing.ngrok-free.dev";
    public const string LocalApiBase = "http://127.0.0.1:4040";

    public static string? FindNgrokExe(string projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
            return null;
        var candidate = Path.Combine(projectRoot.Trim(), "tools", "ngrok", "ngrok.exe");
        return File.Exists(candidate) ? candidate : null;
    }

    public static string NormalizeDomain(string? raw)
    {
        var s = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(s))
            return DefaultDomain;
        s = s.Replace("https://", "", StringComparison.OrdinalIgnoreCase)
            .Replace("http://", "", StringComparison.OrdinalIgnoreCase)
            .Trim().TrimEnd('/');
        return string.IsNullOrEmpty(s) ? DefaultDomain : s;
    }

    public static string PublicHttpsUrl(string domain) =>
        "https://" + NormalizeDomain(domain);

    public static bool IsNgrokProcessRunning()
    {
        try
        {
            return Process.GetProcessesByName("ngrok").Length > 0;
        }
        catch
        {
            return false;
        }
    }

    public static int ForceStopAll(Action<string>? log = null)
    {
        var killed = 0;
        foreach (var proc in Process.GetProcessesByName("ngrok"))
        {
            try
            {
                log?.Invoke($"停止 ngrok PID {proc.Id}…");
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(8000);
                killed++;
            }
            catch (Exception ex)
            {
                log?.Invoke($"無法停止 ngrok PID {proc.Id}：{ex.Message}");
            }
            finally
            {
                try { proc.Dispose(); } catch { /* ignore */ }
            }
        }
        return killed;
    }

    /// <summary>啟動 ngrok http &lt;localPort&gt;，可選固定免費網域。</summary>
    public static Process Start(string ngrokExe, int localPort, string? domain, Action<string>? log = null)
    {
        ForceStopAll(log);

        var args = string.IsNullOrWhiteSpace(domain)
            ? $"http {localPort}"
            : $"http {localPort} --url={NormalizeDomain(domain)}";

        var psi = new ProcessStartInfo
        {
            FileName = ngrokExe,
            Arguments = args,
            WorkingDirectory = Path.GetDirectoryName(ngrokExe)!,
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            CreateNoWindow = true
        };

        var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        if (!proc.Start())
            throw new InvalidOperationException("無法啟動 ngrok 行程。");

        log?.Invoke($"已啟動 ngrok：{ngrokExe} {args}");
        return proc;
    }

    public static async Task<NgrokTunnelStatus> QueryStatusAsync(HttpClient http, CancellationToken ct = default)
    {
        if (!IsNgrokProcessRunning())
            return new NgrokTunnelStatus { Running = false };

        try
        {
            using var resp = await http.GetAsync(new Uri(LocalApiBase + "/api/tunnels"), ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                return new NgrokTunnelStatus
                {
                    Running = true,
                    Error = $"儀表板回應 {(int)resp.StatusCode}"
                };
            }

            await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            string? https = null;
            string? any = null;
            if (doc.RootElement.TryGetProperty("tunnels", out var tunnels) && tunnels.ValueKind == JsonValueKind.Array)
            {
                foreach (var t in tunnels.EnumerateArray())
                {
                    if (!t.TryGetProperty("public_url", out var urlProp))
                        continue;
                    var url = urlProp.GetString();
                    if (string.IsNullOrWhiteSpace(url))
                        continue;
                    any ??= url;
                    if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        https = url;
                        break;
                    }
                }
            }

            var publicUrl = https ?? any;
            return new NgrokTunnelStatus
            {
                Running = true,
                PublicUrl = publicUrl,
                Error = publicUrl is null ? "行程在跑，但尚未取得公開網址" : null
            };
        }
        catch (Exception ex)
        {
            return new NgrokTunnelStatus
            {
                Running = true,
                Error = "無法連線 ngrok 儀表板（" + ex.Message + "）"
            };
        }
    }

    /// <summary>啟動後輪詢直到取得公開網址或逾時。</summary>
    public static async Task<NgrokTunnelStatus> WaitForPublicUrlAsync(
        HttpClient http,
        TimeSpan timeout,
        Action<string>? log = null,
        CancellationToken ct = default)
    {
        var deadline = DateTime.UtcNow + timeout;
        NgrokTunnelStatus last = new() { Running = false };
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            last = await QueryStatusAsync(http, ct).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(last.PublicUrl))
                return last;
            await Task.Delay(400, ct).ConfigureAwait(false);
        }

        log?.Invoke(last.Error ?? "等待 ngrok 公開網址逾時。");
        return last;
    }
}
