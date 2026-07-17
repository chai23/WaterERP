namespace WaterErpLauncher;

internal enum ServiceHealth
{
    Unknown,
    Starting,
    Running,
    Stopping,
    Stopped,
    Degraded,
    Error
}

internal sealed record ServiceSnapshot(ServiceHealth Health, string Status, string Detail)
{
    public static ServiceSnapshot Unknown(string detail = "尚未檢查") =>
        new(ServiceHealth.Unknown, "未知", detail);
}

internal sealed class ServiceCard
{
    public required Panel Root { get; init; }
    public required Label Dot { get; init; }
    public required Label Status { get; init; }
    public required Label Detail { get; init; }
    public required Button Start { get; init; }
    public required Button Stop { get; init; }
}

internal sealed class EndpointCard
{
    public required Panel Root { get; init; }
    public required Label Dot { get; init; }
    public required Label Status { get; init; }
    public required Label Detail { get; init; }
    public required Button Open { get; init; }
}
