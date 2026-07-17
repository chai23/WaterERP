import Foundation
import AppKit
import Combine

@MainActor
final class LauncherViewModel: ObservableObject {
    @Published var settings: LauncherSettings
    @Published var services: [ServiceStatus] = []
    @Published var gitStatus = GitStatusInfo()
    @Published var commitMessage = ""
    @Published var legacyDatabaseURL = ""
    @Published var schemaStatusSummary = "尚未檢查"
    @Published var schemaPendingCount = 0
    @Published var isBusy = false
    @Published var selectedTab: LauncherTab = .services

    let logStore = LogStore()
    let processManager = ProcessManager()

    private var monitorTimer: Timer?

    init() {
        settings = LauncherSettings.load()
        services = ServiceId.allCases.map {
            ServiceStatus(id: $0, running: false, healthy: false, detail: "尚未檢查")
        }
    }

    func onAppear() {
        logStore.info("超好企業進銷存系統 Mac 啟動器已就緒")
        startMonitoring()
        Task {
            await refresh()
            await refreshSchemaStatusQuietly()
        }
    }

    func onDisappear() {
        monitorTimer?.invalidate()
    }

    func saveSettings() {
        settings.save()
        logStore.success("設定已儲存")
    }

    func refresh() async {
        services = await HealthService.statuses(settings: settings)
        gitStatus = await GitService.status(projectRoot: settings.projectRoot)
    }

    func refreshServicesOnly() async {
        services = await HealthService.statuses(settings: settings)
    }

    func refreshGitOnly() async {
        gitStatus = await GitService.status(projectRoot: settings.projectRoot)
    }

    func startAll() {
        runTask {
            try await self.processManager.startAll(settings: self.settings, log: self.logStore)
            await self.refresh()
        }
    }

    func stopAll() {
        runTask {
            await self.processManager.stopAll(settings: self.settings, log: self.logStore)
            await self.refresh()
        }
    }

