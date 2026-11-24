using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.Web.WebView2.Core;

sealed partial class PrintTestForm
{
    private static readonly HttpClient QueueClient = new(new HttpClientHandler { AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromSeconds(8)
    };
    private readonly TextBox serverAddress = new() { Width = 230 };
    private readonly Button copyStation = new() { Text = "複製配對碼", AutoSize = true, Enabled = false };
    private readonly Button queueToggle = new() { Text = "啟用接單", AutoSize = true, Enabled = false };
    private readonly System.Windows.Forms.Timer poll = new() { Interval = 2500 };
    private string stationKey = "";
    private Uri? server;
    private QueueResult? pendingResult;
    private static string PreferencesPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WaterErpPrintAgent", "station.json");

    private void AddQueueControls(FlowLayoutPanel toolbar)
    {
        toolbar.SetFlowBreak(print, true);
        toolbar.Controls.AddRange([
            new Label { Text = "ERP 網址", AutoSize = true }, serverAddress, copyStation, queueToggle
        ]);
        copyStation.Click += (_, _) =>
        {
            try
            {
                Clipboard.SetText(stationKey);
                status.Text = "已複製配對碼。請貼到 WaterERP 的「訂單列印版面」並儲存。";
            }
            catch (Exception ex) { status.Text = $"無法複製：{ex.Message}"; }
        };
        queueToggle.Click += ToggleQueue;
        poll.Tick += PollQueue;
        FormClosed += (_, _) => poll.Dispose();
    }

    private void InitializeQueue()
    {
        var preferences = File.Exists(PreferencesPath)
            ? System.Text.Json.JsonSerializer.Deserialize<StationPreferences>(File.ReadAllText(PreferencesPath), JobJsonOptions)
            : null;
        stationKey = preferences?.StationKey ?? Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        serverAddress.Text = preferences?.Server ?? "";
        if (preferences?.Printer is string printer && printers.Items.Contains(printer))
            printers.SelectedItem = printer;
        SavePreferences();
        copyStation.Enabled = true;
        queueToggle.Enabled = true;
    }

    private void SavePreferences()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PreferencesPath)!);
        var temp = PreferencesPath + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temp, System.Text.Json.JsonSerializer.Serialize(
                new StationPreferences(stationKey, serverAddress.Text.Trim(), printers.SelectedItem as string), JobJsonOptions));
            File.Move(temp, PreferencesPath, overwrite: true);
        }
        finally { File.Delete(temp); }
    }

    private void ToggleQueue(object? sender, EventArgs e)
    {
        if (busy) return;
        if (poll.Enabled)
        {
            poll.Stop();
            serverAddress.Enabled = true;
            queueToggle.Text = "啟用接單";
            status.Text = "已暫停接單。";
            return;
        }
        if (!Uri.TryCreate(serverAddress.Text.Trim(), UriKind.Absolute, out var address) ||
            (address.Scheme != Uri.UriSchemeHttps && !(address.Scheme == Uri.UriSchemeHttp && address.IsLoopback)) ||
            address.AbsolutePath != "/" || address.UserInfo.Length != 0 || address.Query.Length != 0 || address.Fragment.Length != 0)
        {
            status.Text = "請輸入 ERP 根網址，使用 HTTPS 或本機的 HTTP 網址。";
            return;
        }
        if (printers.SelectedItem is not string)
        {
            status.Text = "請先選擇印表機。";
            return;
        }
        if (pendingResult is not null && server != address)
        {
            status.Text = "仍有送印結果待回報，請先連回原 ERP 網址。";
            return;
        }
        try { SavePreferences(); }
        catch (Exception ex)
        {
            status.Text = $"無法儲存印表機設定：{ex.Message}";
            return;
        }
        server = address;
        serverAddress.Enabled = false;
        queueToggle.Text = "暫停接單";
        status.Text = "正在連線至 ERP…";
        poll.Start();
        PollQueue(null, EventArgs.Empty);
    }

    private async void PollQueue(object? sender, EventArgs e)
    {
        if (busy || server is null || printers.SelectedItem is not string printer) return;
        SetBusy(true);
        try
        {
            if (pendingResult is not null)
            {
                using var report = await PostQueueAsync("result", pendingResult);
                report.EnsureSuccessStatusCode();
                pendingResult = null;
                return;
            }
            using var response = await PostQueueAsync("claim", null);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                status.Text = "尚未配對。請將配對碼貼到 ERP 的「訂單列印版面」並儲存。";
                return;
            }
            response.EnsureSuccessStatusCode();
            var envelope = await response.Content.ReadFromJsonAsync<QueueResponse>(JobJsonOptions);
            if (envelope?.Job is not { } job)
            {
                if (!status.Text.StartsWith("接單中", StringComparison.Ordinal))
                    status.Text = $"接單中，印表機為 {printer}。";
                return;
            }
            status.Text = $"正在送往 {printer}…";
            readyJob = null;
            var result = "failed";
            try
            {
                await LoadDocumentAsync(job.Document);
                result = "unknown";
                result = await SendToPrinterAsync(job.Document, printer, 1) switch
                {
                    CoreWebView2PrintStatus.Succeeded => "submitted",
                    CoreWebView2PrintStatus.PrinterUnavailable => "failed",
                    _ => "unknown"
                };
            }
            catch (Exception ex)
            {
                status.Text = $"套印工作處理中斷：{ex.Message}";
            }
            finally
            {
                pendingResult = new QueueResult(job.Id, result);
                await NavigateDocumentAsync("<!DOCTYPE html><html><body></body></html>");
            }
            using var reportResult = await PostQueueAsync("result", pendingResult);
            reportResult.EnsureSuccessStatusCode();
            pendingResult = null;
            status.Text = result switch
            {
                "submitted" => $"接單中。上一張已送至 {printer}。",
                "failed" => $"接單中。上一張送印失敗，請檢查 {printer}。",
                _ => "接單中。上一張送印結果待確認，請檢查實際出紙及佇列。"
            };
        }
        catch (Exception ex)
        {
            status.Text = $"ERP 列印連線中斷，將自動重試：{ex.Message}";
        }
        finally { SetBusy(false); }
    }

    private async Task<HttpResponseMessage> PostQueueAsync(string action, QueueResult? result)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(server!, $"/api/print-agent/{action}"));
        request.Headers.Add("X-Print-Station", stationKey);
        if (result is not null) request.Content = JsonContent.Create(result, options: JobJsonOptions);
        return await QueueClient.SendAsync(request);
    }

    private sealed record StationPreferences(string StationKey, string Server, string? Printer);
    private sealed record QueueResponse(QueueJob? Job);
    private sealed record QueueJob(string Id, TestJob Document);
    private sealed record QueueResult(string Id, string Status);
}
