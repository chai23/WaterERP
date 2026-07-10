using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace WaterErpLauncher;

internal sealed class MainForm : Form
{
    private readonly TextBox _projectRoot = new() { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
    private readonly TextBox _nginxRoot = new() { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
    private readonly TextBox _apiBaseUrl = new() { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
    private readonly TextBox _adminUrl = new() { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
    private readonly TextBox _driverUrl = new() { Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
    private readonly CheckBox _chkProductionMode = new()
    {
        Text = "正式部署（Nginx + 靜態前端）",
        AutoSize = true,
        Checked = true
    };
    private readonly CheckBox _chkAdminDev = new()
    {
        Text = "一併啟動後台 Vite (npm run dev:admin)",
        AutoSize = true
    };
    private readonly CheckBox _chkDriverDev = new()
    {
        Text = "一併啟動司機端 Vite (npm run dev:driver)",
        AutoSize = true
    };
    private readonly RichTextBox _log = new()
    {
        ReadOnly = true,
        BackColor = SystemColors.Window,
        Font = new Font("Consolas", 9f),
        Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right
    };
    private readonly Label _healthLabel = new() { AutoSize = true, Text = "API 狀態：尚未檢查" };
    private readonly Button _btnBrowse = new() { Text = "瀏覽…" };
    private readonly Button _btnBrowseNginx = new() { Text = "瀏覽…" };
    private readonly Button _btnStart = new() { Text = "啟動服務" };
    private readonly Button _btnStop = new() { Text = "停止全部", Enabled = false };
    private readonly Button _btnGitPull = new() { Text = "Git 拉取最新" };
    private readonly Button _btnDeployUpdate = new() { Text = "更新並部署" };
    private readonly Button _btnBuild = new() { Text = "建置專案 (npm run build)" };
    private readonly Button _btnPrisma = new() { Text = "Prisma generate" };
    private readonly Button _btnResetData = new() { Text = "清空業務資料" };
    private readonly Button _btnCheckSchema = new() { Text = "檢查結構" };
    private readonly Button _btnApplySchema = new() { Text = "升級結構" };
    private readonly Label _schemaStatusLabel = new() { AutoSize = true, Text = "結構：尚未檢查", ForeColor = SystemColors.GrayText };
    private readonly Button _btnMigrateZones = new() { Text = "轉換地址分區" };
    private readonly Button _btnMigrateCompanies = new() { Text = "轉換隸屬公司" };
    private readonly Button _btnMigrateCustomers = new() { Text = "轉換客戶資料" };
    private readonly Button _btnMigrateUsers = new() { Text = "轉換使用者資料" };
    private readonly Button _btnMigrateDrivers = new() { Text = "轉換司機資料" };
    private readonly Button _btnMigrateProducts = new() { Text = "轉換商品資料" };
    private readonly Button _btnOpenAdmin = new() { Text = "開啟後台 (瀏覽器)" };
    private readonly Button _btnOpenDriver = new() { Text = "開啟司機端 (瀏覽器)" };

    private readonly System.Windows.Forms.Timer _healthTimer = new() { Interval = 3000 };
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };

    private Process? _apiProcess;
    private Process? _adminDevProcess;
    private Process? _driverDevProcess;
    private bool _nginxStartedByLauncher;
    private bool _uiBusy;
    private string _gitBranch = "main";
    private readonly FlowLayoutPanel _devOpts;

    public MainForm()
    {
        Text = "超好企業進銷存系統 伺服器啟動器 v1.5";
        MinimumSize = new Size(720, 660);
        Size = new Size(900, 720);
        StartPosition = FormStartPosition.CenterScreen;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 7,
            Padding = new Padding(10)
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));

        var formPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            AutoSize = true
        };
        formPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150f));
        formPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
        formPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100f));

        var r = 0;
        AddRow(formPanel, r++, "專案根目錄", _projectRoot, _btnBrowse);
        AddRow(formPanel, r++, "Nginx 目錄", _nginxRoot, _btnBrowseNginx);
        AddRow(formPanel, r++, "網站基底 URL", _apiBaseUrl, null);
        AddRow(formPanel, r++, "後台網址", _adminUrl, null);
        AddRow(formPanel, r++, "司機端網址", _driverUrl, null);

        formPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var modeOpts = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true
        };
        modeOpts.Controls.Add(_chkProductionMode);
        formPanel.Controls.Add(new Label { Text = "部署模式", AutoSize = true, Anchor = AnchorStyles.Left | AnchorStyles.Top }, 0, r);
        formPanel.Controls.Add(modeOpts, 1, r);
        formPanel.SetColumnSpan(modeOpts, 2);
        r++;

        formPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var devLabel = new Label
        {
            Text = "開發模式選項",
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Top
        };
        _devOpts = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true
        };
        _devOpts.Controls.Add(_chkAdminDev);
        _devOpts.Controls.Add(_chkDriverDev);
        formPanel.Controls.Add(devLabel, 0, r);
        formPanel.Controls.Add(_devOpts, 1, r);
        formPanel.SetColumnSpan(_devOpts, 2);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight
        };
        buttons.Controls.Add(_btnStart);
        buttons.Controls.Add(_btnStop);
        buttons.Controls.Add(_btnGitPull);
        buttons.Controls.Add(_btnDeployUpdate);
        buttons.Controls.Add(_btnBuild);
        buttons.Controls.Add(_btnPrisma);
        buttons.Controls.Add(_btnResetData);
        buttons.Controls.Add(_btnOpenAdmin);
        buttons.Controls.Add(_btnOpenDriver);

        var deployHint = new Label
        {
            Text = "從 GitHub 更新：「Git 拉取最新」只下載程式；「更新並部署」= 停止 → 拉取 → 建置 → 啟動",
            AutoSize = true,
            MaximumSize = new Size(860, 0),
            ForeColor = SystemColors.GrayText
        };
        var deployPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            RowCount = 1
        };
        deployPanel.Controls.Add(deployHint, 0, 0);

        var schemaLabel = new Label
        {
            Text = "資料庫結構（water_erp 欄位／資料表升級）",
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Top
        };
        var schemaButtons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight
        };
        schemaButtons.Controls.Add(_btnCheckSchema);
        schemaButtons.Controls.Add(_btnApplySchema);

        var schemaPanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            RowCount = 3
        };
        schemaPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        schemaPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        schemaPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        schemaPanel.Controls.Add(schemaLabel, 0, 0);
        schemaPanel.Controls.Add(schemaButtons, 0, 1);
        schemaPanel.Controls.Add(_schemaStatusLabel, 0, 2);

        var migrateLabel = new Label
        {
            Text = "舊庫轉換（database → water_erp，唯讀舊庫）",
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Top
        };
        var migrateRow1 = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight
        };
        migrateRow1.Controls.Add(_btnMigrateZones);
        migrateRow1.Controls.Add(_btnMigrateCompanies);
        migrateRow1.Controls.Add(_btnMigrateCustomers);

        var migrateRow2 = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight
        };
        migrateRow2.Controls.Add(_btnMigrateUsers);
        migrateRow2.Controls.Add(_btnMigrateDrivers);
        migrateRow2.Controls.Add(_btnMigrateProducts);

        var migratePanel = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            AutoSize = true,
            RowCount = 3
        };
        migratePanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        migratePanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        migratePanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        migratePanel.Controls.Add(migrateLabel, 0, 0);
        migratePanel.Controls.Add(migrateRow1, 0, 1);
        migratePanel.Controls.Add(migrateRow2, 0, 2);

        var statusPanel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false
        };
        statusPanel.Controls.Add(_healthLabel);

        root.Controls.Add(formPanel, 0, 0);
        root.Controls.Add(buttons, 0, 1);
        root.Controls.Add(deployPanel, 0, 2);
        root.Controls.Add(schemaPanel, 0, 3);
        root.Controls.Add(migratePanel, 0, 4);
        root.Controls.Add(statusPanel, 0, 5);
        root.Controls.Add(_log, 0, 6);

        Controls.Add(root);

        _btnBrowse.Click += (_, _) => BrowseProjectRoot();
        _btnBrowseNginx.Click += (_, _) => BrowseNginxRoot();
        _chkProductionMode.CheckedChanged += (_, _) => SyncDeploymentModeUi();
        _btnStart.Click += async (_, _) => await StartAllAsync().ConfigureAwait(true);
        _btnStop.Click += async (_, _) => await StopAllAsync().ConfigureAwait(true);
        _btnGitPull.Click += async (_, _) => await GitPullAsync().ConfigureAwait(true);
        _btnDeployUpdate.Click += async (_, _) => await PullAndDeployAsync().ConfigureAwait(true);
        _btnBuild.Click += async (_, _) => await RunRootNpmCommandAsync("run build").ConfigureAwait(true);
        _btnPrisma.Click += async (_, _) => await RunRootNpmCommandAsync("run db:generate").ConfigureAwait(true);
        _btnResetData.Click += async (_, _) => await ResetDataAsync().ConfigureAwait(true);
        _btnCheckSchema.Click += async (_, _) => await CheckSchemaAsync().ConfigureAwait(true);
        _btnApplySchema.Click += async (_, _) => await ApplySchemaAsync().ConfigureAwait(true);
        _btnMigrateZones.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-zones", "轉換地址分區", MigrateZonesConfirmText()).ConfigureAwait(true);
        _btnMigrateCompanies.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-companies", "轉換隸屬公司", MigrateCompaniesConfirmText()).ConfigureAwait(true);
        _btnMigrateCustomers.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-customers", "轉換客戶資料", MigrateCustomersConfirmText()).ConfigureAwait(true);
        _btnMigrateUsers.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-users", "轉換使用者資料", MigrateUsersConfirmText()).ConfigureAwait(true);
        _btnMigrateDrivers.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-drivers", "轉換司機資料", MigrateDriversConfirmText()).ConfigureAwait(true);
        _btnMigrateProducts.Click += async (_, _) => await MigrateLegacyAsync("run db:migrate-products", "轉換商品資料", MigrateProductsConfirmText()).ConfigureAwait(true);
        _btnOpenAdmin.Click += (_, _) => OpenUrl(_adminUrl.Text.Trim());
        _btnOpenDriver.Click += (_, _) => OpenUrl(_driverUrl.Text.Trim());

        _healthTimer.Tick += async (_, _) => await CheckHealthAsync().ConfigureAwait(true);
        Load += OnLoad;
        FormClosing += OnFormClosing;
    }

    private static void AddRow(TableLayoutPanel panel, int row, string labelText, Control valueControl, Control? suffix)
    {
        panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var label = new Label
        {
            Text = labelText,
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Top,
            TextAlign = ContentAlignment.MiddleLeft
        };
        panel.Controls.Add(label, 0, row);
        valueControl.Dock = DockStyle.Fill;
        panel.Controls.Add(valueControl, 1, row);
        if (suffix != null)
        {
            suffix.Dock = DockStyle.Fill;
            panel.Controls.Add(suffix, 2, row);
        }
        else
        {
            panel.SetColumnSpan(valueControl, 2);
        }
    }

    private void OnLoad(object? sender, EventArgs e)
    {
        var s = LauncherSettings.Load();
        _projectRoot.Text = s.ProjectRoot;
        _nginxRoot.Text = string.IsNullOrWhiteSpace(s.NginxRoot) ? @"C:\nginx-1.31.2" : s.NginxRoot;
        _apiBaseUrl.Text = string.IsNullOrWhiteSpace(s.ApiBaseUrl) ? "http://125.228.16.160" : s.ApiBaseUrl;
        _adminUrl.Text = string.IsNullOrWhiteSpace(s.AdminUrl) ? "http://125.228.16.160/" : s.AdminUrl;
        _driverUrl.Text = string.IsNullOrWhiteSpace(s.DriverUrl) ? "http://125.228.16.160/driver/" : s.DriverUrl;
        _gitBranch = string.IsNullOrWhiteSpace(s.GitBranch) ? "main" : s.GitBranch.Trim();
        _chkProductionMode.Checked = s.UseProductionMode;
        _chkAdminDev.Checked = s.StartAdminDevWithApi;
        _chkDriverDev.Checked = s.StartDriverDevWithApi;
        MigrateSavedUrlsToFixedIpIfNeeded();
        SyncDeploymentModeUi();
        if (s.UseProductionMode)
            NormalizeProductionUrls();

        _healthTimer.Start();
        AppendLog("就緒。正式部署請勾選「Nginx + 靜態前端」，按「啟動服務」會啟動 API 與 Nginx。");
        _ = CheckSchemaQuietlyOnLoadAsync();
    }

    private static string MigrateZonesConfirmText() =>
        "將從舊庫 database.area 匯入 address_zones（排除 99 尚未分配），\n"
        + "並依 customer.area_id 重連既有客戶的區域。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private static string MigrateCompaniesConfirmText() =>
        "將從舊庫 customer.company 匯入 affiliated_companies。\n"
        + "會先清空新庫既有隸屬公司後重匯。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private static string MigrateCustomersConfirmText() =>
        "將從舊庫 customer 匯入 customers 與 delivery_addresses。\n"
        + "會先清空新庫既有客戶後重匯（若已有訂單則拒絕）。\n"
        + "請先完成「地址分區」「隸屬公司」轉換。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private static string MigrateUsersConfirmText() =>
        "將清空新庫 users / drivers，建立 id=1 的系統管理員（admin / admin123），\n"
        + "再從舊庫 personnel_list 匯入其餘使用者（自 id=2 起）。\n"
        + "員編來自 personnel_account_number，phone 留空。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private static string MigrateDriversConfirmText() =>
        "將清空新庫司機帳號（role=driver），從舊庫 driver 匯入司機，\n"
        + "登入帳號為 driver_id，預設密碼 888888。\n"
        + "最高訂單數／最大運送桶數來自 order_num／order_quantity。\n"
        + "若已有配送分派則拒絕執行。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private static string MigrateProductsConfirmText() =>
        "將清空新庫 products 與庫存，從舊庫 product 匯入實體商品。\n"
        + "含桶裝水、補桶、試喝、飲水機、清洗/維修費等（約 41 筆）。\n"
        + "不轉入套印標語、月結單、收空桶等虛擬行（約 26 筆）。\n"
        + "若已有銷售/生產/採購單據則拒絕執行。\n\n"
        + "舊庫僅讀取、不修改。確定繼續？";

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        _healthTimer.Stop();
        _healthTimer.Dispose();
        SaveSettingsFromUi();
        try
        {
            StopServicesCore();
        }
        catch
        {
            // ignore
        }

        _http.Dispose();
    }

    private void SaveSettingsFromUi()
    {
        var s = new LauncherSettings
        {
            ProjectRoot = _projectRoot.Text.Trim(),
            NginxRoot = _nginxRoot.Text.Trim(),
            ApiBaseUrl = _apiBaseUrl.Text.Trim(),
            AdminUrl = _adminUrl.Text.Trim(),
            DriverUrl = _driverUrl.Text.Trim(),
            UseProductionMode = _chkProductionMode.Checked,
            GitBranch = _gitBranch,
            StartAdminDevWithApi = _chkAdminDev.Checked,
            StartDriverDevWithApi = _chkDriverDev.Checked
        };
        s.Save();
    }

    private void BrowseProjectRoot()
    {
        using var dlg = new FolderBrowserDialog
        {
            InitialDirectory = TryGetDirectory(_projectRoot.Text.Trim()) ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            UseDescriptionForTitle = true,
            Description = "選擇專案根目錄（含 package.json）"
        };
        if (dlg.ShowDialog(this) == DialogResult.OK)
            _projectRoot.Text = dlg.SelectedPath;
    }

    private void BrowseNginxRoot()
    {
        using var dlg = new FolderBrowserDialog
        {
            InitialDirectory = TryGetDirectory(_nginxRoot.Text.Trim()) ?? @"C:\",
            UseDescriptionForTitle = true,
            Description = "選擇 Nginx 目錄（含 nginx.exe）"
        };
        if (dlg.ShowDialog(this) == DialogResult.OK)
            _nginxRoot.Text = dlg.SelectedPath;
    }

    private void SyncDeploymentModeUi()
    {
        var production = _chkProductionMode.Checked;
        _nginxRoot.Enabled = production;
        _btnBrowseNginx.Enabled = production;
        _devOpts.Enabled = !production;
        _chkAdminDev.Enabled = !production;
        _chkDriverDev.Enabled = !production;
        if (production)
        {
            _chkAdminDev.Checked = false;
            _chkDriverDev.Checked = false;
            NormalizeProductionUrls();
        }
    }

    private const string DefaultPublicHost = "125.228.16.160";

    private void MigrateSavedUrlsToFixedIpIfNeeded()
    {
        var host = DefaultPublicHost;
        var baseText = _apiBaseUrl.Text.Trim();
        var adminText = _adminUrl.Text.Trim();
        var driverText = _driverUrl.Text.Trim();

        var looksLikeOldLocal =
            baseText.Contains("localhost", StringComparison.OrdinalIgnoreCase)
            || baseText.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || adminText.Contains("localhost", StringComparison.OrdinalIgnoreCase)
            || adminText.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || driverText.Contains("localhost", StringComparison.OrdinalIgnoreCase)
            || driverText.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || IsDevPort(PortHelper.ParsePortFromUrl(baseText, 80))
            || IsDevPort(PortHelper.ParsePortFromUrl(adminText, 80))
            || IsDevPort(PortHelper.ParsePortFromUrl(driverText, 80));

        if (!looksLikeOldLocal)
            return;

        _apiBaseUrl.Text = $"http://{host}";
        _adminUrl.Text = $"http://{host}/";
        _driverUrl.Text = $"http://{host}/driver/";
        SaveSettingsFromUi();
        AppendLog($"已將網址預設更新為固定 IP：http://{host}/");
    }

    private static bool IsDevPort(int port) => port is 3000 or 5173 or 5174;

    private static string GetUrlHost(string url, string fallbackHost = DefaultPublicHost)
    {
        if (string.IsNullOrWhiteSpace(url))
            return fallbackHost;
        try
        {
            if (!url.Contains("://", StringComparison.Ordinal))
                url = "http://" + url.Trim();
            return new Uri(url.Trim()).Host;
        }
        catch
        {
            return fallbackHost;
        }
    }

    /// <summary>正式部署時，將舊的開發埠網址改為 Nginx 入口（80 埠）。</summary>
    private void NormalizeProductionUrls()
    {
        var host = GetUrlHost(_apiBaseUrl.Text);
        if (string.IsNullOrWhiteSpace(host))
            host = GetUrlHost(_adminUrl.Text);

        var basePort = PortHelper.ParsePortFromUrl(_apiBaseUrl.Text.Trim(), 80);
        var adminPort = PortHelper.ParsePortFromUrl(_adminUrl.Text.Trim(), 80);
        var driverPort = PortHelper.ParsePortFromUrl(_driverUrl.Text.Trim(), 80);
        var needsFix = IsDevPort(basePort) || IsDevPort(adminPort) || IsDevPort(driverPort)
            || _adminUrl.Text.Contains(":5173", StringComparison.OrdinalIgnoreCase)
            || _driverUrl.Text.Contains(":5174", StringComparison.OrdinalIgnoreCase)
            || _apiBaseUrl.Text.Contains(":3000", StringComparison.OrdinalIgnoreCase);

        if (!needsFix)
            return;

        _apiBaseUrl.Text = $"http://{host}";
        _adminUrl.Text = $"http://{host}/";
        _driverUrl.Text = $"http://{host}/driver/";
        AppendLog($"已將網址改為正式部署格式（Nginx 80 埠）：http://{host}/");
    }

    private int GetInternalApiPort() =>
        _chkProductionMode.Checked ? 3000 : PortHelper.ParsePortFromUrl(_apiBaseUrl.Text.Trim(), 3000);

    private int GetHttpPort()
    {
        if (_chkProductionMode.Checked)
        {
            var port = PortHelper.ParsePortFromUrl(_apiBaseUrl.Text.Trim(), 80);
            return IsDevPort(port) ? 80 : port;
        }

        return PortHelper.ParsePortFromUrl(_adminUrl.Text.Trim(), 5173);
    }

    private string? GetNginxExePath()
    {
        var root = _nginxRoot.Text.Trim();
        if (string.IsNullOrEmpty(root))
            return null;
        var exe = Path.Combine(root, "nginx.exe");
        return File.Exists(exe) ? exe : null;
    }

    private bool TryRunNginxCommand(string arguments, out string output)
    {
        output = "";
        var nginxExe = GetNginxExePath();
        if (nginxExe is null)
            return false;

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = nginxExe,
                Arguments = arguments,
                WorkingDirectory = Path.GetDirectoryName(nginxExe)!,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using var proc = Process.Start(psi);
            if (proc is null)
                return false;
            output = proc.StandardOutput.ReadToEnd() + proc.StandardError.ReadToEnd();
            proc.WaitForExit(10000);
            return proc.ExitCode == 0;
        }
        catch (Exception ex)
        {
            output = ex.Message;
            return false;
        }
    }

    private bool TryStartNginx()
    {
        var nginxExe = GetNginxExePath();
        if (nginxExe is null)
        {
            MessageBox.Show(this, "找不到 nginx.exe，請確認 Nginx 目錄設定正確。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }

        var httpPort = GetHttpPort();
        if (PortHelper.IsPortListening(httpPort))
        {
            if (PortHelper.IsPortUsedByProcess(httpPort, "nginx"))
            {
                AppendLog($"埠 {httpPort} 已有 Nginx 在執行，重新載入設定…");
                if (TryRunNginxCommand("-s reload", out var reloadOutput) && !string.IsNullOrWhiteSpace(reloadOutput))
                    AppendLog("[Nginx] " + reloadOutput.Trim());
                _nginxStartedByLauncher = true;
                return true;
            }

            var blocking = DescribePortBlockers(httpPort);
            MessageBox.Show(
                this,
                $"埠 {httpPort} 已被其他程式佔用，無法啟動 Nginx。\n\n{blocking}",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return false;
        }

        if (!TryRunNginxCommand("-t", out var testOutput))
        {
            MessageBox.Show(this, "Nginx 設定檢查失敗：\n" + testOutput.Trim(), Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = nginxExe,
                WorkingDirectory = Path.GetDirectoryName(nginxExe)!,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            Process.Start(psi);
            Thread.Sleep(800);
            if (!PortHelper.IsPortListening(httpPort))
            {
                MessageBox.Show(this, $"Nginx 已執行但埠 {httpPort} 未開始監聽，請檢查設定。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            _nginxStartedByLauncher = true;
            AppendLog($"已啟動 Nginx：{nginxExe}");
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Nginx 啟動失敗：\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    private void TryStopNginx(Action<string>? log = null)
    {
        StopNginxCore(log ?? AppendLog);
    }

    private void StopNginxCore(Action<string>? log)
    {
        var httpPort = GetHttpPort();

        if (!PortHelper.IsPortListening(httpPort))
        {
            _nginxStartedByLauncher = false;
            return;
        }

        log?.Invoke("嘗試停止 Nginx…");
        TryRunNginxCommand("-s quit", out var output);
        if (!string.IsNullOrWhiteSpace(output))
            log?.Invoke("[Nginx] " + output.Trim());

        Thread.Sleep(500);

        if (PortHelper.IsPortListening(httpPort))
        {
            log?.Invoke($"優雅停止失敗，強制結束佔用埠 {httpPort} 的 nginx 行程…");
            PortHelper.ReleasePortForNginx(httpPort, log);
        }

        if (PortHelper.IsPortListening(httpPort) && PortHelper.IsPortUsedByProcess(httpPort, "nginx"))
        {
            log?.Invoke("仍有殘留 nginx，執行強制清除…");
            PortHelper.ForceStopAllNginx(log);
        }

        _nginxStartedByLauncher = false;
    }

    private bool ShouldManageNginx() =>
        _nginxStartedByLauncher
        || (_chkProductionMode.Checked && PortHelper.IsPortListening(GetHttpPort()));

    private void DetachManagedProcesses()
    {
        if (_apiProcess != null)
        {
            _apiProcess.OutputDataReceived -= OnApiOutputDataReceived;
            _apiProcess.ErrorDataReceived -= OnApiErrorDataReceived;
            _apiProcess.Exited -= OnApiProcessExited;
        }

        if (_adminDevProcess != null)
            _adminDevProcess.Exited -= OnDevProcessExited;
        if (_driverDevProcess != null)
            _driverDevProcess.Exited -= OnDevProcessExited;
    }

    /// <summary>同步停止服務，不更新 UI（關閉視窗時使用，避免死結）。</summary>
    private void StopServicesCore(Action<string>? log = null)
    {
        var api = _apiProcess;
        var admin = _adminDevProcess;
        var driver = _driverDevProcess;
        var stopNginx = ShouldManageNginx();

        if (api is null && admin is null && driver is null && !stopNginx)
            return;

        DetachManagedProcesses();
        _apiProcess = null;
        _adminDevProcess = null;
        _driverDevProcess = null;

        TryKillAndDisposeApi(api);
        TryKillAndDisposeSimple(admin);
        TryKillAndDisposeSimple(driver);

        if (stopNginx)
            StopNginxCore(log);

        var apiPort = GetInternalApiPort();
        PortHelper.ReleasePortForNode(apiPort, log);
        if (!_chkProductionMode.Checked)
        {
            var adminPort = PortHelper.ParsePortFromUrl(_adminUrl.Text.Trim(), 5173);
            var driverPort = PortHelper.ParsePortFromUrl(_driverUrl.Text.Trim(), 5174);
            PortHelper.ReleasePortForNode(adminPort, log);
            PortHelper.ReleasePortForNode(driverPort, log);
        }
    }

    private async Task GenerateNginxConfigAsync(string projectRoot)
    {
        var script = Path.Combine(projectRoot, "deploy", "scripts", "generate-nginx-config.ps1");
        if (!File.Exists(script))
        {
            AppendLog("找不到 deploy\\scripts\\generate-nginx-config.ps1，略過產生 Nginx 設定。");
            return;
        }

        AppendLog("正在產生 Nginx 設定…");
        var psi = new ProcessStartInfo
        {
            FileName = "powershell",
            Arguments = $"-ExecutionPolicy Bypass -File \"{script}\" -ProjectRoot \"{projectRoot}\"",
            WorkingDirectory = projectRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using var proc = Process.Start(psi);
        if (proc is null)
            return;
        var stdout = await proc.StandardOutput.ReadToEndAsync().ConfigureAwait(true);
        var stderr = await proc.StandardError.ReadToEndAsync().ConfigureAwait(true);
        await proc.WaitForExitAsync().ConfigureAwait(true);
        if (!string.IsNullOrWhiteSpace(stdout))
            AppendLog(stdout.TrimEnd());
        if (!string.IsNullOrWhiteSpace(stderr))
            AppendLog(stderr.TrimEnd());
        AppendLog(proc.ExitCode == 0 ? "Nginx 設定已更新。" : $"產生 Nginx 設定失敗（結束代碼 {proc.ExitCode}）。");
    }

    private static string? TryGetDirectory(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return null;
        try
        {
            return Directory.Exists(path) ? path : null;
        }
        catch
        {
            return null;
        }
    }

    private void ValidateProjectRoot()
    {
        var root = _projectRoot.Text.Trim();
        if (string.IsNullOrEmpty(root))
            throw new InvalidOperationException("請先設定專案根目錄。");
        if (!File.Exists(Path.Combine(root, "package.json")))
            throw new InvalidOperationException("此資料夾找不到 package.json，請確認為本系統專案根目錄。");
    }

    private static string? FindNodeExe()
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathEnv))
            return null;
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe");
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private bool IsAnyServiceRunning()
    {
        return (_apiProcess is { HasExited: false })
            || (_adminDevProcess is { HasExited: false })
            || (_driverDevProcess is { HasExited: false })
            || _nginxStartedByLauncher;
    }

    private void SyncStartStopButtons()
    {
        _btnStart.Enabled = !_uiBusy && !IsAnyServiceRunning();
        _btnStop.Enabled = !_uiBusy && IsAnyServiceRunning();
    }

    /// <summary>啟動前釋放被殘留行程佔用的埠。</summary>
    private bool TryReleasePortsBeforeStart()
    {
        var apiPort = GetInternalApiPort();
        var httpPort = GetHttpPort();
        var adminPort = PortHelper.ParsePortFromUrl(_adminUrl.Text.Trim(), 5173);
        var driverPort = PortHelper.ParsePortFromUrl(_driverUrl.Text.Trim(), 5174);

        void Log(string msg) => AppendLog(msg);

        if (PortHelper.IsPortListening(apiPort))
        {
            AppendLog($"偵測到埠 {apiPort} 已被佔用，嘗試結束殘留的 Node 行程…");
            PortHelper.ReleasePortForNode(apiPort, Log);
        }

        if (_chkProductionMode.Checked)
        {
            if (PortHelper.IsPortListening(httpPort))
            {
                AppendLog($"偵測到埠 {httpPort} 已被佔用，嘗試停止既有 Nginx…");
                TryStopNginx();
            }

            if (PortHelper.IsPortListening(httpPort) && !PortHelper.IsPortUsedByProcess(httpPort, "nginx"))
            {
                var blocking = DescribePortBlockers(httpPort);
                MessageBox.Show(
                    this,
                    $"埠 {httpPort} 仍被其他程式佔用，無法啟動 Nginx。\n\n{blocking}\n\n請關閉佔用程式後再試。",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return false;
            }
        }
        else
        {
            if (_chkAdminDev.Checked && PortHelper.IsPortListening(adminPort))
            {
                AppendLog($"偵測到埠 {adminPort} 已被佔用，嘗試結束殘留的 Node 行程…");
                PortHelper.ReleasePortForNode(adminPort, Log);
            }

            if (_chkDriverDev.Checked && PortHelper.IsPortListening(driverPort))
            {
                AppendLog($"偵測到埠 {driverPort} 已被佔用，嘗試結束殘留的 Node 行程…");
                PortHelper.ReleasePortForNode(driverPort, Log);
            }
        }

        if (PortHelper.IsPortListening(apiPort))
        {
            var blocking = DescribePortBlockers(apiPort);
            MessageBox.Show(
                this,
                $"埠 {apiPort} 仍被佔用，無法啟動 API。\n\n{blocking}\n\n請關閉佔用程式後再試，或在工作管理員結束對應的 node.exe。",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return false;
        }

        return true;
    }

    private static string DescribePortBlockers(int port)
    {
        var lines = new List<string>();
        foreach (var pid in PortHelper.GetListenerProcessIds(port))
        {
            try
            {
                using var p = Process.GetProcessById(pid);
                lines.Add($"PID {pid}：{p.ProcessName}.exe");
            }
            catch
            {
                lines.Add($"PID {pid}");
            }
        }

        return lines.Count > 0 ? string.Join("\n", lines) : "（無法列出佔用程式）";
    }

    private async Task StartAllAsync()
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (IsAnyServiceRunning())
        {
            MessageBox.Show(this, "已有服務在執行中，請先按「停止全部」。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var node = FindNodeExe();
        if (string.IsNullOrEmpty(node))
        {
            MessageBox.Show(this, "找不到 node.exe，請確認已安裝 Node.js 並加入 PATH。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var root = _projectRoot.Text.Trim();
        var apiDir = Path.Combine(root, "apps", "api");
        var distJs = Path.Combine(apiDir, "dist", "index.js");
        if (!File.Exists(distJs))
        {
            MessageBox.Show(
                this,
                "找不到 apps\\api\\dist\\index.js。\n請先執行「建置專案」或於命令列執行 npm run build。",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        if (_chkProductionMode.Checked)
        {
            var adminDist = Path.Combine(root, "apps", "web-admin", "dist", "index.html");
            var driverDist = Path.Combine(root, "apps", "web-driver", "dist", "index.html");
            if (!File.Exists(adminDist) || !File.Exists(driverDist))
            {
                MessageBox.Show(
                    this,
                    "正式部署需要先建置前端靜態檔。\n請按「建置專案」後再啟動。",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            if (GetNginxExePath() is null)
            {
                MessageBox.Show(this, "找不到 nginx.exe，請確認 Nginx 目錄設定正確。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }

        var npmCmd = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!_chkProductionMode.Checked && (_chkAdminDev.Checked || _chkDriverDev.Checked) && !File.Exists(npmCmd))
        {
            MessageBox.Show(this, "已勾選啟動前端，但找不到 npm.cmd。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (!TryReleasePortsBeforeStart())
            return;

        if (_chkProductionMode.Checked)
            NormalizeProductionUrls();

        try
        {
            if (_chkProductionMode.Checked)
                await GenerateNginxConfigAsync(root).ConfigureAwait(true);

            var psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "dist/index.js",
                WorkingDirectory = apiDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            _apiProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _apiProcess.OutputDataReceived += OnApiOutputDataReceived;
            _apiProcess.ErrorDataReceived += OnApiErrorDataReceived;
            _apiProcess.Exited += OnApiProcessExited;

            _apiProcess.Start();
            _apiProcess.BeginOutputReadLine();
            _apiProcess.BeginErrorReadLine();

            AppendLog($"已啟動 API：{node} dist/index.js（{apiDir}）");

            if (_chkProductionMode.Checked)
            {
                if (!TryStartNginx())
                {
                    await StopAllAsync().ConfigureAwait(true);
                    return;
                }
            }
            else if (_chkAdminDev.Checked)
            {
                _adminDevProcess = StartNpmDevProcess(npmCmd, root, "run dev:admin", "後台 Vite");
                if (_adminDevProcess != null)
                {
                    _adminDevProcess.EnableRaisingEvents = true;
                    _adminDevProcess.Exited += OnDevProcessExited;
                    AppendLog("已啟動後台開發伺服器。");
                }
            }

            if (!_chkProductionMode.Checked && _chkDriverDev.Checked)
            {
                _driverDevProcess = StartNpmDevProcess(npmCmd, root, "run dev:driver", "司機端 Vite");
                if (_driverDevProcess != null)
                {
                    _driverDevProcess.EnableRaisingEvents = true;
                    _driverDevProcess.Exited += OnDevProcessExited;
                    AppendLog("已啟動司機端開發伺服器。");
                }
            }

            SyncStartStopButtons();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "啟動失敗：\n" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            await StopAllAsync().ConfigureAwait(true);
        }
    }

    private Process? StartNpmDevProcess(string npmCmd, string projectRoot, string npmArguments, string nameForUser)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = npmCmd,
                Arguments = npmArguments,
                WorkingDirectory = projectRoot,
                UseShellExecute = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
                CreateNoWindow = true
            };
            var p = new Process { StartInfo = psi };
            p.Start();
            return p;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"{nameForUser} 啟動失敗：\n{ex.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return null;
        }
    }

    private void OnDevProcessExited(object? sender, EventArgs e)
    {
        if (sender is not Process p)
            return;
        ScheduleOnUiThread(() =>
        {
            if (ReferenceEquals(_adminDevProcess, p))
            {
                TryDisposeProcessNoRedirect(_adminDevProcess);
                _adminDevProcess = null;
                AppendLog("後台開發伺服器已結束。");
            }
            else if (ReferenceEquals(_driverDevProcess, p))
            {
                TryDisposeProcessNoRedirect(_driverDevProcess);
                _driverDevProcess = null;
                AppendLog("司機端開發伺服器已結束。");
            }

            SyncStartStopButtons();
        });
    }

    private void OnApiOutputDataReceived(object sender, DataReceivedEventArgs e)
    {
        if (e.Data != null)
            ScheduleOnUiThread(() => AppendLog("[API stdout] " + e.Data));
    }

    private void OnApiErrorDataReceived(object sender, DataReceivedEventArgs e)
    {
        if (e.Data != null)
            ScheduleOnUiThread(() => AppendLog("[API stderr] " + e.Data));
    }

    private void OnApiProcessExited(object? sender, EventArgs e)
    {
        if (sender is not Process p)
            return;
        ScheduleOnUiThread(() =>
        {
            if (!ReferenceEquals(_apiProcess, p))
                return;
            AppendLog("API 行程已結束。");
            TryDisposeApiProcess(_apiProcess);
            _apiProcess = null;
            SyncStartStopButtons();
        });
    }

    private async Task StopAllAsync()
    {
        var api = _apiProcess;
        var admin = _adminDevProcess;
        var driver = _driverDevProcess;
        var stopNginx = ShouldManageNginx();

        if (api is null && admin is null && driver is null && !stopNginx)
            return;

        AppendLog("正在停止服務…");
        _btnStop.Enabled = false;
        _btnStart.Enabled = false;

        await Task.Run(() => StopServicesCore()).ConfigureAwait(false);

        if (!IsDisposed)
        {
            ScheduleOnUiThread(() =>
            {
                AppendLog("已停止全部服務。");
                SyncStartStopButtons();
            });
        }
    }

    private static void TryKillAndDisposeApi(Process? p)
    {
        if (p is null)
            return;
        try
        {
            if (!p.HasExited)
                p.Kill(entireProcessTree: true);
        }
        catch
        {
            // ignore
        }

        try
        {
            p.WaitForExit(20000);
        }
        catch
        {
            // ignore
        }

        TryDisposeApiProcess(p);
    }

    private static void TryDisposeApiProcess(Process? p)
    {
        if (p is null)
            return;
        try
        {
            p.CancelOutputRead();
        }
        catch
        {
            // ignore
        }

        try
        {
            p.CancelErrorRead();
        }
        catch
        {
            // ignore
        }

        try
        {
            p.Dispose();
        }
        catch
        {
            // ignore
        }
    }

    private static void TryKillAndDisposeSimple(Process? p)
    {
        if (p is null)
            return;
        try
        {
            if (!p.HasExited)
                p.Kill(entireProcessTree: true);
        }
        catch
        {
            // ignore
        }

        try
        {
            p.WaitForExit(20000);
        }
        catch
        {
            // ignore
        }

        TryDisposeProcessNoRedirect(p);
    }

    private static void TryDisposeProcessNoRedirect(Process? p)
    {
        if (p is null)
            return;
        try
        {
            p.Dispose();
        }
        catch
        {
            // ignore
        }
    }

    private static string? FindGitExe()
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathEnv))
            return null;
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim().Trim('"'), "git.exe");
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private void ValidateGitRepo()
    {
        var root = _projectRoot.Text.Trim();
        if (!Directory.Exists(Path.Combine(root, ".git")))
            throw new InvalidOperationException("此資料夾不是 Git 倉庫。請確認專案根目錄是否正確。");
    }

    private async Task<int?> RunGitCommandCoreAsync(string workingDirectory, string arguments)
    {
        var git = FindGitExe();
        if (string.IsNullOrEmpty(git))
        {
            AppendLog("找不到 git.exe，請確認已安裝 Git 並加入 PATH。");
            return null;
        }

        AppendLog($"> \"{workingDirectory}\" git {arguments}");
        var exitCode = -1;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = git,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            proc.OutputDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stdout.AppendLine(e.Data);
            };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stderr.AppendLine(e.Data);
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            await proc.WaitForExitAsync().ConfigureAwait(true);
            exitCode = proc.ExitCode;

            if (stdout.Length > 0)
                AppendLog(stdout.ToString().TrimEnd());
            if (stderr.Length > 0)
                AppendLog(stderr.ToString().TrimEnd());

            AppendLog(exitCode == 0 ? "Git 命令完成（成功）。" : $"Git 命令結束，結束代碼 {exitCode}。");
        }
        catch (Exception ex)
        {
            AppendLog("Git 執行錯誤：" + ex.Message);
            return null;
        }

        return exitCode;
    }

    private async Task GitPullAsync()
    {
        try
        {
            ValidateProjectRoot();
            ValidateGitRepo();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (IsAnyServiceRunning())
        {
            var stopFirst = MessageBox.Show(
                this,
                "目前有服務在執行中。建議先停止服務再拉取程式，是否現在停止全部？",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button1);
            if (stopFirst == DialogResult.Yes)
                await StopAllAsync().ConfigureAwait(true);
        }

        SetBusy(true);
        try
        {
            var root = _projectRoot.Text.Trim();
            var exitCode = await RunGitCommandCoreAsync(root, $"pull origin {_gitBranch}").ConfigureAwait(true);
            if (exitCode == 0)
            {
                MessageBox.Show(
                    this,
                    $"已從 GitHub 拉取最新程式（分支 {_gitBranch}）。\n\n若要在正式環境生效，請按「建置專案」後再「啟動服務」，或直接按「更新並部署」。",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            else if (exitCode != null)
            {
                MessageBox.Show(
                    this,
                    $"Git 拉取失敗（結束代碼 {exitCode}）。\n請查看下方日誌。",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task<bool> BuildProductionCoreAsync(string projectRoot)
    {
        var steps = new (string Args, string Label)[]
        {
            ("install", "安裝依賴"),
            ("run db:generate", "Prisma generate"),
            ("run build", "建置 API / 後台 / 司機端")
        };

        foreach (var (args, label) in steps)
        {
            AppendLog($"==> {label}…");
            var exitCode = await RunNpmCommandCoreAsync(projectRoot, args).ConfigureAwait(true);
            if (exitCode != 0)
            {
                AppendLog($"建置中斷：{label} 失敗（結束代碼 {exitCode}）。");
                return false;
            }
        }

        var apiDist = Path.Combine(projectRoot, "apps", "api", "dist", "index.js");
        var adminDist = Path.Combine(projectRoot, "apps", "web-admin", "dist", "index.html");
        var driverDist = Path.Combine(projectRoot, "apps", "web-driver", "dist", "index.html");
        foreach (var path in new[] { apiDist, adminDist, driverDist })
        {
            if (!File.Exists(path))
            {
                AppendLog($"建置失敗，缺少檔案：{path}");
                return false;
            }
        }

        await GenerateNginxConfigAsync(projectRoot).ConfigureAwait(true);
        AppendLog("建置完成。");
        return true;
    }

    private async Task PullAndDeployAsync()
    {
        try
        {
            ValidateProjectRoot();
            ValidateGitRepo();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (!_chkProductionMode.Checked)
        {
            MessageBox.Show(
                this,
                "「更新並部署」請在正式部署模式下使用（勾選 Nginx + 靜態前端）。",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        var confirm = MessageBox.Show(
            this,
            "將執行以下步驟：\n"
            + "1. 停止全部服務\n"
            + $"2. git pull origin {_gitBranch}\n"
            + "3. npm install → db:generate → build\n"
            + "4. 更新 Nginx 設定\n"
            + "5. 重新啟動服務\n\n"
            + "不會覆蓋 apps\\api\\.env 與資料庫資料。\n\n"
            + "確定要繼續嗎？",
            "更新並部署",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button1);
        if (confirm != DialogResult.Yes)
            return;

        SetBusy(true);
        try
        {
            AppendLog("=== 開始更新並部署 ===");

            if (IsAnyServiceRunning())
            {
                AppendLog("正在停止服務…");
                await StopAllAsync().ConfigureAwait(true);
            }

            var root = _projectRoot.Text.Trim();
            AppendLog($"=> Git 拉取 origin/{_gitBranch}…");
            var pullCode = await RunGitCommandCoreAsync(root, $"pull origin {_gitBranch}").ConfigureAwait(true);
            if (pullCode != 0)
            {
                MessageBox.Show(this, "Git 拉取失敗，部署已中止。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (!await BuildProductionCoreAsync(root).ConfigureAwait(true))
            {
                MessageBox.Show(this, "建置失敗，部署已中止。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            AppendLog("=> 重新啟動服務…");
            await StartAllAsync().ConfigureAwait(true);

            MessageBox.Show(
                this,
                "更新並部署完成。\n\n"
                + $"後台：{_adminUrl.Text.Trim()}\n"
                + $"司機端：{_driverUrl.Text.Trim()}\n"
                + $"健康檢查：{_apiBaseUrl.Text.Trim().TrimEnd('/')}/api/health",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            AppendLog("更新並部署錯誤：" + ex.Message);
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task<int?> RunNpmCommandCoreAsync(string workingDirectory, string npmArguments)
    {
        var node = FindNodeExe();
        if (string.IsNullOrEmpty(node))
        {
            AppendLog("找不到 node.exe。");
            return null;
        }

        var npmCmd = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!File.Exists(npmCmd))
        {
            AppendLog("找不到 npm.cmd。");
            return null;
        }

        AppendLog($"> \"{workingDirectory}\" npm {npmArguments}");
        var exitCode = -1;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = npmCmd,
                Arguments = npmArguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            proc.OutputDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stdout.AppendLine(e.Data);
            };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stderr.AppendLine(e.Data);
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            await proc.WaitForExitAsync().ConfigureAwait(true);
            exitCode = proc.ExitCode;

            if (stdout.Length > 0)
                AppendLog(stdout.ToString().TrimEnd());
            if (stderr.Length > 0)
                AppendLog(stderr.ToString().TrimEnd());
        }
        catch (Exception ex)
        {
            AppendLog("執行錯誤：" + ex.Message);
            return null;
        }

        return exitCode;
    }

    private async Task RunRootNpmCommandAsync(string npmArguments)
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        await RunNpmCommandAsync(_projectRoot.Text.Trim(), npmArguments).ConfigureAwait(true);
    }

    private async Task<int?> RunNpmCommandAsync(string workingDirectory, string npmArguments)
    {
        var node = FindNodeExe();
        if (string.IsNullOrEmpty(node))
        {
            MessageBox.Show(this, "找不到 node.exe。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }

        var npmCmd = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!File.Exists(npmCmd))
        {
            MessageBox.Show(this, "找不到 npm.cmd。", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }

        SetBusy(true);
        try
        {
            var exitCode = await RunNpmCommandCoreAsync(workingDirectory, npmArguments).ConfigureAwait(true) ?? -1;
            AppendLog(exitCode == 0 ? "命令完成（成功）。" : $"命令結束，結束代碼 {exitCode}。");

            if (exitCode != 0)
            {
                MessageBox.Show(
                    this,
                    $"命令執行失敗（結束代碼 {exitCode}）。\n請查看下方日誌。",
                    Text,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }

            return exitCode;
        }
        catch (Exception ex)
        {
            AppendLog("執行錯誤：" + ex.Message);
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task CheckSchemaQuietlyOnLoadAsync()
    {
        try
        {
            var root = _projectRoot.Text.Trim();
            if (string.IsNullOrEmpty(root))
                return;
            if (!File.Exists(Path.Combine(root, "apps", "api", ".env")))
            {
                _schemaStatusLabel.Text = "結構：尚未設定 DATABASE_URL";
                return;
            }

            var status = await FetchSchemaStatusAsync(root, logToUi: false).ConfigureAwait(true);
            if (status is null)
                return;

            UpdateSchemaStatusLabel(status);
            if (status.ok && status.pending.Length > 0)
                AppendLogWarning("資料庫結構落後，請按「檢查結構」或「升級結構」。");
        }
        catch
        {
            // 啟動時靜默檢查，略過錯誤
        }
    }

    private async Task CheckSchemaAsync()
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var root = _projectRoot.Text.Trim();
        if (!ValidateApiEnvExists())
            return;

        SetBusy(true);
        try
        {
            await RefreshSchemaStatusAsync(root, showDialog: true).ConfigureAwait(true);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task ApplySchemaAsync()
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var root = _projectRoot.Text.Trim();
        if (!ValidateApiEnvExists())
            return;

        var status = await FetchSchemaStatusAsync(root, logToUi: false).ConfigureAwait(true);
        if (status is null)
        {
            MessageBox.Show(this, "無法讀取資料庫結構狀態，請查看日誌。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (!status.ok)
        {
            MessageBox.Show(this, status.message ?? "檢查資料庫結構失敗。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        UpdateSchemaStatusLabel(status);
        if (status.pending.Length == 0)
        {
            MessageBox.Show(this, "資料庫結構已是最新，無需升級。", "升級資料庫結構", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var listText = string.Join("\n", status.pending);
        var confirm = MessageBox.Show(
            this,
            "將套用以下 migration 至本機 water_erp：\n"
            + listText
            + "\n\n建議先備份資料庫（mysqldump）。\n升級前會建議停止 API。\n\n確定繼續？",
            "升級資料庫結構",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirm != DialogResult.Yes)
            return;

        if (IsAnyServiceRunning())
        {
            var stopFirst = MessageBox.Show(
                this,
                "目前有服務在執行中。升級結構前建議先停止 API，是否現在停止全部服務？",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button1);
            if (stopFirst == DialogResult.Yes)
                await StopAllAsync().ConfigureAwait(true);
        }

        SetBusy(true);
        try
        {
            AppendLog("開始升級資料庫結構…");
            var applyCode = await RunNpmCommandCoreAsync(root, "run db:schema-apply").ConfigureAwait(true);
            if (applyCode != 0)
            {
                MessageBox.Show(this, $"升級失敗（結束代碼 {applyCode}）。\n請查看下方日誌。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            AppendLog("升級完成，正在 Prisma generate…");
            var genCode = await RunNpmCommandCoreAsync(root, "run db:generate").ConfigureAwait(true);
            if (genCode != 0)
            {
                MessageBox.Show(this, $"Prisma generate 失敗（結束代碼 {genCode}）。\n請查看下方日誌。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            await RefreshSchemaStatusAsync(root, showDialog: true).ConfigureAwait(true);
            AppendLogWarning("資料庫結構已升級。若 API 正在執行，請重啟 API。");
            MessageBox.Show(
                this,
                "資料庫結構已升級完成。\n\n若 API 正在執行，請按「停止全部」後再「啟動服務」。",
                "升級完成",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private bool ValidateApiEnvExists()
    {
        var root = _projectRoot.Text.Trim();
        var apiEnv = Path.Combine(root, "apps", "api", ".env");
        if (File.Exists(apiEnv))
            return true;

        MessageBox.Show(
            this,
            "找不到 apps\\api\\.env，無法連線資料庫。\n請先設定 DATABASE_URL 後再試。",
            Text,
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning);
        return false;
    }

    private async Task RefreshSchemaStatusAsync(string projectRoot, bool showDialog)
    {
        var status = await FetchSchemaStatusAsync(projectRoot, logToUi: showDialog).ConfigureAwait(true);
        if (status is null)
        {
            _schemaStatusLabel.Text = "結構：無法讀取狀態";
            _schemaStatusLabel.ForeColor = Color.DarkRed;
            if (showDialog)
                MessageBox.Show(this, "無法解析 db:schema-status 輸出，請查看日誌。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (!status.ok)
        {
            _schemaStatusLabel.Text = "結構：檢查失敗";
            _schemaStatusLabel.ForeColor = Color.DarkRed;
            if (showDialog)
                MessageBox.Show(this, status.message ?? "檢查資料庫結構失敗。", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        UpdateSchemaStatusLabel(status);
        if (!showDialog)
            return;

        var message = $"已套用 {status.applied.Length} 支 migration。";
        if (status.pending.Length == 0)
            message += "\n\n資料庫結構已最新。";
        else
            message += $"\n\n待升級 {status.pending.Length} 支：\n{string.Join("\n", status.pending)}";

        MessageBox.Show(
            this,
            message,
            "資料庫結構檢查",
            MessageBoxButtons.OK,
            status.pending.Length == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    private void UpdateSchemaStatusLabel(SchemaMigrationStatus status)
    {
        _schemaStatusLabel.Text = FormatSchemaSummary(status);
        _schemaStatusLabel.ForeColor = status.pending.Length == 0 ? Color.DarkGreen : Color.DarkOrange;
    }

    private static string FormatSchemaSummary(SchemaMigrationStatus status)
    {
        if (!status.ok)
            return status.message ?? "結構：檢查失敗";
        if (status.pending.Length == 0)
            return $"結構：已最新（已套用 {status.applied.Length} 支）";

        var preview = status.pending.Length <= 2
            ? string.Join(", ", status.pending)
            : $"{status.pending[0]}, … 共 {status.pending.Length} 支";
        return $"結構：待升級 {status.pending.Length} 支（{preview}）";
    }

    private async Task<SchemaMigrationStatus?> FetchSchemaStatusAsync(string projectRoot, bool logToUi)
    {
        if (logToUi)
            AppendLog("正在檢查資料庫結構…");

        var (exitCode, stdout, stderr) = await RunNpmCommandCaptureAsync(projectRoot, "run db:schema-status").ConfigureAwait(true);
        if (logToUi)
        {
            if (!string.IsNullOrWhiteSpace(stdout))
                AppendLog(stdout.TrimEnd());
            if (!string.IsNullOrWhiteSpace(stderr))
                AppendLog(stderr.TrimEnd());
        }

        if (exitCode != 0)
            return null;

        return ParseSchemaStatus(stdout + "\n" + stderr);
    }

    private static SchemaMigrationStatus? ParseSchemaStatus(string output)
    {
        var lines = output
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Reverse();

        foreach (var line in lines)
        {
            if (!line.StartsWith('{'))
                continue;
            try
            {
                return JsonSerializer.Deserialize<SchemaMigrationStatus>(line);
            }
            catch (JsonException)
            {
                // try previous line
            }
        }

        return null;
    }

    private async Task<(int? ExitCode, string Stdout, string Stderr)> RunNpmCommandCaptureAsync(string workingDirectory, string npmArguments)
    {
        var node = FindNodeExe();
        if (string.IsNullOrEmpty(node))
            return (null, "", "找不到 node.exe");

        var npmCmd = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!File.Exists(npmCmd))
            return (null, "", "找不到 npm.cmd");

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = npmCmd,
                Arguments = npmArguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            proc.OutputDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stdout.AppendLine(e.Data);
            };
            proc.ErrorDataReceived += (_, e) =>
            {
                if (e.Data != null)
                    stderr.AppendLine(e.Data);
            };

            proc.Start();
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            await proc.WaitForExitAsync().ConfigureAwait(true);
            return (proc.ExitCode, stdout.ToString(), stderr.ToString());
        }
        catch (Exception ex)
        {
            return (null, "", ex.Message);
        }
    }

    private async Task MigrateLegacyAsync(string npmArguments, string title, string confirmMessage)
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var root = _projectRoot.Text.Trim();
        var apiEnv = Path.Combine(root, "apps", "api", ".env");
        if (!File.Exists(apiEnv))
        {
            MessageBox.Show(
                this,
                "找不到 apps\\api\\.env，無法連線資料庫。\n請先設定 DATABASE_URL 後再試。",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        if (MessageBox.Show(this, confirmMessage, title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2)
            != DialogResult.Yes)
            return;

        if (IsAnyServiceRunning())
        {
            var stopFirst = MessageBox.Show(
                this,
                "目前有服務在執行中。轉換資料前建議先停止 API，是否現在停止全部服務？",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button1);
            if (stopFirst == DialogResult.Yes)
                await StopAllAsync().ConfigureAwait(true);
        }

        AppendLog($"開始{title}…");
        var exitCode = await RunNpmCommandAsync(root, npmArguments).ConfigureAwait(true);
        if (exitCode == 0)
        {
            MessageBox.Show(this, $"{title}完成。\n請至後台確認資料。", title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private async Task ResetDataAsync()
    {
        try
        {
            ValidateProjectRoot();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var root = _projectRoot.Text.Trim();
        var resetSql = Path.Combine(root, "database", "migrations", "004_reset_data_keep_single_admin.sql");
        if (!File.Exists(resetSql))
        {
            MessageBox.Show(
                this,
                "找不到清空腳本：\n" + resetSql,
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var apiEnv = Path.Combine(root, "apps", "api", ".env");
        if (!File.Exists(apiEnv))
        {
            MessageBox.Show(
                this,
                "找不到 apps\\api\\.env，無法連線資料庫。\n請先設定 DATABASE_URL 後再試。",
                Text,
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var confirm = MessageBox.Show(
            this,
            "此操作將清空所有業務資料（客戶、商品、訂單、配送、帳務、司機、車輛、使用者等）。\n"
            + "清空後將無法登入，須再執行「轉換使用者資料」建立帳號。\n\n"
            + "此動作無法復原，建議先備份資料庫。\n\n"
            + "確定要繼續嗎？",
            "清空業務資料",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirm != DialogResult.Yes)
            return;

        if (IsAnyServiceRunning())
        {
            var stopFirst = MessageBox.Show(
                this,
                "目前有服務在執行中。清空資料前建議先停止 API，是否現在停止全部服務？",
                Text,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button1);
            if (stopFirst == DialogResult.Yes)
                await StopAllAsync().ConfigureAwait(true);
        }

        AppendLog("開始清空業務資料（含使用者）…");
        var exitCode = await RunNpmCommandAsync(root, "run db:reset").ConfigureAwait(true);
        if (exitCode == 0)
        {
            MessageBox.Show(
                this,
                "業務資料已清空（含所有使用者）。\n\n請執行「轉換使用者資料」匯入帳號並建立 id=1 的 admin。\n完成後再啟動服務並登入後台。",
                "清空完成",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
    }

    private void SetBusy(bool busy)
    {
        _uiBusy = busy;
        _btnBuild.Enabled = !busy;
        _btnGitPull.Enabled = !busy;
        _btnDeployUpdate.Enabled = !busy;
        _btnPrisma.Enabled = !busy;
        _btnResetData.Enabled = !busy;
        _btnCheckSchema.Enabled = !busy;
        _btnApplySchema.Enabled = !busy;
        _btnMigrateZones.Enabled = !busy;
        _btnMigrateCompanies.Enabled = !busy;
        _btnMigrateCustomers.Enabled = !busy;
        _btnMigrateUsers.Enabled = !busy;
        _btnBrowse.Enabled = !busy;
        _btnBrowseNginx.Enabled = !busy && _chkProductionMode.Checked;
        _chkProductionMode.Enabled = !busy;
        _chkAdminDev.Enabled = !busy && !_chkProductionMode.Checked;
        _chkDriverDev.Enabled = !busy && !_chkProductionMode.Checked;
        Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        SyncStartStopButtons();
    }

    private async Task CheckHealthAsync()
    {
        var baseUrl = _apiBaseUrl.Text.Trim().TrimEnd('/');
        if (string.IsNullOrEmpty(baseUrl))
            return;

        string text;
        Color color;
        try
        {
            using var resp = await _http.GetAsync(new Uri(new Uri(baseUrl), "/api/health")).ConfigureAwait(true);
            if (resp.IsSuccessStatusCode)
            {
                text = $"API 狀態：線上 ({(int)resp.StatusCode})";
                color = Color.DarkGreen;
            }
            else
            {
                text = $"API 狀態：回應異常 ({(int)resp.StatusCode})";
                color = Color.DarkOrange;
            }
        }
        catch
        {
            text = "API 狀態：離線或無法連線";
            color = Color.DarkRed;
        }

        _healthLabel.Text = text;
        _healthLabel.ForeColor = color;
    }

    private static void OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return;
        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch
        {
            // ignore
        }
    }

    private void AppendLog(string line)
    {
        AppendColoredLog(line, null);
    }

    private void AppendLogWarning(string line)
    {
        AppendColoredLog(line, Color.DarkGoldenrod);
    }

    private void AppendColoredLog(string line, Color? color)
    {
        if (IsDisposed)
            return;
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendColoredLog(line, color));
            return;
        }

        var stamp = DateTime.Now.ToString("HH:mm:ss");
        var defaultColor = _log.ForeColor;
        if (color.HasValue)
            _log.SelectionColor = color.Value;
        _log.AppendText($"[{stamp}] {line}\n");
        if (color.HasValue)
            _log.SelectionColor = defaultColor;
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
    }

    /// <summary>以非同步方式將動作排回 UI 執行緒，避免與 Process.Dispose 互相 Invoke 造成死結。</summary>
    private void ScheduleOnUiThread(Action action)
    {
        if (IsDisposed)
            return;
        if (InvokeRequired)
            BeginInvoke(action);
        else
            action();
    }

    private sealed class SchemaMigrationStatus
    {
        public bool ok { get; set; }
        public string[] applied { get; set; } = [];
        public string[] pending { get; set; } = [];
        public string? latest { get; set; }
        public string? message { get; set; }
        public string[]? appliedNow { get; set; }
    }
}
