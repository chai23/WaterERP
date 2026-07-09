import Foundation

@MainActor
struct GitService {
    static func status(projectRoot: String) async -> GitStatusInfo {
        var info = GitStatusInfo()
        let branch = await git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
        info.branch = branch.ok ? branch.output : "unknown"

        let porcelain = await git(projectRoot, ["status", "--porcelain"])
        if porcelain.ok {
            info.changedFiles = porcelain.output
                .split(separator: "\n")
                .map { String($0.dropFirst(3)) }
                .filter { !$0.isEmpty }
        }

        let ab = await git(projectRoot, ["rev-list", "--left-right", "--count", "origin/\(info.branch)...HEAD"])
        if ab.ok {
            let parts = ab.output.split(separator: "\t")
            if parts.count == 2 {
                info.behind = Int(parts[0]) ?? 0
                info.ahead = Int(parts[1]) ?? 0
            }
        }

        let last = await git(projectRoot, ["log", "-1", "--pretty=format:%h %s (%cr)"])
        info.lastCommit = last.ok ? last.output : ""
        return info
    }

    static func pull(projectRoot: String, log: LogStore) async -> Bool {
        log.info("正在從 GitHub 拉取最新程式碼…")
        let status = await self.status(projectRoot: projectRoot)
        var stashed = false

        if !status.isClean {
            log.info("偵測到未提交變更，先暫存（stash）…")
            let stash = await git(projectRoot, ["stash", "push", "-u", "-m", "WaterErpMacLauncher auto-stash"])
            guard stash.ok else {
                log.error(stash.output)
                return false
            }
            stashed = true
        }

        let fetch = await git(projectRoot, ["fetch", "origin"])
        guard fetch.ok else {
            log.error(fetch.output)
            return false
        }

        let pull = await git(projectRoot, ["pull", "--rebase", "origin", status.branch])
        if stashed {
            let pop = await git(projectRoot, ["stash", "pop"])
            if pop.ok { log.info("已還原暫存的變更") }
            else { log.warn("還原 stash 時發生衝突，請手動處理") }
        }

        if pull.ok {
            log.success("已更新至最新版本")
            return true
        }
        log.error(pull.output)
        return false
    }

    static func push(projectRoot: String, message: String, log: LogStore) async -> Bool {
        let status = await self.status(projectRoot: projectRoot)

        if !status.isClean {
            guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                log.warn("請輸入 commit 訊息")
                return false
            }
            log.info("正在提交變更…")
            let add = await git(projectRoot, ["add", "-A"])
            guard add.ok else { log.error(add.output); return false }
            let commit = await git(projectRoot, ["commit", "-m", message])
            guard commit.ok else { log.error(commit.output); return false }
            log.success("變更已提交")
        } else {
            log.info("沒有未提交的變更，直接推送…")
        }

        log.info("正在推送到 GitHub…")
        let push = await git(projectRoot, ["push", "origin", status.branch])
        if push.ok {
            log.success("已推送到 GitHub")
            return true
        }
        log.error(push.output)
        return false
    }

    private static func git(_ projectRoot: String, _ args: [String]) async -> ShellRunner.Result {
        await ShellRunner.run("/usr/bin/git", arguments: args, cwd: projectRoot)
    }
}
