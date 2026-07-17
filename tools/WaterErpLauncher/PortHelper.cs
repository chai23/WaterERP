using System.Diagnostics;
using System.Text.RegularExpressions;

namespace WaterErpLauncher;

internal static class PortHelper
{
    /// <summary>從 http://host:port 解析埠號；失敗則回傳預設值。</summary>
    public static int ParsePortFromUrl(string url, int defaultPort)
    {
        if (string.IsNullOrWhiteSpace(url))
            return defaultPort;
        try
        {
            if (!url.Contains("://", StringComparison.Ordinal))
                url = "http://" + url;
            var uri = new Uri(url.Trim());
            return uri.Port > 0 ? uri.Port : defaultPort;
        }
        catch
        {
            return defaultPort;
        }
    }

    public static bool IsPortListening(int port)
    {
        return GetListenerProcessIds(port).Count > 0;
    }

    /// <summary>結束佔用指定埠且程序名符合的行程樹。</summary>
    public static int ReleasePortForProcess(int port, string processName, Action<string>? log = null)
    {
        var killed = 0;
        foreach (var pid in GetListenerProcessIds(port))
        {
            if (!TryGetProcessName(pid, out var name))
                continue;
            if (!name.Equals(processName, StringComparison.OrdinalIgnoreCase))
            {
                log?.Invoke($"埠 {port} 被 PID {pid}（{name}）佔用，非 {processName}，略過自動結束。");
                continue;
            }

            try
            {
                using var p = Process.GetProcessById(pid);
                log?.Invoke($"結束佔用埠 {port} 的 {processName} 行程 PID {pid}…");
                p.Kill(entireProcessTree: true);
                p.WaitForExit(5000);
                killed++;
            }
            catch (Exception ex)
            {
                log?.Invoke($"無法結束 PID {pid}：{ex.Message}");
            }
        }

        if (killed > 0)
            Thread.Sleep(400);

        return killed;
    }

    /// <summary>結束佔用指定埠且程序名為 node 的 API 行程樹。</summary>
    public static int ReleasePortForNode(int port, Action<string>? log = null) =>
        ReleasePortForProcess(port, "node", log);

    /// <summary>結束佔用指定埠且程序名為 nginx 的行程樹。</summary>
    public static int ReleasePortForNginx(int port, Action<string>? log = null) =>
        ReleasePortForProcess(port, "nginx", log);

    public static bool IsPortUsedByProcess(int port, string processName)
    {
        foreach (var pid in GetListenerProcessIds(port))
        {
            if (TryGetProcessName(pid, out var name) && name.Equals(processName, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    /// <summary>強制結束所有 nginx.exe（pid 檔遺失時的後援手段）。</summary>
    public static int ForceStopAllNginx(Action<string>? log = null)
    {
        var killed = 0;
        foreach (var proc in Process.GetProcessesByName("nginx"))
        {
            try
            {
                log?.Invoke($"強制結束 nginx PID {proc.Id}…");
                proc.Kill(entireProcessTree: true);
                proc.WaitForExit(5000);
                killed++;
            }
            catch (Exception ex)
            {
                log?.Invoke($"無法結束 nginx PID {proc.Id}：{ex.Message}");
            }
            finally
            {
                proc.Dispose();
            }
        }

        if (killed > 0)
            Thread.Sleep(500);

        return killed;
    }

    public static List<int> GetListenerProcessIds(int port)
    {
        var pids = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netstat",
                Arguments = "-ano",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8
            };
            using var proc = Process.Start(psi);
            if (proc is null)
                return [];
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);

            // TCP    0.0.0.0:3000    ...    LISTENING    12345
            var portToken = ":" + port;
            foreach (var line in output.Split('\n', '\r'))
            {
                if (!line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (!line.Contains(portToken, StringComparison.Ordinal))
                    continue;

                var m = Regex.Match(line.Trim(), @"LISTENING\s+(\d+)\s*$", RegexOptions.IgnoreCase);
                if (m.Success && int.TryParse(m.Groups[1].Value, out var pid) && pid > 0)
                    pids.Add(pid);
            }
        }
        catch
        {
            // fallback: try connect to see if in use only
        }

        return pids.ToList();
    }

    private static bool TryGetProcessName(int pid, out string name)
    {
        name = "";
        try
        {
            using var p = Process.GetProcessById(pid);
            name = p.ProcessName;
            return true;
        }
        catch
        {
            return false;
        }
    }
}
