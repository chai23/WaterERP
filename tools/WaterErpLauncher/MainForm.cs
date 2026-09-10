using System.Diagnostics;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace WaterErpLauncher;

internal sealed class MainForm : Form
{
    private const int ApiPort = 3000;
    private const int MySqlPort = 3306;
    private const string DefaultPublicHost = "125.228.16.160";

    private readonly TextBox _projectRoot = new();
    private readonly TextBox _nginxRoot = new();
    private readonly TextBox _mysqlServiceName = new();
    private readonly TextBox _apiBaseUrl = new();
    private readonly TextBox _adminUrl = new();
    private readonly TextBox _driverUrl = new();
    private readonly TextBox _liffUrl = new();
    private readonly TextBox _gitBranch = new();

    private readonly RichTextBox _log = new()
    {
        ReadOnly = true,
        BackColor = Color.FromArgb(15, 23, 42),
        ForeColor = Color.FromArgb(226, 232, 240),
        BorderStyle = BorderStyle.None,
        Font = new Font("Cascadia Mono", 9f),
        Dock = DockStyle.Fill
    };
    private readonly Label _summary = new()
    {
        Text = "正在取得服務狀態…",
        AutoSize = true,
        Font = new Font("Segoe UI", 13f, FontStyle.Bold),
        ForeColor = UiTheme.Muted
    };
    private readonly Label _recentLog = new()
    {
        Text = "尚無日誌",
        AutoEllipsis = true,
        Dock = DockStyle.Fill,
        ForeColor = UiTheme.Muted
    };
    private readonly Label _schemaStatus = new()
    {
        Text = "結構：尚未檢查",
        AutoSize = true,
        ForeColor = UiTheme.Muted
    };
    private readonly Label _gitDot = new()
    {
        Text = "●",
        AutoSize = true,
        Font = new Font("Segoe UI", 13f),
        ForeColor = UiTheme.Unknown
    };
    private readonly Label _gitHeadline = new()
    {
        Text = "尚未檢查 Git 同步",
        AutoSize = true,
        Font = new Font("Segoe UI", 12f, FontStyle.Bold),
        ForeColor = UiTheme.Unknown
    };
    private readonly Label _gitDetail = new()
    {
        Text = "啟動後會向 GitHub 比對目前分支。",
        AutoSize = true,
        MaximumSize = new Size(860, 0),
        ForeColor = UiTheme.Muted
    };
    private readonly Label _gitHint = new()
    {
        Text = "請按「檢查同步」確認是否有新版本。",
        AutoSize = true,
        MaximumSize = new Size(860, 0),
        ForeColor = UiTheme.Muted
    };

    private readonly Button _deployButton = UiTheme.Button("更新並部署", primary: true);
    private readonly Button _refreshButton = UiTheme.Button("重新整理");
    private readonly Button _startAllButton = UiTheme.Button("一鍵啟動服務", success: true, large: true);
    private readonly Button _stopAppsButton = UiTheme.Button("停止應用");
    private readonly Button _gitCheckButton = UiTheme.Button("檢查同步");
    private readonly Button _gitPullButton = UiTheme.Button("Git pull");
    private readonly Button _buildButton = UiTheme.Button("建置正式版");
    private readonly Button _prismaButton = UiTheme.Button("Prisma generate");
    private readonly Button _lineCheckButton = UiTheme.Button("LINE 設定檢查");
    private readonly Button _schemaCheckButton = UiTheme.Button("檢查結構");
    private readonly Button _schemaApplyButton = UiTheme.Button("升級結構", primary: true);
    private readonly Button _clearTransactionsButton = UiTheme.Button("清空交易資料");
    private readonly Button _resetDataButton = UiTheme.Button("清空全部資料", danger: true);
    private readonly Button _saveSettingsButton = UiTheme.Button("儲存設定", primary: true);
    private readonly Button _browseProjectButton = UiTheme.Button("瀏覽…");
    private readonly Button _browseNginxButton = UiTheme.Button("瀏覽…");

    private readonly System.Windows.Forms.Timer _healthTimer = new() { Interval = 3000 };
    private readonly System.Windows.Forms.Timer _gitTimer = new() { Interval = 120_000 };
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private readonly SemaphoreSlim _healthGate = new(1, 1);
    private readonly SemaphoreSlim _gitGate = new(1, 1);
    private readonly List<Control> _busyControls = new();

    private ServiceCard _mysqlCard = null!;
    private ServiceCard _apiCard = null!;
    private ServiceCard _nginxCard = null!;
    private EndpointCard _adminCard = null!;
    private EndpointCard _driverCard = null!;
    private EndpointCard _liffCard = null!;

    private Process? _apiProcess;
    private bool _uiBusy;
    private bool _closing;
    private TabControl _tabs = null!;

    public MainForm()
    {
        Text = "超好企業進銷存系統｜Windows 伺服器啟動器";
        Font = new Font("Segoe UI", 9.5f);
        BackColor = UiTheme.Background;
        ForeColor = UiTheme.Text;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1040, 760);
        Size = new Size(1220, 900);

        _tabs = new TabControl
        {
            Dock = DockStyle.Fill,
            Font = new Font("Segoe UI", 10f),
            Padding = new Point(18, 8)
        };
        _tabs.TabPages.Add(BuildOverviewTab());
        _tabs.TabPages.Add(BuildDataTab());
        _tabs.TabPages.Add(BuildAdvancedTab());
        _tabs.TabPages.Add(BuildLogTab());
        _tabs.TabPages.Add(BuildSettingsTab());
        Controls.Add(_tabs);

