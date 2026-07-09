import Foundation
import AppKit
import Combine

@MainActor
final class LauncherViewModel: ObservableObject {
    @Published var settings: LauncherSettings
    @Published var services: [ServiceStatus] = []
    @Published var gitStatus = GitStatusInfo()
    @Published var commitMessage = ""
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
        logStore.info("WaterERP Mac 啟動器已就緒")
        startMonitoring()
        Task { await refresh() }
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
    case git = "Git"
    case logs = "日誌"
    case settings = "設定"

    var id: String { rawValue }
}
