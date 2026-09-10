namespace WaterErpLauncher;

internal static class UiTheme
{
    public static readonly Color Background = Color.FromArgb(244, 247, 251);
    public static readonly Color Surface = Color.White;
    public static readonly Color Primary = Color.FromArgb(29, 78, 216);
    public static readonly Color PrimaryDark = Color.FromArgb(30, 64, 175);
    public static readonly Color Text = Color.FromArgb(30, 41, 59);
    public static readonly Color Muted = Color.FromArgb(100, 116, 139);
    public static readonly Color Border = Color.FromArgb(226, 232, 240);
    public static readonly Color Success = Color.FromArgb(22, 163, 74);
    public static readonly Color Warning = Color.FromArgb(217, 119, 6);
    public static readonly Color Danger = Color.FromArgb(220, 38, 38);
    public static readonly Color Unknown = Color.FromArgb(148, 163, 184);

    public static Button Button(string text, bool primary = false, bool danger = false, bool success = false, bool large = false)
    {
        var back = danger ? Danger : success ? Success : primary ? Primary : Surface;
        var hover = danger
            ? Color.FromArgb(185, 28, 28)
            : success ? Color.FromArgb(21, 128, 61)
            : primary ? PrimaryDark
            : Color.FromArgb(248, 250, 252);
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            MinimumSize = large ? new Size(156, 42) : new Size(96, 36),
            Padding = new Padding(large ? 16 : 12, 4, large ? 16 : 12, 4),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            BackColor = back,
            ForeColor = danger || primary || success ? Color.White : Text
        };
        button.FlatAppearance.BorderColor = back;
        button.FlatAppearance.MouseOverBackColor = hover;
        return button;
    }

    public static Label Heading(string text, float size = 18f) => new()
    {
        Text = text,
        AutoSize = true,
        Font = new Font("Segoe UI", size, FontStyle.Bold),
        ForeColor = Text
    };

    public static Panel Card()
    {
        var panel = new Panel
        {
            BackColor = Surface,
            Padding = new Padding(18),
            Margin = new Padding(0, 0, 14, 14)
        };
        panel.Paint += (_, e) =>
        {
            var rectangle = panel.ClientRectangle;
            rectangle.Width -= 1;
            rectangle.Height -= 1;
            using var pen = new Pen(Border);
            e.Graphics.DrawRectangle(pen, rectangle);
        };
        return panel;
    }

    public static Color HealthColor(ServiceHealth health) => health switch
    {
        ServiceHealth.Running => Success,
        ServiceHealth.Starting or ServiceHealth.Stopping or ServiceHealth.Degraded => Warning,
        ServiceHealth.Error => Danger,
        _ => Unknown
    };
}
