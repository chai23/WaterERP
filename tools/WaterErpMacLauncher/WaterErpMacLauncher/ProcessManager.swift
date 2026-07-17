import Foundation

@MainActor
final class ProcessManager: ObservableObject {
    private var mysqlProcess: Process?
    private var serviceProcesses: [ServiceId: Process] = [:]

    func startMysql(settings: LauncherSettings, log: LogStore) async throws {
        if await HealthService.isMysqlRunning(settings: settings) {
            log.info("MySQL 已在運行中")
            return
        }

        let mysqld = "\(settings.mysqlHome)/bin/mysqld"
        guard FileManager.default.fileExists(atPath: mysqld) else {
            throw LauncherError.mysqlNotFound(settings.mysqlHome)
        }

        try ensureMysqlDataDir(settings: settings, log: log)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: mysqld)
        process.arguments = [
            "--datadir=\(settings.mysqlDataDir)",
            "--basedir=\(settings.mysqlHome)",
            "--port=3306",
            "--bind-address=127.0.0.1",
            "--socket=\(settings.mysqlSocket)",
        ]
        attachLogging(process: process, label: "MySQL", id: .mysql, log: log)
        try process.run()
        mysqlProcess = process

        try await waitUntil(timeout: 15) {
            await HealthService.isMysqlRunning(settings: settings)
        }

