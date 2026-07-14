import Foundation

@MainActor
enum PortHelper {
    static func listenerPids(port: Int) async -> [pid_t] {
        let result = await ShellRunner.run("/usr/sbin/lsof", arguments: ["-ti", "tcp:\(port)", "-sTCP:LISTEN"])
        guard result.ok, !result.output.isEmpty else { return [] }
        return result.output
            .split(separator: "\n")
            .compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .map { pid_t($0) }
    }

    /// 結束佔用指定埠的行程（先 SIGTERM，再 SIGKILL）。
    @discardableResult
    static func releasePort(_ port: Int, log: LogStore) async -> Int {
        var killed = 0
        let pids = await listenerPids(port: port)
        if pids.isEmpty { return 0 }

        for pid in pids {
            if kill(pid, SIGTERM) == 0 {
                log.info("正在停止 PID \(pid)（埠 \(port)）…")
                killed += 1
            }
        }

        if killed > 0 {
            try? await Task.sleep(nanoseconds: 600_000_000)
        }

        for pid in await listenerPids(port: port) {
            if kill(pid, SIGKILL) == 0 {
                log.info("強制結束 PID \(pid)（埠 \(port)）")
                killed += 1
            }
        }

        return killed
    }

    static func isPortInUse(_ port: Int) async -> Bool {
        !(await listenerPids(port: port)).isEmpty
    }

    /// 停止 WaterERP 相關的 npm / node 殘留行程。
    static func stopOrphanedDevProcesses(projectRoot: String, log: LogStore) async {
        let patterns = [
            "npm run dev:api",
            "npm run dev:admin",
            "npm run dev:driver",
            "npm run dev:liff",
            "tsx watch src/index.ts",
            "node_modules/.bin/vite",
            "node_modules/vite/bin/vite.js",
        ]
        for pattern in patterns {
            _ = await ShellRunner.run("/usr/bin/pkill", arguments: ["-f", pattern])
        }
        _ = projectRoot
        log.info("已清理殘留的 dev 行程")
    }
}
