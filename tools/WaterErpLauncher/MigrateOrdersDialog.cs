namespace WaterErpLauncher;

/// <summary>舊庫訂單轉換參數對話框（客戶／時段／完成狀態）。直接寫入，無預覽。</summary>
internal sealed class MigrateOrdersDialog : Form
{
    private readonly TextBox _customer = new() { Width = 220 };
    private readonly CheckBox _useFrom = new() { Text = "啟用起始日", AutoSize = true };
    private readonly CheckBox _useTo = new() { Text = "啟用結束日", AutoSize = true };
    private readonly DateTimePicker _from = new()
    {
        Format = DateTimePickerFormat.Custom,
        CustomFormat = "yyyy-MM-dd",
        Width = 140,
        Enabled = false
    };
    private readonly DateTimePicker _to = new()
    {
        Format = DateTimePickerFormat.Custom,
        CustomFormat = "yyyy-MM-dd",
        Width = 140,
        Enabled = false
    };
    private readonly ComboBox _completion = new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        Width = 220
    };

    public string? CustomerCode => string.IsNullOrWhiteSpace(_customer.Text) ? null : _customer.Text.Trim();
    public string? FromDate => _useFrom.Checked ? _from.Value.ToString("yyyy-MM-dd") : null;
    public string? ToDate => _useTo.Checked ? _to.Value.ToString("yyyy-MM-dd") : null;
    public string CompletionMode => _completion.SelectedItem switch
    {
        "僅已完成訂單" => "completed",
        "僅未完成訂單" => "incomplete",
        _ => "all"
    };

    public MigrateOrdersDialog()
    {
        Text = "轉換訂單資料";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        Font = new Font("Segoe UI", 9.5f);
        ClientSize = new Size(460, 360);
        BackColor = UiTheme.Surface;

        _completion.Items.AddRange(new object[] { "全部", "僅已完成訂單", "僅未完成訂單" });
        _completion.SelectedIndex = 1; // 建議先轉已完成

        _useFrom.CheckedChanged += (_, _) => _from.Enabled = _useFrom.Checked;
        _useTo.CheckedChanged += (_, _) => _to.Enabled = _useTo.Checked;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 7,
            Padding = new Padding(20),
            AutoSize = true
        };
        for (var i = 0; i < 5; i++)
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        root.Controls.Add(Hint(
            "方案 B：寫入訂單＋AR＋匯款沖帳（直接寫入本機 water_erp）。\n" +
            "建議：先「僅已完成」再「僅未完成」；可限客戶／時段。\n" +
            "若要重轉，請先「清空交易資料」。過程請看「日誌」。舊庫唯讀。"), 0, 0);

        root.Controls.Add(Labeled("客戶代號（空白＝全部）", _customer), 0, 1);

        var fromRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        fromRow.Controls.Add(_useFrom);
        fromRow.Controls.Add(_from);
        root.Controls.Add(Labeled("出貨日起（order_day）", fromRow), 0, 2);

        var toRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        toRow.Controls.Add(_useTo);
        toRow.Controls.Add(_to);
        root.Controls.Add(Labeled("出貨日迄（order_day）", toRow), 0, 3);

        root.Controls.Add(Labeled("完成狀態", _completion), 0, 4);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            Padding = new Padding(0, 12, 0, 0)
        };
        var ok = UiTheme.Button("開始轉換", primary: true);
        var cancel = UiTheme.Button("取消");
        ok.DialogResult = DialogResult.OK;
        cancel.DialogResult = DialogResult.Cancel;
        buttons.Controls.Add(ok);
        buttons.Controls.Add(cancel);
        root.Controls.Add(buttons, 0, 6);

        Controls.Add(root);
        AcceptButton = ok;
        CancelButton = cancel;
    }

    /// <summary>組出 npm 參數：run db:migrate-orders -- --flags…</summary>
    public string BuildNpmArguments()
    {
        var parts = new List<string> { "run", "db:migrate-orders", "--" };
        if (CustomerCode is not null)
        {
            parts.Add("--customer");
            parts.Add(CustomerCode);
        }
        if (FromDate is not null)
        {
            parts.Add("--from");
            parts.Add(FromDate);
        }
        if (ToDate is not null)
        {
            parts.Add("--to");
            parts.Add(ToDate);
        }
        parts.Add("--completion");
        parts.Add(CompletionMode);
        return string.Join(" ", parts.Select(QuoteIfNeeded));
    }

    public string SummaryText()
    {
        var bits = new List<string>
        {
            "正式寫入",
            CustomerCode is null ? "全部客戶" : $"客戶 {CustomerCode}",
            FromDate is null && ToDate is null
                ? "不限日期"
                : $"日期 {FromDate ?? "…"}～{ToDate ?? "…"}",
            CompletionMode switch
            {
                "completed" => "僅已完成",
                "incomplete" => "僅未完成",
                _ => "全部狀態"
            }
        };
        return string.Join("；", bits);
    }

    private static string QuoteIfNeeded(string value) =>
        value.Contains(' ') || value.Contains('"') ? $"\"{value.Replace("\"", "\\\"")}\"" : value;

    private static Control Labeled(string title, Control child)
    {
        var panel = new TableLayoutPanel
        {
            ColumnCount = 1,
            RowCount = 2,
            AutoSize = true,
            Dock = DockStyle.Top,
            Margin = new Padding(0, 8, 0, 0)
        };
        panel.Controls.Add(new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = UiTheme.Muted,
            Margin = new Padding(0, 0, 0, 4)
        }, 0, 0);
        panel.Controls.Add(child, 0, 1);
        return panel;
    }

    private static Label Hint(string text) => new()
    {
        Text = text,
        AutoSize = true,
        MaximumSize = new Size(400, 0),
        ForeColor = UiTheme.Muted,
        Margin = new Padding(0, 0, 0, 8)
    };
}