        let mysql = "\(settings.mysqlHome)/bin/mysql"
        _ = await ShellRunner.run(mysql, arguments: [
            "-u", "root", "--socket=\(settings.mysqlSocket)", "-e",
            "CREATE DATABASE IF NOT EXISTS water_erp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
        ])
        log.success("MySQL 已啟動")
    }

    func stopMysql(settings: LauncherSettings, log: LogStore) async {
        if let proc = mysqlProcess, proc.isRunning {
            proc.terminate()
            mysqlProcess = nil
        }
        let mysqladmin = "\(settings.mysqlHome)/bin/mysqladmin"
        let result = await ShellRunner.run(mysqladmin, arguments: [
            "-u", "root", "--socket=\(settings.mysqlSocket)", "shutdown"
        ])
        if result.ok {
            log.success("MySQL 已停止")
            return
        }
        let killed = await PortHelper.releasePort(3306, log: log)
        if killed > 0 {
            log.success("MySQL 已停止")
        } else if await HealthService.isMysqlRunning(settings: settings) {
            log.warn("停止 MySQL 失敗：\(result.output)")
        } else {
            log.info("MySQL 未在運行")
        }
        mysqlProcess = nil
    }

    func startService(_ id: ServiceId, settings: LauncherSettings, log: LogStore) async throws {
        guard let script = id.npmScript else { return }
        if serviceProcesses[id]?.isRunning == true {
            log.info("\(id.displayName) 已在運行中")
            return
        }
        if await HealthService.isServiceRunning(id: id) {
            log.info("\(id.displayName) 已在運行中")
            return
        }

        guard let npm = ShellRunner.which("npm") else {
            throw LauncherError.npmNotFound
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: npm)
        process.arguments = ["run", script]
        process.currentDirectoryURL = URL(fileURLWithPath: settings.projectRoot)
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "")
        process.environment = env
        attachLogging(process: process, label: id.displayName, id: id, log: log)
        try process.run()
        serviceProcesses[id] = process
        log.success("\(id.displayName) 啟動中…")
    }

    func stopService(_ id: ServiceId, log: LogStore) async {
        if let proc = serviceProcesses[id], proc.isRunning {
            proc.terminate()
            serviceProcesses.removeValue(forKey: id)
        }

        let killed = await PortHelper.releasePort(id.port, log: log)
        if killed > 0 {
            log.success("\(id.displayName) 已停止（埠 \(id.port)）")
        } else if serviceProcesses[id] == nil {
            log.info("\(id.displayName) 埠 \(id.port) 上無執行中的服務")
        } else {
            log.success("\(id.displayName) 已停止")
        }
        serviceProcesses.removeValue(forKey: id)
    }

    func startAll(settings: LauncherSettings, log: LogStore) async throws {
        try await startMysql(settings: settings, log: log)
        try await startService(.api, settings: settings, log: log)
        try await Task.sleep(nanoseconds: 2_000_000_000)
        try await startService(.admin, settings: settings, log: log)
        try await startService(.driver, settings: settings, log: log)
        try await startService(.liff, settings: settings, log: log)
        log.success("全部服務已啟動")
    }

    /// 停止 API 與各 Web 開發服務，但保留 MySQL。
    /// 資料庫升級／舊庫轉換時必須使用此方法，避免中途失去資料庫連線。
    func stopApplicationServices(settings: LauncherSettings, log: LogStore) async {
        log.info("正在停止應用服務（保留 MySQL）…")
        for id in [ServiceId.liff, .driver, .admin, .api] {
            await stopService(id, log: log)
        }
        await PortHelper.stopOrphanedDevProcesses(projectRoot: settings.projectRoot, log: log)

        try? await Task.sleep(nanoseconds: 500_000_000)
        let stillRunning = await HealthService.statuses(settings: settings)
            .filter { $0.id != .mysql && $0.running }
        if stillRunning.isEmpty {
            log.success("應用服務已停止，MySQL 保持運行")
        } else {
            let names = stillRunning.map(\.id.displayName).joined(separator: "、")
            log.warn("以下應用服務可能仍在運行：\(names)")
        }
    }

    func stopAll(settings: LauncherSettings, log: LogStore) async {
        log.info("正在停止全部服務…")
        await stopApplicationServices(settings: settings, log: log)
        await stopMysql(settings: settings, log: log)

        try? await Task.sleep(nanoseconds: 500_000_000)
        let stillRunning = await HealthService.statuses(settings: settings).filter { $0.running }
        if stillRunning.isEmpty {
            log.success("全部服務已停止")
        } else {
            let names = stillRunning.map(\.id.displayName).joined(separator: "、")
            log.warn("以下服務可能仍在運行：\(names)")
        }
    }

    func stopAllOnExit(settings: LauncherSettings) {
        for (_, proc) in serviceProcesses where proc.isRunning { proc.terminate() }
        mysqlProcess?.terminate()
        serviceProcesses.removeAll()
        mysqlProcess = nil
    }

    private func attachLogging(process: Process, label: String, id: ServiceId, log: LogStore) {
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in
                for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
                    log.info("[\(label)] \(line)")
                }
            }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in
                for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
                    log.warn("[\(label)] \(line)")
                }
            }
        }
        process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                self?.serviceProcesses.removeValue(forKey: id)
                if id == .mysql { self?.mysqlProcess = nil }
            }
        }
    }

    private func ensureMysqlDataDir(settings: LauncherSettings, log: LogStore) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: settings.mysqlDataDir) {
            try fm.createDirectory(atPath: settings.mysqlDataDir, withIntermediateDirectories: true)
            log.info("首次使用，正在初始化 MySQL 資料目錄…")
            let mysqld = "\(settings.mysqlHome)/bin/mysqld"
            let process = Process()
            process.executableURL = URL(fileURLWithPath: mysqld)
            process.arguments = [
                "--initialize-insecure",
                "--datadir=\(settings.mysqlDataDir)",
                "--basedir=\(settings.mysqlHome)",
            ]
            try process.run()
            process.waitUntilExit()
            log.success("MySQL 資料目錄初始化完成")
        }
    }

    private func waitUntil(timeout: TimeInterval, predicate: @escaping () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        throw LauncherError.timeout("等待服務啟動逾時")
    }
}

enum LauncherError: LocalizedError {
    case mysqlNotFound(String)
    case npmNotFound
    case timeout(String)

    var errorDescription: String? {
        switch self {
        case .mysqlNotFound(let path): return "找不到 MySQL：\(path)"
        case .npmNotFound: return "找不到 npm，請先安裝 Node.js"
        case .timeout(let msg): return msg
        }
    }
}
