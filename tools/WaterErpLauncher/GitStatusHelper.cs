using System.Diagnostics;
using System.Text;

namespace WaterErpLauncher;

internal sealed class GitStatusSnapshot
{
    public bool Ok { get; init; }
    public bool ComparedToRemote { get; init; }
    public string Branch { get; init; } = "—";
    public int Ahead { get; init; }
    public int Behind { get; init; }
    public int DirtyCount { get; init; }
    public string LocalCommit { get; init; } = "—";
    public string RemoteCommit { get; init; } = "—";
    public string Headline { get; init; } = "尚未檢查 Git 同步";
    public string Detail { get; init; } = "";
    public string Hint { get; init; } = "";
    public Color Accent { get; init; } = UiTheme.Unknown;
}

internal static class GitStatusHelper
{
    public static async Task<GitStatusSnapshot> QueryAsync(string projectRoot, string configuredBranch, bool fetchRemote)
    {
        if (string.IsNullOrWhiteSpace(projectRoot) || !Directory.Exists(Path.Combine(projectRoot, ".git")))
        {
            return Fail("找不到 Git 專案", "請在設定確認專案根目錄是否正確。");
        }

        var git = FindGit();
        if (git is null)
        {
            return Fail("找不到 git.exe", "請安裝 Git for Windows 並加入 PATH。");
        }

        var branchResult = await RunGitAsync(git, projectRoot, "rev-parse --abbrev-ref HEAD", 8000);
        var branch = branchResult.Ok && !string.IsNullOrWhiteSpace(branchResult.Output)
            ? branchResult.Output.Trim()
            : (string.IsNullOrWhiteSpace(configuredBranch) ? "main" : configuredBranch.Trim());

        var porcelain = await RunGitAsync(git, projectRoot, "status --porcelain", 8000);
        var dirtyCount = 0;
        if (porcelain.Ok)
        {
            dirtyCount = porcelain.Output
                .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
                .Count(line => !string.IsNullOrWhiteSpace(line));
        }

        var fetched = false;
        string? fetchError = null;
        if (fetchRemote)
        {
            var fetch = await RunGitAsync(git, projectRoot, "fetch --prune --quiet origin", 25000);
            fetched = fetch.Ok;
            if (!fetch.Ok)
                fetchError = Compact(fetch.Output);
        }

        var ahead = 0;
        var behind = 0;
        var compared = false;
        var count = await RunGitAsync(git, projectRoot, $"rev-list --left-right --count origin/{branch}...HEAD", 8000);
        if (count.Ok)
        {
            var parts = count.Output.Split(['\t', ' '], StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && int.TryParse(parts[0], out behind) && int.TryParse(parts[1], out ahead))
                compared = true;
        }

        var local = await RunGitAsync(git, projectRoot, "log -1 --pretty=format:%h %s (%cr)", 8000);
        var remote = compared
            ? await RunGitAsync(git, projectRoot, $"log -1 --pretty=format:%h %s (%cr) origin/{branch}", 8000)
            : (Ok: false, Output: "");

        var localCommit = local.Ok && !string.IsNullOrWhiteSpace(local.Output) ? local.Output.Trim() : "尚無提交";
        var remoteCommit = remote.Ok && !string.IsNullOrWhiteSpace(remote.Output) ? remote.Output.Trim() : (compared ? "—" : "尚未取得遠端資訊");

        var headline = "已與 GitHub 同步";
        var hint = "GitHub 上沒有更新的提交，本機工作目錄也是乾淨的。";
        var accent = UiTheme.Success;
        if (!compared)
        {
            headline = fetchRemote ? "無法比對 GitHub 版本" : "尚未比對 GitHub";
            hint = string.IsNullOrWhiteSpace(fetchError)
                ? "請按「檢查同步」向 GitHub 抓取最新提交。"
                : "無法連線 GitHub：" + fetchError;
            accent = UiTheme.Warning;
        }
        else if (behind > 0 && dirtyCount > 0)
        {
            headline = $"落後 GitHub {behind} 筆，且本機有未提交變更";
            hint = "請先處理本機變更，再按「更新並部署」。有未提交檔案時，git pull 可能失敗。";
            accent = UiTheme.Danger;
        }
        else if (behind > 0)
        {
            headline = $"落後 GitHub {behind} 筆提交";
            hint = "請按「更新並部署」拉取最新程式並重新建置上線。";
            accent = UiTheme.Warning;
        }
        else if (dirtyCount > 0)
        {
            headline = $"本機有 {dirtyCount} 個未提交變更";
            hint = "工作目錄與 Git 不一致。正式機建議保持乾淨，避免更新時衝突。";
            accent = UiTheme.Warning;
        }
        else if (ahead > 0)
        {
            headline = $"本機領先 GitHub {ahead} 筆（尚未推送）";
            hint = "這些提交只在這台電腦。若要讓其他機器同步，需要先 git push。";
            accent = UiTheme.Warning;
        }
        else if (fetchRemote && !fetched)
        {
            headline = "已讀取本機狀態，但無法連線 GitHub";
            hint = string.IsNullOrWhiteSpace(fetchError) ? "稍後再按「檢查同步」。" : fetchError;
            accent = UiTheme.Warning;
        }

        var remoteLine = compared ? $"GitHub：{remoteCommit}" : "GitHub：尚未比對";
        var extra = ahead > 0 || behind > 0
            ? $"領先 {ahead} · 落後 {behind}"
            : "與遠端提交相同";
        var dirtyLine = dirtyCount == 0 ? "工作目錄乾淨" : $"未提交變更 {dirtyCount} 個";

        return new GitStatusSnapshot
        {
            Ok = true,
            ComparedToRemote = compared,
            Branch = branch,
            Ahead = ahead,
            Behind = behind,
            DirtyCount = dirtyCount,
            LocalCommit = localCommit,
            RemoteCommit = remoteCommit,
            Headline = headline,
            Detail = $"分支 {branch} · {dirtyLine} · {extra}\n本機：{localCommit}\n{remoteLine}",
            Hint = hint,
            Accent = accent
        };
    }

    private static GitStatusSnapshot Fail(string headline, string hint) => new()
    {
        Ok = false,
        Headline = headline,
        Detail = hint,
        Hint = hint,
        Accent = UiTheme.Danger
    };

    private static async Task<(bool Ok, string Output)> RunGitAsync(string git, string root, string arguments, int timeoutMs)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = git,
                Arguments = arguments,
                WorkingDirectory = root,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";
            using var process = Process.Start(startInfo);
            if (process is null)
                return (false, "無法啟動 git");

            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            using var cts = new CancellationTokenSource(timeoutMs);
            try
            {
                await process.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return (false, "git 命令逾時");
            }

            var output = ((await stdoutTask) + "\n" + await stderrTask).Trim();
            return (process.ExitCode == 0, output);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private static string? FindGit()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path))
            return null;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim().Trim('"'), "git.exe");
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }

    private static string Compact(string value)
    {
        var text = value.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return text.Length <= 140 ? text : text[..137] + "…";
    }
}
