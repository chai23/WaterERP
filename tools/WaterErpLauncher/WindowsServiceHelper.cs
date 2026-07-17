using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace WaterErpLauncher;

internal sealed record WindowsServiceResult(
    bool Success,
    string State,
    string Output,
    bool AccessDenied = false);

/// <summary>
/// 使用 Windows 內建 sc.exe 管理服務，避免啟動器額外安裝執行階段元件。
/// </summary>
internal static partial class WindowsServiceHelper
{
    private static readonly Regex StatePattern = StateRegex();

    public static async Task<WindowsServiceResult> QueryAsync(string serviceName) =>
        await RunScAsync($"query \"{NormalizeName(serviceName)}\"").ConfigureAwait(false);

    public static async Task<WindowsServiceResult> StartAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var current = await QueryAsync(serviceName).ConfigureAwait(false);
        if (current.State == "RUNNING")
            return current with { Success = true };
        var command = await RunScAsync($"start \"{NormalizeName(serviceName)}\"").ConfigureAwait(false);
        if (!command.Success && command.State != "RUNNING")
            return command;
        return await WaitForStateAsync(serviceName, "RUNNING", timeout, cancellationToken).ConfigureAwait(false);
    }

    public static async Task<WindowsServiceResult> StopAsync(
        string serviceName,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var current = await QueryAsync(serviceName).ConfigureAwait(false);
        if (current.State == "STOPPED")
            return current with { Success = true };
        var command = await RunScAsync($"stop \"{NormalizeName(serviceName)}\"").ConfigureAwait(false);
        if (!command.Success && command.State != "STOPPED")
            return command;
        return await WaitForStateAsync(serviceName, "STOPPED", timeout, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<WindowsServiceResult> WaitForStateAsync(
        string serviceName,
        string target,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow + timeout;
        WindowsServiceResult latest = new(false, "UNKNOWN", "");
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            latest = await QueryAsync(serviceName).ConfigureAwait(false);
            if (latest.State == target)
                return latest with { Success = true };
            await Task.Delay(500, cancellationToken).ConfigureAwait(false);
        }
        return latest with
        {
            Success = false,
            Output = $"等待服務進入 {target} 狀態逾時。\n{latest.Output}"
        };
    }

    private static async Task<WindowsServiceResult> RunScAsync(string arguments)
    {
        if (!OperatingSystem.IsWindows())
            return new(false, "UNAVAILABLE", "Windows Service 僅能在 Windows 上管理。");

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.Default,
                StandardErrorEncoding = Encoding.Default
            };
            using var process = Process.Start(startInfo);
            if (process is null)
                return new(false, "UNKNOWN", "無法啟動 sc.exe。");

            var stdout = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
            var stderr = await process.StandardError.ReadToEndAsync().ConfigureAwait(false);
            await process.WaitForExitAsync().ConfigureAwait(false);

            var output = (stdout + Environment.NewLine + stderr).Trim();
            var state = ParseState(output);
            var denied = output.Contains("Access is denied", StringComparison.OrdinalIgnoreCase)
                || output.Contains("拒絕存取", StringComparison.OrdinalIgnoreCase)
                || output.Contains("FAILED 5", StringComparison.OrdinalIgnoreCase);
            var success = process.ExitCode == 0 || state is "RUNNING" or "STOPPED";
            return new(success, state, output, denied);
        }
        catch (Exception ex)
        {
            return new(false, "UNKNOWN", ex.Message);
        }
    }

    private static string ParseState(string output)
    {
        var match = StatePattern.Match(output);
        if (!match.Success)
            return "UNKNOWN";
        if (match.Groups[2].Success)
            return match.Groups[2].Value.ToUpperInvariant();
        return match.Groups[1].Value switch
        {
            "1" => "STOPPED",
            "2" => "START_PENDING",
            "3" => "STOP_PENDING",
            "4" => "RUNNING",
            "5" => "CONTINUE_PENDING",
            "6" => "PAUSE_PENDING",
            "7" => "PAUSED",
            _ => "UNKNOWN"
        };
    }

    private static string NormalizeName(string serviceName)
    {
        var value = serviceName.Trim();
        if (value.Length == 0)
            throw new InvalidOperationException("MySQL 服務名稱不可空白。");
        if (value.Contains('"') || value.Contains('\r') || value.Contains('\n'))
            throw new InvalidOperationException("MySQL 服務名稱含有無效字元。");
        return value;
    }

    [GeneratedRegex(@"(?:STATE|狀態)\s*:\s*(\d+)(?:\s+([A-Z_]+))?", RegexOptions.IgnoreCase)]
    private static partial Regex StateRegex();
}