    func startService(_ id: ServiceId) {
        runTask {
            if id == .mysql {
                try await self.processManager.startMysql(settings: self.settings, log: self.logStore)
            } else {
                try await self.processManager.startService(id, settings: self.settings, log: self.logStore)
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await self.refresh()
        }
    }

    func stopService(_ id: ServiceId) {
        runTask {
            if id == .mysql {
                await self.processManager.stopMysql(settings: self.settings, log: self.logStore)
            } else {
                await self.processManager.stopService(id, log: self.logStore)
            }
            await self.refresh()
        }
    }

    func gitPull() {
        runTask {
            _ = await GitService.pull(projectRoot: self.settings.projectRoot, log: self.logStore)
            await self.refresh()
        }
    }

    func gitPush() {
        runTask {
            let ok = await GitService.push(
                projectRoot: self.settings.projectRoot,
                message: self.commitMessage,
                log: self.logStore
            )
            if ok { self.commitMessage = "" }
            await self.refresh()
        }
    }

    func npmInstall() {
        runTask {
            self.logStore.info("執行 npm install…")
            let result = await ShellRunner.run(
                ShellRunner.which("npm") ?? "/usr/local/bin/npm",
                arguments: ["install"],
                cwd: self.settings.projectRoot
            )
            if result.ok {
                self.logStore.success("npm install 完成")
                _ = await ShellRunner.run(
                    ShellRunner.which("npm") ?? "/usr/local/bin/npm",
                    arguments: ["run", "db:generate"],
                    cwd: self.settings.projectRoot
                )
            } else {
                self.logStore.error(result.output)
            }
        }
    }

    func openURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    func loadLegacySettings() {
        legacyDatabaseURL = EnvFileHelper.readValue(
            projectRoot: settings.projectRoot,
            key: "LEGACY_DATABASE_URL"
        )
    }

    func saveLegacyDatabaseURL() {
        runTask {
            try self.persistLegacyDatabaseURL()
            self.logStore.success("已儲存 LEGACY_DATABASE_URL")
        }
    }

    func runLegacyMigration(_ task: LegacyMigrationTask) {
        guard FileManager.default.fileExists(atPath: EnvFileHelper.envPath(projectRoot: settings.projectRoot)) else {
            logStore.error("找不到 apps/api/.env，請先設定 DATABASE_URL")
            return
        }
        guard confirm(title: task.title, message: task.confirmMessage) else { return }

        runTask {
            if self.services.contains(where: { $0.id != .mysql && $0.running }) {
                if self.confirm(
                    title: "停止應用服務",
                    message: "目前有應用服務在執行中。轉換資料前建議先停止 API 與網頁服務；MySQL 會保持運行。是否現在停止應用服務？"
                ) {
                    await self.processManager.stopApplicationServices(
                        settings: self.settings,
                        log: self.logStore
                    )
                }
            }
            try self.persistLegacyDatabaseURL()
            try await self.executeNpmScript(task.npmScript, label: task.title)
            await self.refresh()
        }
    }

    func checkSchemaMigration() {
        guard FileManager.default.fileExists(atPath: EnvFileHelper.envPath(projectRoot: settings.projectRoot)) else {
            logStore.error("找不到 apps/api/.env，請先設定 DATABASE_URL")
            return
        }
        runTask {
            await self.refreshSchemaStatus(showDialog: true)
        }
    }

    func applySchemaMigration() {
        guard FileManager.default.fileExists(atPath: EnvFileHelper.envPath(projectRoot: settings.projectRoot)) else {
            logStore.error("找不到 apps/api/.env，請先設定 DATABASE_URL")
            return
        }
        runTask {
            await self.refreshSchemaStatus(showDialog: false)
            guard self.schemaPendingCount > 0 else {
                self.logStore.info("資料庫結構已是最新，無需升級")
                return
            }
            let pendingList = await self.currentPendingMigrations()
            let listText = pendingList.joined(separator: "\n")
            let message = """
            將套用以下 migration 至本機 water_erp：
            \(listText)

            建議先備份資料庫（mysqldump）。
            升級前會建議停止 API 與網頁服務，但 MySQL 會保持運行。

            確定繼續？
            """
            guard self.confirm(title: "升級資料庫結構", message: message) else { return }

            if self.services.contains(where: { $0.id != .mysql && $0.running }) {
                if self.confirm(
                    title: "停止應用服務",
                    message: "目前有應用服務在執行中。升級結構前建議先停止 API 與網頁服務；MySQL 會保持運行。是否現在停止應用服務？"
                ) {
                    await self.processManager.stopApplicationServices(
                        settings: self.settings,
                        log: self.logStore
                    )
                }
            }

            guard await HealthService.isMysqlRunning(settings: self.settings) else {
                self.logStore.error("MySQL 未在運行，無法升級資料庫結構。請先啟動 MySQL。")
                throw LauncherError.timeout("MySQL 未在運行，資料庫結構升級已中止")
            }
            self.logStore.success("已確認 MySQL 保持運行，開始升級結構")
            try await self.executeNpmScript("db:schema-apply", label: "升級資料庫結構")
            _ = await self.executeNpmScriptOptional("db:generate", label: "Prisma generate")
            await self.refreshSchemaStatus(showDialog: true)
            self.logStore.warn("資料庫結構已升級。若 API 正在執行，請重啟 API。")
        }
    }

    func resetBusinessData() {
        let message = """
        將清空本機 water_erp 的業務資料（訂單、庫存、帳款等），
        並刪除所有 users。
        清空後將無法登入，須再執行「轉換使用者資料」建立帳號。

        確定繼續？
        """
        guard confirm(title: "清空業務資料", message: message) else { return }
        runTask {
            try await self.executeNpmScript("db:reset", label: "清空業務資料")
            self.logStore.warn("業務資料已清空。請執行「轉換使用者資料」匯入帳號。")
            await self.refresh()
        }
    }

    private func persistLegacyDatabaseURL() throws {
        let value = EnvFileHelper.sanitizeEnvValue(legacyDatabaseURL, key: "LEGACY_DATABASE_URL")
        guard !value.isEmpty else {
            logStore.info("未設定 LEGACY_DATABASE_URL，將使用同主機的 database 庫")
            return
        }
        guard value.hasPrefix("mysql://") else {
            throw LauncherError.timeout("LEGACY_DATABASE_URL 必須以 mysql:// 開頭")
        }
        try EnvFileHelper.setValue(
            projectRoot: settings.projectRoot,
            key: "LEGACY_DATABASE_URL",
            value: value
        )
        legacyDatabaseURL = value
    }

    private func executeNpmScript(_ script: String, label: String) async throws {
        guard let npm = ShellRunner.which("npm") else {
            throw LauncherError.npmNotFound
        }
        logStore.info("開始\(label)…")
        let result = await ShellRunner.run(
            npm,
            arguments: ["run", script],
            cwd: settings.projectRoot
        )
        if result.ok {
            logStore.success("\(label)完成")
            if !result.output.isEmpty {
                logStore.info(result.output)
            }
        } else {
            logStore.error("\(label)失敗：\n\(result.output)")
            throw LauncherError.timeout("\(label)失敗")
        }
    }

    @discardableResult
    private func executeNpmScriptOptional(_ script: String, label: String) async -> Bool {
        do {
            try await executeNpmScript(script, label: label)
            return true
        } catch {
            return false
        }
    }

    private func refreshSchemaStatus(showDialog: Bool) async {
        guard let status = await SchemaMigrationService.fetchStatus(projectRoot: settings.projectRoot) else {
            schemaStatusSummary = "無法讀取結構狀態"
            schemaPendingCount = 0
            logStore.error("無法解析 db:schema-status 輸出")
            return
        }
        guard status.ok else {
            schemaStatusSummary = status.message ?? "檢查失敗"
            schemaPendingCount = 0
            logStore.error(status.message ?? "檢查資料庫結構失敗")
            return
        }
        schemaStatusSummary = status.summaryText
        schemaPendingCount = status.pending.count
        if showDialog {
            logStore.info(status.summaryText)
            if !status.pending.isEmpty {
                logStore.warn("待升級：\(status.pending.joined(separator: ", "))")
            } else {
                logStore.success("資料庫結構已最新")
            }
        } else if !status.pending.isEmpty {
            logStore.warn("資料庫結構落後：\(status.pending.joined(separator: ", "))")
        }
    }

    private func refreshSchemaStatusQuietly() async {
        guard FileManager.default.fileExists(atPath: EnvFileHelper.envPath(projectRoot: settings.projectRoot)) else {
            schemaStatusSummary = "尚未設定 DATABASE_URL"
            schemaPendingCount = 0
            return
        }
        await refreshSchemaStatus(showDialog: false)
    }

    private func currentPendingMigrations() async -> [String] {
        guard let status = await SchemaMigrationService.fetchStatus(projectRoot: settings.projectRoot) else {
            return []
        }
        return status.pending
    }

    private func confirm(title: String, message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "確定")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func startMonitoring() {
        monitorTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshServicesOnly() }
        }
    }

    private func runTask(_ work: @escaping () async throws -> Void) {
        guard !isBusy else { return }
        isBusy = true
        Task {
            do {
                try await work()
            } catch {
                logStore.error(error.localizedDescription)
            }
            isBusy = false
        }
    }
}

enum LauncherTab: String, CaseIterable, Identifiable {
    case services = "服務"
    case legacy = "舊庫轉換"
    case git = "Git"
    case logs = "日誌"
    case settings = "設定"

    var id: String { rawValue }
}