        WireEvents();
        Load += OnLoad;
        FormClosing += OnFormClosing;
    }

    private TabPage BuildOverviewTab()
    {
        var page = NewTab("服務總覽");
        var scroll = NewScrollPanel();
        var content = NewContentTable(8);

        var version = typeof(Program).Assembly.GetName().Version;
        var versionText = version is null ? "啟動器" : $"啟動器 v{version.Major}.{version.Minor}.{version.Build}";
        var brand = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Height = 108,
            BackColor = UiTheme.Primary,
            ColumnCount = 2,
            RowCount = 2,
            Padding = new Padding(22, 16, 22, 16),
            Margin = new Padding(0, 0, 0, 12)
        };
        brand.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        brand.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        brand.Controls.Add(new Label
        {
            Text = "超好企業進銷存系統",
            AutoSize = true,
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 22f, FontStyle.Bold)
        }, 0, 0);
        brand.Controls.Add(new Label
        {
            Text = "Windows 正式環境服務中心",
            AutoSize = true,
            ForeColor = Color.FromArgb(219, 234, 254),
            Font = new Font("Segoe UI", 10.5f)
        }, 0, 1);
        brand.Controls.Add(new Label
        {
            Text = versionText,
            AutoSize = true,
            ForeColor = Color.FromArgb(191, 219, 254),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            Margin = new Padding(12, 8, 0, 0)
        }, 1, 0);

        var actionCard = UiTheme.Card();
        actionCard.Dock = DockStyle.Fill;
        actionCard.AutoSize = true;
        var actionLayout = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 1 };
        actionLayout.Controls.Add(_summary);
        actionLayout.Controls.Add(new Label
        {
            Text = "一鍵啟動會依序開啟 MySQL、API、Nginx。「停止應用」只停網站，資料庫保持運行。",
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 4, 0, 10)
        });
        actionLayout.Controls.Add(NewButtonRow(_startAllButton, _stopAppsButton, _deployButton, _refreshButton));
        actionCard.Controls.Add(actionLayout);

        var gitCard = UiTheme.Card();
        gitCard.Dock = DockStyle.Fill;
        gitCard.AutoSize = true;
        var gitLayout = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 1 };
        gitLayout.Controls.Add(new Label
        {
            Text = "Git 同步狀態",
            AutoSize = true,
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            ForeColor = UiTheme.Text
        });
        var gitStatusRow = new FlowLayoutPanel
        {
            AutoSize = true,
            WrapContents = false,
            Margin = new Padding(0, 8, 0, 4)
        };
        gitStatusRow.Controls.Add(_gitDot);
        _gitHeadline.Margin = new Padding(6, 1, 0, 0);
        gitStatusRow.Controls.Add(_gitHeadline);
        gitLayout.Controls.Add(gitStatusRow);
        gitLayout.Controls.Add(_gitDetail);
        _gitHint.Margin = new Padding(0, 6, 0, 10);
        gitLayout.Controls.Add(_gitHint);
        gitLayout.Controls.Add(NewButtonRow(_gitCheckButton));
        gitCard.Controls.Add(gitLayout);

        var serviceTitle = SectionTitle("核心服務", "每 3 秒自動監控，也可個別啟動或停止。");
        var serviceGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, AutoSize = true };
        for (var i = 0; i < 3; i++)
            serviceGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333f));
        _mysqlCard = CreateServiceCard("MySQL", "Windows Service · TCP 3306");
        _apiCard = CreateServiceCard("API", "Node.js · localhost:3000");
        _nginxCard = CreateServiceCard("Nginx", "靜態網站與反向代理");
        serviceGrid.Controls.Add(_mysqlCard.Root, 0, 0);
        serviceGrid.Controls.Add(_apiCard.Root, 1, 0);
        serviceGrid.Controls.Add(_nginxCard.Root, 2, 0);

        var endpointTitle = SectionTitle("網站端點", "後台、司機端與 LIFF 都由同一個 Nginx 提供，並非獨立行程。");
        var endpointGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 1, AutoSize = true };
        for (var i = 0; i < 3; i++)
            endpointGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.333f));
        _adminCard = CreateEndpointCard("後台");
        _driverCard = CreateEndpointCard("司機端");
        _liffCard = CreateEndpointCard("LIFF 訂水");
        endpointGrid.Controls.Add(_adminCard.Root, 0, 0);
        endpointGrid.Controls.Add(_driverCard.Root, 1, 0);
        endpointGrid.Controls.Add(_liffCard.Root, 2, 0);

        var recentCard = UiTheme.Card();
        recentCard.Dock = DockStyle.Fill;
        recentCard.Height = 74;
        recentCard.Controls.Add(_recentLog);
        recentCard.Controls.Add(new Label
        {
            Text = "最近日誌",
            Dock = DockStyle.Top,
            Height = 25,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = UiTheme.Text
        });

        AddContentRow(content, brand);
        AddContentRow(content, actionCard);
        AddContentRow(content, gitCard);
        AddContentRow(content, serviceTitle);
        AddContentRow(content, serviceGrid);
        AddContentRow(content, endpointTitle);
        AddContentRow(content, endpointGrid);
        AddContentRow(content, recentCard);
        scroll.Controls.Add(content);
        page.Controls.Add(scroll);
        return page;
    }

    private TabPage BuildDataTab()
    {
        var page = NewTab("資料維護");
        var scroll = NewScrollPanel();
        var content = NewContentTable(4);

        AddContentRow(content, PageHeader("資料維護", "資料操作期間只停止 API / Nginx，MySQL 必須保持運行。"));

        var schemaCard = BuildToolCard(
            "資料庫結構",
            "檢查或套用 database/migrations（目前基線為 001）。正式機操作前請先備份資料庫。",
            NewButtonRow(_schemaCheckButton, _schemaApplyButton),
            _schemaStatus);
        AddContentRow(content, schemaCard);

        var clearCard = BuildToolCard(
            "清空資料",
            "可保留主檔只清除交易，或清除全部業務資料。兩項操作皆不可復原。",
            NewButtonRow(_clearTransactionsButton, _resetDataButton));
        AddContentRow(content, clearCard);

        var legacyButtons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            WrapContents = true,
            Padding = new Padding(0, 8, 0, 0)
        };
        AddLegacyButton(legacyButtons, "轉換地址分區", "run db:migrate-zones", MigrateZonesConfirmText());
        AddLegacyButton(legacyButtons, "轉換隸屬公司", "run db:migrate-companies", MigrateCompaniesConfirmText());
        AddLegacyButton(legacyButtons, "轉換客戶資料", "run db:migrate-customers", MigrateCustomersConfirmText());
        AddLegacyButton(legacyButtons, "轉換使用者資料", "run db:migrate-users", MigrateUsersConfirmText());
        AddLegacyButton(legacyButtons, "轉換司機資料", "run db:migrate-drivers", MigrateDriversConfirmText());
        AddLegacyButton(legacyButtons, "轉換商品資料", "run db:migrate-products", MigrateProductsConfirmText());
        AddContentRow(content, BuildToolCard(
            "舊庫轉換",
            "從舊資料庫 database 唯讀匯入主檔到 water_erp。建議順序：分區→公司→客戶→使用者→司機→商品。舊系統訂單不匯入；切換時請在後台「切換日開帳」帶入未收款／同步空桶，歷史單用「舊系統歷史訂單」查看。",
            legacyButtons));

        scroll.Controls.Add(content);
        page.Controls.Add(scroll);
        return page;
    }

    private TabPage BuildAdvancedTab()
    {
        var page = NewTab("進階工具");
        var scroll = NewScrollPanel();
        var content = NewContentTable(3);
        AddContentRow(content, PageHeader("進階工具", "供管理員分步執行部署工作；完整更新請使用服務總覽的「更新並部署」。"));
        AddContentRow(content, BuildToolCard(
            "程式與建置",
            "分別執行 Git 拉取、正式建置或 Prisma Client 產生。服務總覽會顯示是否已與 GitHub 同步。",
            NewButtonRow(_gitPullButton, _buildButton, _prismaButton)));
        AddContentRow(content, BuildToolCard(
            "LINE 正式設定",
            "檢查 API / LIFF .env、LIFF ID、正式環境安全開關與建置產物。",
            NewButtonRow(_lineCheckButton)));
        scroll.Controls.Add(content);
        page.Controls.Add(scroll);
        return page;
    }

    private TabPage BuildLogTab()
    {
        var page = NewTab("日誌");
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 1,
            RowCount = 2,
            BackColor = UiTheme.Background
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        header.Controls.Add(PageHeader("執行日誌", "API、部署、資料維護與舊庫轉換（含訂單）的 stdout／stderr 都會即時顯示於此。"), 0, 0);
        var clear = UiTheme.Button("清除日誌");
        clear.Click += (_, _) => _log.Clear();
        header.Controls.Add(clear, 1, 0);
        root.Controls.Add(header, 0, 0);
        root.Controls.Add(_log, 0, 1);
        page.Controls.Add(root);
        return page;
    }

    private TabPage BuildSettingsTab()
    {
        var page = NewTab("設定");
        var scroll = NewScrollPanel();
        var content = NewContentTable(3);
        AddContentRow(content, PageHeader("啟動器設定", "正式機設定會儲存在目前 Windows 使用者的 LocalAppData。"));

        var form = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            ColumnCount = 3,
            Padding = new Padding(18),
            BackColor = UiTheme.Surface
        };
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155));
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        form.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        AddSettingRow(form, 0, "專案根目錄", _projectRoot, _browseProjectButton);
        AddSettingRow(form, 1, "Nginx 目錄", _nginxRoot, _browseNginxButton);
        AddSettingRow(form, 2, "MySQL 服務名稱", _mysqlServiceName, null);
        AddSettingRow(form, 3, "網站 / API URL", _apiBaseUrl, null);
        AddSettingRow(form, 4, "後台 URL", _adminUrl, null);
        AddSettingRow(form, 5, "司機端 URL", _driverUrl, null);
        AddSettingRow(form, 6, "LIFF URL", _liffUrl, null);
        AddSettingRow(form, 7, "Git 分支", _gitBranch, null);
        AddContentRow(content, form);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
        footer.Controls.Add(_saveSettingsButton);
        footer.Controls.Add(new Label
        {
            Text = "啟停 MySQL Windows Service 通常需要以系統管理員身分執行啟動器。",
            AutoSize = true,
            ForeColor = UiTheme.Warning,
            Margin = new Padding(0, 10, 16, 0)
        });
        AddContentRow(content, footer);
        scroll.Controls.Add(content);
        page.Controls.Add(scroll);
        return page;
    }

    private void WireEvents()
    {
        _deployButton.Click += async (_, _) => await SafeUiActionAsync(PullAndDeployAsync);
        _refreshButton.Click += async (_, _) => await CheckHealthAsync(force: true);
        _startAllButton.Click += async (_, _) => await SafeUiActionAsync(StartAllServicesAsync);
        _stopAppsButton.Click += async (_, _) => await RunBusyAsync(StopApplicationServicesCoreAsync);
        _gitCheckButton.Click += async (_, _) => await SafeUiActionAsync(() => RefreshGitStatusAsync(fetch: true, logResult: true));
        _mysqlCard.Start.Click += async (_, _) => await RunBusyAsync(StartMySqlAsync);
        _mysqlCard.Stop.Click += async (_, _) => await RunBusyAsync(StopMySqlAsync);
        _apiCard.Start.Click += async (_, _) => await RunBusyAsync(StartApiAsync);
        _apiCard.Stop.Click += async (_, _) => await RunBusyAsync(StopApiAsync);
        _nginxCard.Start.Click += async (_, _) => await RunBusyAsync(StartNginxAsync);
        _nginxCard.Stop.Click += async (_, _) => await RunBusyAsync(StopNginxAsync);
        _adminCard.Open.Click += (_, _) => OpenUrl(_adminUrl.Text);
        _driverCard.Open.Click += (_, _) => OpenUrl(_driverUrl.Text);
        _liffCard.Open.Click += (_, _) => OpenUrl(_liffUrl.Text);
        _gitPullButton.Click += async (_, _) => await SafeUiActionAsync(GitPullAsync);
        _buildButton.Click += async (_, _) => await SafeUiActionAsync(BuildForProductionAsync);
        _prismaButton.Click += async (_, _) => await SafeUiActionAsync(
            () => RunStandaloneNpmAsync("run db:generate", "Prisma generate"));
        _lineCheckButton.Click += async (_, _) => await SafeUiActionAsync(() =>
        {
            ShowLineProductionCheck(requireBuiltDist: false);
            return Task.CompletedTask;
        });
        _schemaCheckButton.Click += async (_, _) => await SafeUiActionAsync(CheckSchemaAsync);
        _schemaApplyButton.Click += async (_, _) => await SafeUiActionAsync(ApplySchemaAsync);
        _clearTransactionsButton.Click += async (_, _) => await SafeUiActionAsync(ClearTransactionsAsync);
        _resetDataButton.Click += async (_, _) => await SafeUiActionAsync(ResetDataAsync);
        _saveSettingsButton.Click += (_, _) =>
        {
            SaveSettingsFromUi();
            AppendLog("設定已儲存。");
            MessageBox.Show(this, "設定已儲存。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        };
        _browseProjectButton.Click += (_, _) => BrowseFolder(_projectRoot, "選擇專案根目錄（含 package.json）");
        _browseNginxButton.Click += (_, _) => BrowseFolder(_nginxRoot, "選擇 Nginx 目錄（含 nginx.exe）");
        _healthTimer.Tick += async (_, _) => await CheckHealthAsync();
        _gitTimer.Tick += async (_, _) =>
        {
            if (!_uiBusy)
                await RefreshGitStatusAsync(fetch: true, logResult: false);
        };

        _busyControls.AddRange(new Control[]
        {
            _deployButton, _startAllButton, _stopAppsButton, _gitCheckButton, _gitPullButton, _buildButton, _prismaButton,
            _lineCheckButton, _schemaCheckButton, _schemaApplyButton, _clearTransactionsButton,
            _resetDataButton, _saveSettingsButton, _browseProjectButton, _browseNginxButton,
            _mysqlCard.Start, _mysqlCard.Stop, _apiCard.Start, _apiCard.Stop, _nginxCard.Start, _nginxCard.Stop
        });
    }

    private async void OnLoad(object? sender, EventArgs e)
    {
        var settings = LauncherSettings.Load();
        _projectRoot.Text = settings.ProjectRoot;
        _nginxRoot.Text = string.IsNullOrWhiteSpace(settings.NginxRoot) ? @"C:\nginx-1.31.2" : settings.NginxRoot;
        _mysqlServiceName.Text = string.IsNullOrWhiteSpace(settings.MySqlServiceName) ? "MySQL80" : settings.MySqlServiceName;
        _apiBaseUrl.Text = string.IsNullOrWhiteSpace(settings.ApiBaseUrl) ? $"http://{DefaultPublicHost}" : settings.ApiBaseUrl;
        _adminUrl.Text = string.IsNullOrWhiteSpace(settings.AdminUrl) ? $"http://{DefaultPublicHost}/" : settings.AdminUrl;
        _driverUrl.Text = string.IsNullOrWhiteSpace(settings.DriverUrl) ? $"http://{DefaultPublicHost}/driver/" : settings.DriverUrl;
        _liffUrl.Text = string.IsNullOrWhiteSpace(settings.LiffUrl) ? $"http://{DefaultPublicHost}/liff/" : settings.LiffUrl;
        _gitBranch.Text = string.IsNullOrWhiteSpace(settings.GitBranch) ? "main" : settings.GitBranch;
        NormalizeProductionUrls();
        AppendLog("啟動器已就緒。正式模式固定使用 API dist + Nginx 靜態網站。");
        AppendLog($"MySQL Windows Service：{_mysqlServiceName.Text}");
        _healthTimer.Start();
        _gitTimer.Start();
        await CheckHealthAsync(force: true);
        _ = CheckSchemaQuietlyAsync();
        _ = RefreshGitStatusAsync(fetch: true, logResult: false);
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        _closing = true;
        _healthTimer.Stop();
        _gitTimer.Stop();
        SaveSettingsFromUi();
        DetachApiEvents();
        TryKillAndDisposeApi(_apiProcess);
        _apiProcess = null;
        PortHelper.ReleasePortForNode(ApiPort);
        StopNginxCore(null);
        _http.Dispose();
    }

    private async Task StartAllServicesAsync()
    {
        await RunBusyAsync(async () =>
        {
            if (!await StartAllCoreAsync())
                return;
            MessageBox.Show(this, "MySQL、API 與 Nginx 已啟動。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
    }

    private async Task<bool> StartAllCoreAsync()
    {
        ValidateProjectRoot();
        ValidateProductionOutputs(includeApi: true);
        if (!ConfirmLineProductionReady(requireBuiltDist: true, "一鍵啟動服務"))
            return false;
        AppendLog("=== 一鍵啟動服務：MySQL → API → Nginx ===");
        if (!await StartMySqlAsync())
            throw new InvalidOperationException("MySQL 未成功啟動，已中止後續服務啟動。");
        if (!await StartApiAsync())
            throw new InvalidOperationException("API 未成功啟動，已中止 Nginx 啟動。");
        if (!await StartNginxAsync())
            throw new InvalidOperationException("Nginx 未成功啟動。");
        AppendLog("全部服務已啟動。");
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task<bool> StartMySqlAsync()
    {
        var name = GetMySqlServiceName();
        AppendLog($"正在啟動 MySQL Windows Service「{name}」…");
        var result = await WindowsServiceHelper.StartAsync(name, TimeSpan.FromSeconds(30));
        if (!result.Success)
        {
            ShowServiceError("MySQL 啟動失敗", result);
            return false;
        }
        AppendLog($"MySQL 服務已啟動（{name}）。");
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task<bool> StopMySqlAsync()
    {
        var answer = MessageBox.Show(
            this,
            "停止 MySQL 會使所有資料庫操作與 API 中斷。\n\n確定要停止 MySQL Windows Service？",
            "停止 MySQL",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes)
            return false;

        var name = GetMySqlServiceName();
        AppendLog($"正在停止 MySQL Windows Service「{name}」…");
        var result = await WindowsServiceHelper.StopAsync(name, TimeSpan.FromSeconds(30));
        if (!result.Success)
        {
            ShowServiceError("MySQL 停止失敗", result);
            return false;
        }
        AppendLog("MySQL 服務已停止。");
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task<bool> StartApiAsync()
    {
        ValidateProjectRoot();
        if (PortHelper.IsPortListening(ApiPort))
        {
            if (PortHelper.IsPortUsedByProcess(ApiPort, "node"))
            {
                AppendLog("API 埠 3000 已由 node.exe 監聽，視為已啟動。");
                return true;
            }
            throw new InvalidOperationException($"埠 {ApiPort} 已由非 node 行程佔用：\n{DescribePortBlockers(ApiPort)}");
        }

        var node = FindExecutable("node.exe");
        if (node is null)
            throw new InvalidOperationException("找不到 node.exe，請安裝 Node.js 並加入 PATH。");
        var apiDirectory = Path.Combine(_projectRoot.Text.Trim(), "apps", "api");
        var dist = Path.Combine(apiDirectory, "dist", "index.js");
        if (!File.Exists(dist))
            throw new InvalidOperationException("找不到 apps\\api\\dist\\index.js，請先建置正式版。");

        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            Arguments = "dist/index.js",
            WorkingDirectory = apiDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        _apiProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        _apiProcess.OutputDataReceived += OnApiOutput;
        _apiProcess.ErrorDataReceived += OnApiError;
        _apiProcess.Exited += OnApiExited;
        _apiProcess.Start();
        _apiProcess.BeginOutputReadLine();
        _apiProcess.BeginErrorReadLine();
        AppendLog($"已啟動 API：{node} dist/index.js");

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(12);
        while (DateTime.UtcNow < deadline && !PortHelper.IsPortListening(ApiPort))
            await Task.Delay(300);
        if (!PortHelper.IsPortListening(ApiPort))
        {
            await StopApiAsync();
            throw new InvalidOperationException("API 已啟動但逾時未監聽 localhost:3000，請查看日誌。");
        }
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task<bool> StopApiAsync()
    {
        AppendLog("正在停止 API…");
        var owned = _apiProcess;
        DetachApiEvents();
        _apiProcess = null;
        await Task.Run(() =>
        {
            TryKillAndDisposeApi(owned);
            PortHelper.ReleasePortForNode(ApiPort, AppendLog);
        });
        AppendLog("API 已停止。");
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task<bool> StartNginxAsync()
    {
        ValidateProjectRoot();
        ValidateProductionOutputs(includeApi: false);
        var root = _projectRoot.Text.Trim();
        await GenerateNginxConfigAsync(root);
        var started = TryStartNginx();
        await CheckHealthAsync(force: true);
        return started;
    }

    private async Task<bool> StopNginxAsync()
    {
        AppendLog("正在停止 Nginx…");
        StopNginxCore(AppendLog);
        AppendLog("Nginx 已停止。");
        await CheckHealthAsync(force: true);
        return true;
    }

    private async Task StopApplicationServicesCoreAsync()
    {
        AppendLog("正在停止應用服務；MySQL 將保持運行…");
        await StopApiAsync();
        await StopNginxAsync();
        AppendLog("API 與 Nginx 已停止；MySQL 未停止。");
    }

    private async Task<bool> EnsureMySqlRunningAsync(string operation)
    {
        var query = await WindowsServiceHelper.QueryAsync(GetMySqlServiceName());
        if (query.State == "RUNNING")
            return true;

        var answer = MessageBox.Show(
            this,
            $"{operation}需要 MySQL 服務保持運行，目前服務狀態為 {query.State}。\n\n是否立即啟動 {GetMySqlServiceName()}？",
            "MySQL 未運行",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button1);
        return answer == DialogResult.Yes && await StartMySqlAsync();
    }

    private async Task PullAndDeployAsync()
    {
        ValidateProjectRoot();
        ValidateGitRepo();
        if (!ConfirmLineProductionReady(requireBuiltDist: false, "更新並部署"))
            return;
        var branch = GetGitBranch();
        var confirm = MessageBox.Show(
            this,
            $"將停止 API / Nginx（保留 MySQL），接著執行：\n"
            + $"1. git pull origin {branch}\n"
            + "2. npm install\n3. Prisma generate\n4. 套用資料庫結構\n5. 正式建置\n"
            + "6. 產生 Nginx 設定並啟動 API / Nginx\n\n確定繼續？",
            "更新並部署",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button1);
        if (confirm != DialogResult.Yes)
            return;
        if (!await EnsureMySqlRunningAsync("更新並部署"))
            return;

        await RunBusyAsync(async () =>
        {
            AppendLog("=== 開始更新並部署 ===");
            await StopApplicationServicesCoreAsync();
            var root = _projectRoot.Text.Trim();
            if (await RunGitCommandCoreAsync(root, $"pull origin {branch}") != 0)
                throw new InvalidOperationException("Git pull 失敗，部署已中止。");
            if (!await BuildProductionCoreAsync(root, applySchema: true))
                throw new InvalidOperationException("建置失敗，部署已中止。");
            if (!await StartApiAsync())
                throw new InvalidOperationException("API 啟動失敗。");
            if (!await StartNginxAsync())
                throw new InvalidOperationException("Nginx 啟動失敗。");
            AppendLog("=== 更新並部署完成 ===");
            await RefreshGitStatusAsync(fetch: true, logResult: false);
            MessageBox.Show(this, "更新並部署完成。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
    }

    private async Task GitPullAsync()
    {
        ValidateProjectRoot();
        ValidateGitRepo();
        await RunBusyAsync(async () =>
        {
            if (await RunGitCommandCoreAsync(_projectRoot.Text.Trim(), $"pull origin {GetGitBranch()}") != 0)
                throw new InvalidOperationException("Git pull 失敗，請查看日誌。");
            await RefreshGitStatusAsync(fetch: true, logResult: false);
        });
    }

    private async Task BuildForProductionAsync()
    {
        ValidateProjectRoot();
        if (!ConfirmLineProductionReady(requireBuiltDist: false, "建置正式版"))
            return;
        await RunBusyAsync(async () =>
        {
            if (!await BuildProductionCoreAsync(_projectRoot.Text.Trim(), applySchema: false))
                throw new InvalidOperationException("建置失敗，請查看日誌。");
            MessageBox.Show(this, "正式版建置完成。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
    }

    private async Task<bool> BuildProductionCoreAsync(string root, bool applySchema)
    {
        var steps = new List<(string Args, string Label)>
        {
            ("install", "安裝依賴"),
            ("run db:generate", "Prisma generate")
        };
        if (applySchema)
            steps.Add(("run db:schema-apply", "套用資料庫結構"));
        steps.Add(("run build", "建置 API / 後台 / 司機端 / LIFF"));

        foreach (var (arguments, label) in steps)
        {
            AppendLog($"==> {label}…");
            if (await RunNpmCommandCoreAsync(root, arguments) != 0)
                return false;
        }

        var outputs = new[]
        {
            Path.Combine(root, "apps", "api", "dist", "index.js"),
            Path.Combine(root, "apps", "web-admin", "dist", "index.html"),
            Path.Combine(root, "apps", "web-driver", "dist", "index.html"),
            Path.Combine(root, "apps", "web-liff", "dist", "index.html")
        };
        foreach (var output in outputs)
        {
            if (!File.Exists(output))
            {
                AppendLogWarning($"建置缺少產物：{output}");
                return false;
            }
        }
        await GenerateNginxConfigAsync(root);
        AppendLog("正式版建置完成。");
        return true;
    }

    private async Task RunStandaloneNpmAsync(string arguments, string title)
    {
        ValidateProjectRoot();
        await RunBusyAsync(async () =>
        {
            var code = await RunNpmCommandCoreAsync(_projectRoot.Text.Trim(), arguments);
            if (code != 0)
                throw new InvalidOperationException($"{title} 失敗（結束代碼 {code}）。");
            AppendLog($"{title} 完成。");
        });
    }

    private async Task CheckSchemaAsync()
    {
        ValidateProjectRoot();
        if (!ValidateApiEnvExists() || !await EnsureMySqlRunningAsync("檢查資料庫結構"))
            return;
        await RunBusyAsync(async () =>
        {
            var status = await FetchSchemaStatusAsync(_projectRoot.Text.Trim(), logToUi: true);
            if (status is null || !status.ok)
                throw new InvalidOperationException(status?.message ?? "無法讀取資料庫結構狀態。");
            UpdateSchemaStatus(status);
            var message = status.pending.Length == 0
                ? $"資料庫結構已是最新（已套用 {status.applied.Length} 支）。"
                : $"待升級 {status.pending.Length} 支：\n{string.Join("\n", status.pending)}";
            MessageBox.Show(this, message, "資料庫結構", MessageBoxButtons.OK,
                status.pending.Length == 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        });
    }

    private async Task ApplySchemaAsync()
    {
        ValidateProjectRoot();
        if (!ValidateApiEnvExists() || !await EnsureMySqlRunningAsync("升級資料庫結構"))
            return;
        var confirm = MessageBox.Show(
            this,
            "將停止 API / Nginx、保留 MySQL，並套用所有待升級 migration。\n\n請確認已備份資料庫。是否繼續？",
            "升級資料庫結構",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirm != DialogResult.Yes)
            return;
        await RunBusyAsync(async () =>
        {
            await StopApplicationServicesCoreAsync();
            var root = _projectRoot.Text.Trim();
            if (await RunNpmCommandCoreAsync(root, "run db:schema-apply") != 0)
                throw new InvalidOperationException("資料庫結構升級失敗。");
            if (await RunNpmCommandCoreAsync(root, "run db:generate") != 0)
                throw new InvalidOperationException("結構已套用，但 Prisma generate 失敗。");
            var status = await FetchSchemaStatusAsync(root, logToUi: false);
            if (status is not null)
                UpdateSchemaStatus(status);
            MessageBox.Show(this, "資料庫結構升級完成。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
    }

    private async Task ClearTransactionsAsync()
    {
        ValidateProjectRoot();
        if (!ValidateApiEnvExists() || !await EnsureMySqlRunningAsync("清空交易資料"))
            return;
        var script = Path.Combine(_projectRoot.Text.Trim(), "database", "maintenance", "clear_transaction_data_keep_masters.sql");
        if (!File.Exists(script))
            throw new InvalidOperationException($"找不到清空腳本：\n{script}");
        var confirm = MessageBox.Show(
            this,
            "將停止 API / Nginx（保留 MySQL），清空訂單、配送、帳款、庫存異動等交易資料，"
            + "以及舊庫轉換對照中的訂單／匯款對應。\n"
            + "會保留客戶、商品、司機與使用者等主檔。\n\n此操作無法復原，確定繼續？",
            "清空交易資料",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirm != DialogResult.Yes)
            return;
        await RunMaintenanceCommandAsync("run db:clear-transactions", "交易資料已清空。");
    }

    private async Task ResetDataAsync()
    {
        ValidateProjectRoot();
        if (!ValidateApiEnvExists() || !await EnsureMySqlRunningAsync("清空全部資料"))
            return;
        var script = Path.Combine(_projectRoot.Text.Trim(), "database", "maintenance", "reset_data_keep_single_admin.sql");
        if (!File.Exists(script))
            throw new InvalidOperationException($"找不到清空腳本：\n{script}");
        var confirm = MessageBox.Show(
            this,
            "將停止 API / Nginx（保留 MySQL），清空所有業務資料與使用者。\n"
            + "完成後需執行「轉換使用者資料」才能重新登入。\n\n此操作無法復原，確定繼續？",
            "清空全部資料",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2);
        if (confirm != DialogResult.Yes)
            return;
        await RunMaintenanceCommandAsync("run db:reset", "全部業務資料已清空。");
    }

    private async Task RunMaintenanceCommandAsync(string arguments, string successMessage)
    {
        await RunBusyAsync(async () =>
        {
            await StopApplicationServicesCoreAsync();
            if (await RunNpmCommandCoreAsync(_projectRoot.Text.Trim(), arguments) != 0)
                throw new InvalidOperationException("資料維護命令失敗，請查看日誌。");
            AppendLog(successMessage);
            MessageBox.Show(this, successMessage, "資料維護", MessageBoxButtons.OK, MessageBoxIcon.Information);
        });
    }

    private void AddLegacyButton(FlowLayoutPanel panel, string title, string arguments, string confirmText)
    {
        var button = UiTheme.Button(title);
        button.Click += async (_, _) => await SafeUiActionAsync(
            () => MigrateLegacyAsync(arguments, title, confirmText));
        panel.Controls.Add(button);
        _busyControls.Add(button);
    }

    private async Task MigrateLegacyAsync(string arguments, string title, string confirmText)
    {
        ValidateProjectRoot();
        if (!ValidateApiEnvExists() || !await EnsureMySqlRunningAsync(title))
            return;
        if (MessageBox.Show(this, confirmText, title, MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            return;
        await RunMaintenanceCommandAsync(arguments, $"{title}完成，請至後台確認資料。");
    }

    private async Task CheckHealthAsync(bool force = false)
    {
        if (_closing || (!force && !_healthGate.Wait(0)))
            return;
        if (force)
            await _healthGate.WaitAsync();
        try
        {
            var mysqlTask = GetMySqlSnapshotAsync();
            var apiTask = GetApiSnapshotAsync();
            var nginxTask = GetNginxSnapshotAsync();
            var adminTask = GetEndpointSnapshotAsync(_adminUrl.Text.Trim(), "後台");
            var driverTask = GetEndpointSnapshotAsync(_driverUrl.Text.Trim(), "司機端");
            var liffTask = GetEndpointSnapshotAsync(_liffUrl.Text.Trim(), "LIFF");
            await Task.WhenAll(mysqlTask, apiTask, nginxTask, adminTask, driverTask, liffTask);
            if (_closing || IsDisposed)
                return;

            ApplySnapshot(_mysqlCard, mysqlTask.Result);
            ApplySnapshot(_apiCard, apiTask.Result);
            ApplySnapshot(_nginxCard, nginxTask.Result);
            ApplyEndpointSnapshot(_adminCard, adminTask.Result);
            ApplyEndpointSnapshot(_driverCard, driverTask.Result);
            ApplyEndpointSnapshot(_liffCard, liffTask.Result);

            var coreHealthy = new[] { mysqlTask.Result, apiTask.Result, nginxTask.Result }
                .Count(snapshot => snapshot.Health == ServiceHealth.Running);
            var endpointHealthy = new[] { adminTask.Result, driverTask.Result, liffTask.Result }
                .Count(snapshot => snapshot.Health == ServiceHealth.Running);
            if (coreHealthy == 3 && endpointHealthy == 3)
            {
                _summary.Text = "所有核心服務與網站端點皆正常";
                _summary.ForeColor = UiTheme.Success;
            }
            else if (coreHealthy == 0)
            {
                _summary.Text = "服務尚未啟動，請按「一鍵啟動服務」";
                _summary.ForeColor = UiTheme.Warning;
            }
            else
            {
                _summary.Text = $"核心服務 {coreHealthy}/3 正常 · 網站端點 {endpointHealthy}/3 正常";
                _summary.ForeColor = UiTheme.Warning;
            }
        }
        catch (Exception ex)
        {
            AppendLogWarning("狀態檢查失敗：" + ex.Message);
        }
        finally
        {
            _healthGate.Release();
        }
    }

    private async Task<ServiceSnapshot> GetMySqlSnapshotAsync()
    {
        var result = await WindowsServiceHelper.QueryAsync(GetMySqlServiceName());
        if (result.State == "RUNNING")
        {
            var tcp = await CanConnectTcpAsync("127.0.0.1", MySqlPort);
            return tcp
                ? new(ServiceHealth.Running, "運行中", $"{GetMySqlServiceName()} · TCP 3306 可連線")
                : new(ServiceHealth.Degraded, "服務運行／連線異常", $"{GetMySqlServiceName()} 已運行，但 TCP 3306 無法連線");
        }
        return result.State switch
        {
            "START_PENDING" => new(ServiceHealth.Starting, "啟動中", GetMySqlServiceName()),
            "STOP_PENDING" => new(ServiceHealth.Stopping, "停止中", GetMySqlServiceName()),
            "STOPPED" => new(ServiceHealth.Stopped, "已停止", GetMySqlServiceName()),
            _ => new(ServiceHealth.Error, "無法查詢", Compact(result.Output))
        };
    }

    private async Task<ServiceSnapshot> GetApiSnapshotAsync()
    {
        try
        {
            using var response = await _http.GetAsync("http://localhost:3000/api/health");
            return response.IsSuccessStatusCode
                ? new(ServiceHealth.Running, "正常", $"localhost:3000 · HTTP {(int)response.StatusCode}")
                : new(ServiceHealth.Degraded, "回應異常", $"HTTP {(int)response.StatusCode}");
        }
        catch
        {
            return PortHelper.IsPortListening(ApiPort)
                ? new(ServiceHealth.Degraded, "連接埠已開／健康檢查失敗", "localhost:3000/api/health")
                : new(ServiceHealth.Stopped, "已停止", "localhost:3000 未監聽");
        }
    }

    private async Task<ServiceSnapshot> GetNginxSnapshotAsync()
    {
        var port = GetHttpPort();
        var listening = PortHelper.IsPortListening(port);
        var nginx = listening && PortHelper.IsPortUsedByProcess(port, "nginx");
        if (!nginx)
            return listening
                ? new(ServiceHealth.Error, "連接埠被占用", $"埠 {port} 非 nginx.exe")
                : new(ServiceHealth.Stopped, "已停止", $"HTTP 埠 {port} 未監聽");
        try
        {
            using var response = await _http.GetAsync(GetNginxProbeUrl());
            return response.IsSuccessStatusCode
                ? new(ServiceHealth.Running, "正常", $"nginx.exe · HTTP {(int)response.StatusCode}")
                : new(ServiceHealth.Degraded, "回應異常", $"nginx.exe · HTTP {(int)response.StatusCode}");
        }
        catch
        {
            return new(ServiceHealth.Degraded, "行程運行／HTTP 失敗", $"nginx.exe · 埠 {port}");
        }
    }

    private async Task<ServiceSnapshot> GetEndpointSnapshotAsync(string url, string name)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return new(ServiceHealth.Error, "URL 無效", url);
        try
        {
            using var response = await _http.GetAsync(uri);
            return response.IsSuccessStatusCode
                ? new(ServiceHealth.Running, "可用", $"HTTP {(int)response.StatusCode} · 共用 Nginx")
                : new(ServiceHealth.Degraded, "異常", $"HTTP {(int)response.StatusCode} · 共用 Nginx");
        }
        catch (Exception ex)
        {
            return new(ServiceHealth.Error, "無法連線", $"{name} · {Compact(ex.Message)}");
        }
    }

    private static async Task<bool> CanConnectTcpAsync(string host, int port)
    {
        try
        {
            using var client = new TcpClient();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await client.ConnectAsync(host, port, cts.Token);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void ApplySnapshot(ServiceCard card, ServiceSnapshot snapshot)
    {
        var color = UiTheme.HealthColor(snapshot.Health);
        card.Dot.ForeColor = color;
        card.Status.Text = snapshot.Status;
        card.Status.ForeColor = color;
        card.Detail.Text = snapshot.Detail;
        card.Start.Enabled = !_uiBusy && snapshot.Health is not ServiceHealth.Running and not ServiceHealth.Starting;
        card.Stop.Enabled = !_uiBusy && snapshot.Health is ServiceHealth.Running or ServiceHealth.Degraded;
    }

    private static void ApplyEndpointSnapshot(EndpointCard card, ServiceSnapshot snapshot)
    {
        var color = UiTheme.HealthColor(snapshot.Health);
        card.Dot.ForeColor = color;
        card.Status.Text = snapshot.Status;
        card.Status.ForeColor = color;
        card.Detail.Text = snapshot.Detail;
    }

    private bool TryStartNginx()
    {
        var nginxExe = GetNginxExePath();
        if (nginxExe is null)
            throw new InvalidOperationException("找不到 nginx.exe，請確認 Nginx 目錄設定。");
        var port = GetHttpPort();
        if (PortHelper.IsPortListening(port))
        {
            if (!PortHelper.IsPortUsedByProcess(port, "nginx"))
                throw new InvalidOperationException($"埠 {port} 已由其他行程占用：\n{DescribePortBlockers(port)}");
            AppendLog("Nginx 已運行，正在重新載入設定…");
            if (!TryRunNginxCommand("-s reload", out var reloadOutput))
                throw new InvalidOperationException("Nginx reload 失敗：\n" + reloadOutput);
            return true;
        }
        if (!TryRunNginxCommand("-t", out var testOutput))
            throw new InvalidOperationException("Nginx 設定檢查失敗：\n" + testOutput);
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = nginxExe,
            WorkingDirectory = Path.GetDirectoryName(nginxExe)!,
            UseShellExecute = false,
            CreateNoWindow = true
        });
        process?.Dispose();
        Thread.Sleep(800);
        if (!PortHelper.IsPortListening(port))
            throw new InvalidOperationException($"Nginx 已執行但埠 {port} 未開始監聽。");
        AppendLog($"已啟動 Nginx：{nginxExe}");
        return true;
    }

    private void StopNginxCore(Action<string>? log)
    {
        var port = GetHttpPort();
        if (!PortHelper.IsPortListening(port) || !PortHelper.IsPortUsedByProcess(port, "nginx"))
        {
            return;
        }
        TryRunNginxCommand("-s quit", out var output);
        if (!string.IsNullOrWhiteSpace(output))
            log?.Invoke("[Nginx] " + output.Trim());
        Thread.Sleep(600);
        if (PortHelper.IsPortListening(port) && PortHelper.IsPortUsedByProcess(port, "nginx"))
            PortHelper.ReleasePortForNginx(port, log);
        if (PortHelper.IsPortListening(port) && PortHelper.IsPortUsedByProcess(port, "nginx"))
            PortHelper.ForceStopAllNginx(log);
    }

    private bool TryRunNginxCommand(string arguments, out string output)
    {
        output = "";
        var nginx = GetNginxExePath();
        if (nginx is null)
            return false;
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = nginx,
                Arguments = arguments,
                WorkingDirectory = Path.GetDirectoryName(nginx)!,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            using var process = Process.Start(startInfo);
            if (process is null)
                return false;
            output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit(10000);
            return process.HasExited && process.ExitCode == 0;
        }
        catch (Exception ex)
        {
            output = ex.Message;
            return false;
        }
    }

    private async Task GenerateNginxConfigAsync(string root)
    {
        var script = Path.Combine(root, "deploy", "scripts", "generate-nginx-config.ps1");
        if (!File.Exists(script))
        {
            AppendLogWarning("找不到 generate-nginx-config.ps1，略過產生 Nginx 設定。");
            return;
        }
        AppendLog("正在產生 Nginx 設定…");
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell",
            Arguments = $"-ExecutionPolicy Bypass -File \"{script}\" -ProjectRoot \"{root}\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("無法啟動 PowerShell。");
        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (!string.IsNullOrWhiteSpace(stdout))
            AppendLog(stdout.TrimEnd());
        if (!string.IsNullOrWhiteSpace(stderr))
            AppendLogWarning(stderr.TrimEnd());
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"產生 Nginx 設定失敗（結束代碼 {process.ExitCode}）。");
    }

    private async Task<int?> RunGitCommandCoreAsync(string workingDirectory, string arguments)
    {
        var git = FindExecutable("git.exe");
        if (git is null)
            throw new InvalidOperationException("找不到 git.exe，請安裝 Git 並加入 PATH。");
        return await RunCommandAsync(git, arguments, workingDirectory, "git");
    }

    private async Task<int?> RunNpmCommandCoreAsync(string workingDirectory, string arguments)
    {
        var node = FindExecutable("node.exe");
        if (node is null)
            throw new InvalidOperationException("找不到 node.exe。");
        var npm = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!File.Exists(npm))
            throw new InvalidOperationException("找不到 npm.cmd。");
        return await RunCommandAsync(npm, arguments, workingDirectory, "npm");
    }

    private async Task<int> RunCommandAsync(string file, string arguments, string workingDirectory, string displayName)
    {
        AppendLog($"> \"{workingDirectory}\" {displayName} {arguments}");
        var startInfo = new ProcessStartInfo
        {
            FileName = file,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using var process = new Process { StartInfo = startInfo };
        process.Start();
        var stdoutTask = PumpReaderAsync(process.StandardOutput, AppendLog);
        var stderrTask = PumpReaderAsync(process.StandardError, AppendLogWarning);
        await process.WaitForExitAsync();
        await Task.WhenAll(stdoutTask, stderrTask);
        AppendLog(process.ExitCode == 0 ? "命令完成（成功）。" : $"命令失敗（結束代碼 {process.ExitCode}）。");
        return process.ExitCode;
    }

    private static async Task PumpReaderAsync(StreamReader reader, Action<string> sink)
    {
        while (await reader.ReadLineAsync() is { } line)
            sink(line);
    }

    private async Task<SchemaMigrationStatus?> FetchSchemaStatusAsync(string root, bool logToUi)
    {
        var node = FindExecutable("node.exe");
        if (node is null)
            return null;
        var npm = Path.Combine(Path.GetDirectoryName(node)!, "npm.cmd");
        if (!File.Exists(npm))
            return null;
        var startInfo = new ProcessStartInfo
        {
            FileName = npm,
            Arguments = "run db:schema-status",
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using var process = Process.Start(startInfo);
        if (process is null)
            return null;
        var stdout = await process.StandardOutput.ReadToEndAsync();
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (logToUi)
        {
            if (!string.IsNullOrWhiteSpace(stdout))
                AppendLog(stdout.TrimEnd());
            if (!string.IsNullOrWhiteSpace(stderr))
                AppendLogWarning(stderr.TrimEnd());
        }
        if (process.ExitCode != 0)
            return null;
        return ParseSchemaStatus(stdout + "\n" + stderr);
    }

    private static SchemaMigrationStatus? ParseSchemaStatus(string output)
    {
        foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Reverse())
        {
            if (!line.StartsWith('{'))
                continue;
            try { return JsonSerializer.Deserialize<SchemaMigrationStatus>(line); }
            catch (JsonException) { }
        }
        return null;
    }

    private async Task CheckSchemaQuietlyAsync()
    {
        try
        {
            if (!ValidateApiEnvExists(showMessage: false))
                return;
            var status = await FetchSchemaStatusAsync(_projectRoot.Text.Trim(), logToUi: false);
            if (status is not null)
                UpdateSchemaStatus(status);
        }
        catch
        {
            // 啟動時的背景檢查不干擾使用者。
        }
    }

    private void UpdateSchemaStatus(SchemaMigrationStatus status)
    {
        if (!status.ok)
        {
            _schemaStatus.Text = "結構：檢查失敗";
            _schemaStatus.ForeColor = UiTheme.Danger;
        }
        else if (status.pending.Length == 0)
        {
            _schemaStatus.Text = $"結構：已是最新（已套用 {status.applied.Length} 支）";
            _schemaStatus.ForeColor = UiTheme.Success;
        }
        else
        {
            _schemaStatus.Text = $"結構：待升級 {status.pending.Length} 支";
            _schemaStatus.ForeColor = UiTheme.Warning;
        }
    }

    private async Task RefreshGitStatusAsync(bool fetch, bool logResult)
    {
        if (_closing || IsDisposed)
            return;
        if (!await _gitGate.WaitAsync(0))
            return;
        try
        {
            ScheduleOnUiThread(() =>
            {
                _gitHeadline.Text = fetch ? "正在向 GitHub 檢查同步…" : "正在檢查本機 Git 狀態…";
                _gitHeadline.ForeColor = UiTheme.Muted;
                _gitDot.ForeColor = UiTheme.Unknown;
            });
            var root = _projectRoot.Text.Trim();
            var snapshot = await GitStatusHelper.QueryAsync(root, GetGitBranch(), fetch);
            if (_closing || IsDisposed)
                return;
            ApplyGitSnapshot(snapshot);
            if (logResult)
            {
                AppendLog($"Git：{snapshot.Headline}");
                if (!string.IsNullOrWhiteSpace(snapshot.Detail))
                    AppendLog(snapshot.Detail.Replace('\n', ' '));
            }
        }
        catch (Exception ex)
        {
            ApplyGitSnapshot(new GitStatusSnapshot
            {
                Headline = "Git 檢查失敗",
                Detail = ex.Message,
                Hint = "請確認已安裝 Git，且專案根目錄正確。",
                Accent = UiTheme.Danger
            });
            if (logResult)
                AppendLogWarning("Git 檢查失敗：" + ex.Message);
        }
        finally
        {
            _gitGate.Release();
        }
    }

    private void ApplyGitSnapshot(GitStatusSnapshot snapshot)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ApplyGitSnapshot(snapshot));
            return;
        }
        _gitDot.ForeColor = snapshot.Accent;
        _gitHeadline.Text = snapshot.Headline;
        _gitHeadline.ForeColor = snapshot.Accent;
        _gitDetail.Text = snapshot.Detail;
        _gitHint.Text = snapshot.Hint;
        _deployButton.Text = snapshot.Behind > 0
            ? $"更新並部署（落後 {snapshot.Behind} 筆）"
            : "更新並部署";
    }

    private void ShowLineProductionCheck(bool requireBuiltDist)
    {
        ValidateProjectRoot();
        var check = LineProductionHelper.Check(_projectRoot.Text.Trim(), _liffUrl.Text.Trim(), requireBuiltDist);
        foreach (var error in check.Errors)
            AppendLogWarning("LINE：" + error);
        foreach (var warning in check.Warnings)
            AppendLogWarning("LINE：" + warning);
        MessageBox.Show(this, check.FormatMessage(), "LINE 正式設定",
            MessageBoxButtons.OK, check.Ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
    }

    private bool ConfirmLineProductionReady(bool requireBuiltDist, string actionLabel)
    {
        var check = LineProductionHelper.Check(_projectRoot.Text.Trim(), _liffUrl.Text.Trim(), requireBuiltDist);
        if (check.Ok)
            return true;
        foreach (var error in check.Errors)
            AppendLogWarning("LINE：" + error);
        return MessageBox.Show(
            this,
            check.FormatMessage() + $"\n\n若此次「{actionLabel}」暫不提供 LINE 功能，可選「是」繼續。是否繼續？",
            "LINE 正式設定未完成",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2) == DialogResult.Yes;
    }

    private async Task RunBusyAsync(Func<Task> action)
    {
        if (_uiBusy)
            return;
        SetBusy(true);
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            AppendLogWarning(ex.Message);
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            SetBusy(false);
            await CheckHealthAsync(force: true);
        }
    }

    private async Task SafeUiActionAsync(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (Exception ex)
        {
            AppendLogWarning(ex.Message);
            MessageBox.Show(this, ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void SetBusy(bool busy)
    {
        _uiBusy = busy;
        foreach (var control in _busyControls)
            control.Enabled = !busy;
        _refreshButton.Enabled = !busy;
        Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
    }

    private void SaveSettingsFromUi()
    {
        new LauncherSettings
        {
            ProjectRoot = _projectRoot.Text.Trim(),
            NginxRoot = _nginxRoot.Text.Trim(),
            MySqlServiceName = GetMySqlServiceName(),
            ApiBaseUrl = _apiBaseUrl.Text.Trim(),
            AdminUrl = _adminUrl.Text.Trim(),
            DriverUrl = _driverUrl.Text.Trim(),
            LiffUrl = _liffUrl.Text.Trim(),
            GitBranch = GetGitBranch()
        }.Save();
    }

    private void ValidateProjectRoot()
    {
        var root = _projectRoot.Text.Trim();
        if (root.Length == 0 || !File.Exists(Path.Combine(root, "package.json")))
            throw new InvalidOperationException("請在設定頁指定包含 package.json 的專案根目錄。");
    }

    private void ValidateProductionOutputs(bool includeApi)
    {
        var root = _projectRoot.Text.Trim();
        var outputs = new List<string>
        {
            Path.Combine(root, "apps", "web-admin", "dist", "index.html"),
            Path.Combine(root, "apps", "web-driver", "dist", "index.html"),
            Path.Combine(root, "apps", "web-liff", "dist", "index.html")
        };
        if (includeApi)
            outputs.Add(Path.Combine(root, "apps", "api", "dist", "index.js"));
        var missing = outputs.Where(path => !File.Exists(path)).ToArray();
        if (missing.Length > 0)
            throw new InvalidOperationException(
                "缺少正式建置產物，請先執行「建置正式版」：\n" + string.Join("\n", missing));
    }

    private void ValidateGitRepo()
    {
        if (!Directory.Exists(Path.Combine(_projectRoot.Text.Trim(), ".git")))
            throw new InvalidOperationException("專案根目錄不是 Git 倉庫。");
    }

    private bool ValidateApiEnvExists(bool showMessage = true)
    {
        var exists = File.Exists(Path.Combine(_projectRoot.Text.Trim(), "apps", "api", ".env"));
        if (!exists && showMessage)
            MessageBox.Show(this, "找不到 apps\\api\\.env，無法連線資料庫。", Text,
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return exists;
    }

    private string GetMySqlServiceName()
    {
        var name = _mysqlServiceName.Text.Trim();
        return name.Length == 0 ? "MySQL80" : name;
    }

    private string GetGitBranch()
    {
        var branch = _gitBranch.Text.Trim();
        if (branch.Length == 0)
            return "main";
        if (branch.Contains('"') || branch.Contains('\r') || branch.Contains('\n'))
            throw new InvalidOperationException("Git 分支名稱含有無效字元。");
        return branch;
    }

    private int GetHttpPort() => PortHelper.ParsePortFromUrl(_apiBaseUrl.Text.Trim(), 80);

    private string GetNginxProbeUrl() => $"http://localhost:{GetHttpPort()}/";

    private string? GetNginxExePath()
    {
        var path = Path.Combine(_nginxRoot.Text.Trim(), "nginx.exe");
        return File.Exists(path) ? path : null;
    }

    private void NormalizeProductionUrls()
    {
        var values = new[] { _apiBaseUrl, _adminUrl, _driverUrl, _liffUrl };
        var needsFix = values.Any(box =>
            box.Text.Contains("localhost", StringComparison.OrdinalIgnoreCase)
            || box.Text.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || PortHelper.ParsePortFromUrl(box.Text, 80) is 3000 or 5173 or 5174 or 5175);
        if (!needsFix)
            return;
        var host = GetUrlHost(_apiBaseUrl.Text, DefaultPublicHost);
        _apiBaseUrl.Text = $"http://{host}";
        _adminUrl.Text = $"http://{host}/";
        _driverUrl.Text = $"http://{host}/driver/";
        _liffUrl.Text = $"http://{host}/liff/";
    }

    private static string GetUrlHost(string url, string fallback)
    {
        try
        {
            if (!url.Contains("://", StringComparison.Ordinal))
                url = "http://" + url;
            return new Uri(url).Host;
        }
        catch
        {
            return fallback;
        }
    }

    private static string? FindExecutable(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path))
            return null;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim().Trim('"'), name);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private static string DescribePortBlockers(int port)
    {
        var lines = new List<string>();
        foreach (var pid in PortHelper.GetListenerProcessIds(port))
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                lines.Add($"PID {pid}：{process.ProcessName}.exe");
            }
            catch { lines.Add($"PID {pid}"); }
        }
        return lines.Count == 0 ? "無法列出占用行程" : string.Join("\n", lines);
    }

    private void ShowServiceError(string title, WindowsServiceResult result)
    {
        var hint = result.AccessDenied
            ? "\n\n權限不足：請以系統管理員身分執行啟動器。"
            : "\n\n請確認設定頁中的 Windows Service 名稱正確。";
        AppendLogWarning($"{title}：{Compact(result.Output)}");
        MessageBox.Show(this, title + "\n\n" + result.Output + hint, Text,
            MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void OnApiOutput(object sender, DataReceivedEventArgs e)
    {
        if (e.Data is not null)
            AppendLog("[API] " + e.Data);
    }

    private void OnApiError(object sender, DataReceivedEventArgs e)
    {
        if (e.Data is not null)
            AppendLogWarning("[API] " + e.Data);
    }

    private void OnApiExited(object? sender, EventArgs e)
    {
        if (_closing)
            return;
        ScheduleOnUiThread(() =>
        {
            if (sender is not Process process || !ReferenceEquals(process, _apiProcess))
                return;
            DetachApiEvents();
            _apiProcess?.Dispose();
            _apiProcess = null;
            AppendLogWarning("API 行程已結束。");
            _ = CheckHealthAsync(force: true);
        });
    }

    private void DetachApiEvents()
    {
        if (_apiProcess is null)
            return;
        _apiProcess.OutputDataReceived -= OnApiOutput;
        _apiProcess.ErrorDataReceived -= OnApiError;
        _apiProcess.Exited -= OnApiExited;
    }

    private static void TryKillAndDisposeApi(Process? process)
    {
        if (process is null)
            return;
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            process.WaitForExit(10000);
        }
        catch { }
        try { process.Dispose(); } catch { }
    }

    private void AppendLog(string line) => AppendColoredLog(line, null);
    private void AppendLogWarning(string line) => AppendColoredLog(line, Color.FromArgb(251, 191, 36));

    private void AppendColoredLog(string line, Color? color)
    {
        if (_closing || IsDisposed)
            return;
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendColoredLog(line, color));
            return;
        }
        var normalized = line.Replace("\r\n", "\n").TrimEnd();
        if (normalized.Length == 0)
            return;
        var stamp = DateTime.Now.ToString("HH:mm:ss");
        var previous = _log.SelectionColor;
        if (color.HasValue)
            _log.SelectionColor = color.Value;
        _log.AppendText($"[{stamp}] {normalized}\n");
        _log.SelectionColor = previous;
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
        _recentLog.Text = $"[{stamp}] {normalized.Replace('\n', ' ')}";
    }

    private void ScheduleOnUiThread(Action action)
    {
        if (_closing || IsDisposed)
            return;
        if (InvokeRequired)
            BeginInvoke(action);
        else
            action();
    }

    private static string Compact(string value)
    {
        var text = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return text.Length <= 120 ? text : text[..117] + "…";
    }

    private static void OpenUrl(string url)
    {
        if (Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri))
            Process.Start(new ProcessStartInfo { FileName = uri.ToString(), UseShellExecute = true });
    }

    private void BrowseFolder(TextBox target, string description)
    {
        using var dialog = new FolderBrowserDialog
        {
            InitialDirectory = Directory.Exists(target.Text) ? target.Text : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            UseDescriptionForTitle = true,
            Description = description
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
            target.Text = dialog.SelectedPath;
    }

    private static TabPage NewTab(string text) => new(text) { BackColor = UiTheme.Background };

    private static Panel NewScrollPanel() => new()
    {
        Dock = DockStyle.Fill,
        AutoScroll = true,
        BackColor = UiTheme.Background,
        Padding = new Padding(20)
    };

    private static TableLayoutPanel NewContentTable(int rows)
    {
        var table = new TableLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            ColumnCount = 1,
            RowCount = rows,
            BackColor = UiTheme.Background,
            Margin = Padding.Empty
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return table;
    }

    private static void AddContentRow(TableLayoutPanel table, Control control)
    {
        control.Dock = DockStyle.Fill;
        table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        table.Controls.Add(control, 0, table.Controls.Count);
    }

    private static Control PageHeader(string title, string subtitle)
    {
        var panel = new Panel { Height = 74, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 12) };
        panel.Controls.Add(new Label
        {
            Text = subtitle,
            AutoSize = true,
            Location = new Point(2, 43),
            ForeColor = UiTheme.Muted
        });
        panel.Controls.Add(UiTheme.Heading(title));
        return panel;
    }

    private static Control SectionTitle(string title, string subtitle)
    {
        var panel = new Panel { Height = 58, Dock = DockStyle.Fill, Margin = new Padding(0, 8, 0, 2) };
        panel.Controls.Add(new Label
        {
            Text = subtitle,
            AutoSize = true,
            Location = new Point(2, 31),
            ForeColor = UiTheme.Muted
        });
        panel.Controls.Add(new Label
        {
            Text = title,
            AutoSize = true,
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            ForeColor = UiTheme.Text
        });
        return panel;
    }

    private static Panel BuildToolCard(string title, string description, Control actions, Control? footer = null)
    {
        var card = UiTheme.Card();
        card.Dock = DockStyle.Fill;
        card.AutoSize = true;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 1 };
        layout.Controls.Add(new Label
        {
            Text = title,
            AutoSize = true,
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            ForeColor = UiTheme.Text
        });
        layout.Controls.Add(new Label
        {
            Text = description,
            AutoSize = true,
            MaximumSize = new Size(900, 0),
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 6, 0, 8)
        });
        actions.Dock = DockStyle.Fill;
        layout.Controls.Add(actions);
        if (footer is not null)
        {
            footer.Margin = new Padding(0, 10, 0, 0);
            layout.Controls.Add(footer);
        }
        card.Controls.Add(layout);
        return card;
    }

    private static FlowLayoutPanel NewButtonRow(params Control[] controls)
    {
        var panel = new FlowLayoutPanel
        {
            AutoSize = true,
            WrapContents = true,
            FlowDirection = FlowDirection.LeftToRight,
            Margin = Padding.Empty
        };
        panel.Controls.AddRange(controls);
        return panel;
    }

    private static void AddSettingRow(TableLayoutPanel form, int row, string label, TextBox input, Button? suffix)
    {
        form.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        form.Controls.Add(new Label
        {
            Text = label,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = UiTheme.Text,
            Margin = new Padding(0, 12, 12, 12)
        }, 0, row);
        input.Dock = DockStyle.Fill;
        input.Margin = new Padding(0, 7, 8, 7);
        form.Controls.Add(input, 1, row);
        if (suffix is not null)
            form.Controls.Add(suffix, 2, row);
        else
            form.SetColumnSpan(input, 2);
    }

    private static ServiceCard CreateServiceCard(string name, string subtitle)
    {
        var root = UiTheme.Card();
        root.Dock = DockStyle.Fill;
        root.Height = 176;
        var title = new Label
        {
            Text = name,
            AutoSize = true,
            Font = new Font("Segoe UI", 13f, FontStyle.Bold),
            ForeColor = UiTheme.Text,
            Location = new Point(18, 16)
        };
        var type = new Label { Text = subtitle, AutoSize = true, ForeColor = UiTheme.Muted, Location = new Point(19, 45) };
        var dot = new Label
        {
            Text = "●",
            AutoSize = true,
            ForeColor = UiTheme.Unknown,
            Font = new Font("Segoe UI", 13f),
            Location = new Point(18, 72)
        };
        var status = new Label
        {
            Text = "尚未檢查",
            AutoSize = true,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            ForeColor = UiTheme.Unknown,
            Location = new Point(43, 75)
        };
        var detail = new Label
        {
            Text = "等待狀態更新",
            AutoEllipsis = true,
            ForeColor = UiTheme.Muted,
            Location = new Point(20, 103),
            Size = new Size(290, 22),
            Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top
        };
        var start = UiTheme.Button("啟動");
        start.Location = new Point(18, 132);
        start.MinimumSize = new Size(86, 32);
        var stop = UiTheme.Button("停止");
        stop.Location = new Point(112, 132);
        stop.MinimumSize = new Size(86, 32);
        root.Controls.AddRange([title, type, dot, status, detail, start, stop]);
        return new ServiceCard { Root = root, Dot = dot, Status = status, Detail = detail, Start = start, Stop = stop };
    }

    private static EndpointCard CreateEndpointCard(string name)
    {
        var root = UiTheme.Card();
        root.Dock = DockStyle.Fill;
        root.Height = 145;
        var title = new Label
        {
            Text = name,
            AutoSize = true,
            Font = new Font("Segoe UI", 12f, FontStyle.Bold),
            ForeColor = UiTheme.Text,
            Location = new Point(18, 15)
        };
        var dot = new Label { Text = "●", AutoSize = true, ForeColor = UiTheme.Unknown, Location = new Point(18, 48) };
        var status = new Label { Text = "尚未檢查", AutoSize = true, ForeColor = UiTheme.Unknown, Location = new Point(39, 48) };
        var detail = new Label
        {
            Text = "由共用 Nginx 提供",
            AutoEllipsis = true,
            ForeColor = UiTheme.Muted,
            Location = new Point(18, 73),
            Size = new Size(290, 20)
        };
        var open = UiTheme.Button("開啟網站");
        open.Location = new Point(18, 100);
        root.Controls.AddRange([title, dot, status, detail, open]);
        return new EndpointCard { Root = root, Dot = dot, Status = status, Detail = detail, Open = open };
    }

    private static string MigrateZonesConfirmText() =>
        "將從舊庫 database.area 匯入 address_zones，並依 customer.area_id 重連客戶區域。\n舊庫只讀。確定繼續？";
    private static string MigrateCompaniesConfirmText() =>
        "將從舊庫 customer.company 匯入 affiliated_companies，並重建新庫隸屬公司。\n舊庫只讀。確定繼續？";
    private static string MigrateCustomersConfirmText() =>
        "將從舊庫 customer 匯入 customers 與 delivery_addresses。\n請先轉換地址分區及隸屬公司。舊庫只讀。確定繼續？";
    private static string MigrateUsersConfirmText() =>
        "將重建 users / drivers，建立系統管理員後匯入舊庫 personnel_list。\n舊庫只讀。確定繼續？";
    private static string MigrateDriversConfirmText() =>
        "將重建司機帳號並從舊庫 driver 匯入，預設密碼為 888888。\n舊庫只讀。確定繼續？";
    private static string MigrateProductsConfirmText() =>
        "將重建 products 與庫存並匯入舊庫實體商品；已有單據時會拒絕執行。\n舊庫只讀。確定繼續？";

    private sealed class SchemaMigrationStatus
    {
        public bool ok { get; set; }
        public string[] applied { get; set; } = [];
        public string[] pending { get; set; } = [];
        public string? message { get; set; }
    }
}
