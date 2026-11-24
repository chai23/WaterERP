using System.Drawing.Printing;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new PrintTestForm());
    }
}

sealed partial class PrintTestForm : Form
{
    private const int MaxFileBytes = 1024 * 1024;
    private const double MillimetersPerInch = 25.4;
    private const string Head = "<head>";
    private const string DocumentStart = "<!DOCTYPE html>\n<html lang=\"zh-Hant\">\n<head>";
    private static readonly JsonSerializerOptions JobJsonOptions = new(JsonSerializerDefaults.Web);
    private const string ContentPolicy = """
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
        """;
    private readonly ComboBox printers = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 240 };
    private readonly NumericUpDown copies = new() { Minimum = 1, Maximum = 20, Value = 1, Width = 55 };
    private readonly Button open = new() { Text = "開啟測試檔", AutoSize = true, Enabled = false };
    private readonly Button print = new() { Text = "送印", AutoSize = true, Enabled = false };
    private readonly Label status = new() { Text = "正在初始化列印預覽…", Dock = DockStyle.Bottom, Height = 45, Padding = new(8) };
    private readonly WebView2 preview = new() { Dock = DockStyle.Fill };
    private TaskCompletionSource<bool>? navigation;
    private ulong? navigationId;
    private TestJob? readyJob;
    private bool busy;

    public PrintTestForm()
    {
        Text = "WaterERP 點陣套印助手";
        ClientSize = new Size(1050, 600);
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new(8) };
        toolbar.Controls.AddRange([
            open, new Label { Text = "印表機", AutoSize = true }, printers,
            new Label { Text = "份數", AutoSize = true }, copies, print
        ]);
        AddQueueControls(toolbar);
        Controls.Add(preview);
        Controls.Add(status);
        Controls.Add(toolbar);
        open.Click += OpenTestJob;
        print.Click += PrintTestJob;
        printers.SelectedIndexChanged += (_, _) => UpdatePrintButton();
        Shown += InitializePreview;
    }

    private async void InitializePreview(object? sender, EventArgs e)
    {
        try
        {
            foreach (string printer in PrinterSettings.InstalledPrinters)
                printers.Items.Add(printer);
            var dataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "WaterErpPrintAgent", "WebView2");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: dataFolder);
            await preview.EnsureCoreWebView2Async(environment);
            var core = preview.CoreWebView2;
            core.Settings.IsScriptEnabled = false;
            core.Settings.IsWebMessageEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.NavigationStarting += (_, args) =>
            {
                args.Cancel = args.Uri != "about:blank";
                if (!args.Cancel && navigation is not null)
                    navigationId = args.NavigationId;
            };
            core.FrameNavigationStarting += (_, args) => args.Cancel = true;
            core.NewWindowRequested += (_, args) => args.Handled = true;
            core.DownloadStarting += (_, args) => args.Cancel = true;
            core.NavigationCompleted += (_, args) =>
            {
                if (args.NavigationId == navigationId)
                    navigation?.TrySetResult(args.IsSuccess);
            };
            core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All);
            core.AddWebResourceRequestedFilter("file://*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, args) =>
                args.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
            InitializeQueue();
            open.Enabled = true;
            status.Text = printers.Items.Count == 0
                ? "Windows 未列出印表機。安裝驅動程式後請重新開啟助手。"
                : "開啟從 WaterERP 列印設定下載的測試檔。";
        }
        catch (Exception ex)
        {
            status.Text = $"初始化失敗：{ex.Message}";
        }
    }

    private async void OpenTestJob(object? sender, EventArgs e)
    {
        using var dialog = new OpenFileDialog { Filter = "WaterERP 測試檔 (*.json)|*.json" };
        if (dialog.ShowDialog(this) != DialogResult.OK || busy)
            return;

        SetBusy(true);
        try
        {
            using var file = File.OpenRead(dialog.FileName);
            if (file.Length > MaxFileBytes)
                throw new InvalidDataException("測試檔超過 1 MB。");
            var job = JsonSerializer.Deserialize<TestJob>(file, JobJsonOptions);
            if (job is null)
                throw new InvalidDataException("測試檔格式或紙張尺寸無效。");
            await LoadDocumentAsync(job);
            readyJob = job;
            status.Text = $"紙張 {job.PageWidthMm:0.##} × {job.PageHeightMm:0.##} mm，請選擇印表機。";
        }
        catch (Exception ex)
        {
            readyJob = null;
            status.Text = $"開啟失敗：{ex.Message}";
        }
        finally { SetBusy(false); }
    }

    private async Task LoadDocumentAsync(TestJob job)
    {
        if (job is not { Version: 1, PageWidthMm: >= 20 and <= 1000, PageHeightMm: >= 20 and <= 1000 } ||
            job.Html is null || !job.Html.Replace("\r\n", "\n").StartsWith(DocumentStart, StringComparison.Ordinal))
            throw new InvalidDataException("套印文件格式或紙張尺寸無效。");
        var index = job.Html.IndexOf(Head, StringComparison.Ordinal) + Head.Length;
        await NavigateDocumentAsync(job.Html.Insert(index, ContentPolicy));
    }

    private async Task NavigateDocumentAsync(string html)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        navigation = completion;
        try
        {
            preview.NavigateToString(html);
            if (!await completion.Task.WaitAsync(TimeSpan.FromSeconds(15)))
                throw new InvalidDataException("無法載入套印版面。");
        }
        catch
        {
            preview.CoreWebView2.Stop();
            throw;
        }
        finally
        {
            navigation = null;
            navigationId = null;
        }
    }

    private async void PrintTestJob(object? sender, EventArgs e)
    {
        if (busy || readyJob is not { } job || printers.SelectedItem is not string printer)
            return;

        SetBusy(true);
        status.Text = $"正在送往 {printer}…";
        try
        {
            var result = await SendToPrinterAsync(job, printer, (int)copies.Value);
            status.Text = result switch
            {
                CoreWebView2PrintStatus.Succeeded => $"已送至 {printer}，請檢查實際出紙。",
                CoreWebView2PrintStatus.PrinterUnavailable => $"無法使用 {printer}，請檢查印表機及 Windows 列印佇列。",
                _ => $"送印未成功（{result}），請確認印表機及佇列後再試。"
            };
        }
        catch (Exception ex)
        {
            status.Text = $"送印結果待確認，請先檢查列印佇列：{ex.Message}";
        }
        finally
        {
            SetBusy(false);
        }
    }

    private Task<CoreWebView2PrintStatus> SendToPrinterAsync(TestJob job, string printer, int count)
    {
        var settings = preview.CoreWebView2.Environment.CreatePrintSettings();
        settings.PrinterName = printer;
        settings.MediaSize = CoreWebView2PrintMediaSize.Custom;
        settings.PageWidth = job.PageWidthMm / MillimetersPerInch;
        settings.PageHeight = job.PageHeightMm / MillimetersPerInch;
        settings.ScaleFactor = 1;
        settings.MarginTop = settings.MarginBottom = settings.MarginLeft = settings.MarginRight = 0;
        settings.ShouldPrintHeaderAndFooter = false;
        settings.Copies = count;
        return preview.CoreWebView2.PrintAsync(settings);
    }

    private void SetBusy(bool value)
    {
        busy = value;
        open.Enabled = !value;
        printers.Enabled = !value;
        UpdatePrintButton();
    }

    private void UpdatePrintButton() =>
        print.Enabled = !busy && readyJob != null && printers.SelectedItem is string;

    private sealed record TestJob(int Version, double PageWidthMm, double PageHeightMm, string Html);
}
