import SwiftUI

struct ContentView: View {
    @StateObject private var vm = LauncherViewModel()

    var body: some View {
        NavigationSplitView {
            List(LauncherTab.allCases, selection: $vm.selectedTab) { tab in
                Label(tab.rawValue, systemImage: icon(for: tab))
                    .tag(tab)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 140, ideal: 160)
        } detail: {
            Group {
                switch vm.selectedTab {
                case .services: ServicesView(vm: vm)
                case .legacy: LegacyMigrationView(vm: vm)
                case .git: GitView(vm: vm)
                case .logs: LogsView(vm: vm)
                case .settings: SettingsView(vm: vm)
                }
            }
            .frame(minWidth: 680, minHeight: 520)
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button("重新整理") {
                    Task {
                        await vm.refresh()
                    }
                }
                    .disabled(vm.isBusy)
                Button("啟動全部") { vm.startAll() }
                    .disabled(vm.isBusy)
                Button("停止全部", role: .destructive) { vm.stopAll() }
                    .disabled(vm.isBusy)
            }
        }
        .onAppear { vm.onAppear() }
        .onDisappear { vm.onDisappear() }
    }

    private func icon(for tab: LauncherTab) -> String {
        switch tab {
        case .services: return "server.rack"
        case .legacy: return "arrow.triangle.2.circlepath"
        case .git: return "arrow.triangle.branch"
        case .logs: return "text.alignleft"
        case .settings: return "gearshape"
        }
    }
}

// MARK: - Services

struct ServicesView: View {
    @ObservedObject var vm: LauncherViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("服務狀態")
                    .font(.title2.bold())

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 12)], spacing: 12) {
                    ForEach(vm.services) { svc in
                        ServiceCard(status: svc, vm: vm)
                    }
                }

                Divider().padding(.vertical, 4)

                Text("快速開啟")
                    .font(.headline)
                HStack {
                    Button("後台 (5173)") { vm.openURL("http://localhost:5173") }
                    Button("司機端 (5174)") { vm.openURL("http://localhost:5174") }
                    Button("API 健康檢查") { vm.openURL("http://localhost:3000/api/health") }
                }
            }
            .padding(20)
        }
        .navigationTitle("服務")
    }
}

struct ServiceCard: View {
    let status: ServiceStatus
    @ObservedObject var vm: LauncherViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle()
                    .fill(dotColor)
                    .frame(width: 10, height: 10)
                Text(status.id.displayName)
                    .font(.headline)
                Spacer()
                Text(status.statusLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(status.id.url)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(status.detail)
                .font(.caption)
                .lineLimit(2)
            HStack {
                Button("啟動") { vm.startService(status.id) }
                    .disabled(vm.isBusy)
                Button("停止") { vm.stopService(status.id) }
                    .disabled(vm.isBusy)
            }
        }
        .padding(14)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var dotColor: Color {
        if status.running && status.healthy { return .green }
        if status.running { return .orange }
        return .gray
    }
}

// MARK: - Legacy Migration

struct LegacyMigrationView: View {
    @ObservedObject var vm: LauncherViewModel

    private let columns = [GridItem(.adaptive(minimum: 180), spacing: 10)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("舊庫轉換")
                    .font(.title2.bold())
                Text("從舊庫 database 唯讀匯入至本機 water_erp，功能與 Windows 啟動器相同。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                GroupBox("資料庫結構（water_erp）") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("檢查並套用 `database/migrations/` 內未執行的 SQL，補上新表／新欄位（例如支出功能 028）。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(vm.schemaStatusSummary)
                            .font(.body)
                        HStack {
                            Button("檢查結構") { vm.checkSchemaMigration() }
                                .disabled(vm.isBusy)
                            Button("升級結構") { vm.applySchemaMigration() }
                                .disabled(vm.isBusy || vm.schemaPendingCount == 0)
                        }
                        Text("與下方「舊庫轉換」不同：此處只更新表結構，不匯入舊庫業務資料。升級前建議備份。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                GroupBox("舊庫連線（LEGACY_DATABASE_URL）") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("若舊庫在遠端 Windows 伺服器，請填寫連線字串（只需 mysql:// 開頭的網址，不要含 LEGACY_DATABASE_URL=）：")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextEditor(text: $vm.legacyDatabaseURL)
                            .font(.system(.body, design: .monospaced))
                            .frame(minHeight: 44, maxHeight: 64)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .stroke(Color.secondary.opacity(0.4), lineWidth: 1)
                            )
                        Text("例：mysql://user:pass@122.117.156.246:3306/database")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("留空則使用與 DATABASE_URL 同主機的 database 庫")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("儲存舊庫連線") { vm.saveLegacyDatabaseURL() }
                            .disabled(vm.isBusy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                GroupBox("建議順序") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("1. 地址分區 → 2. 隸屬公司 → 3. 客戶資料")
                        Text("4. 使用者資料 → 5. 司機資料 → 6. 商品資料")
                    }
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(LegacyMigrationTask.allCases) { task in
                        Button(task.title) {
                            vm.runLegacyMigration(task)
                        }
                        .disabled(vm.isBusy)
                    }
                }

                Divider()

                Button("清空業務資料（db:reset）", role: .destructive) {
                    vm.resetBusinessData()
                }
                .disabled(vm.isBusy)

                Text("轉換前請先停止 API。舊庫僅讀取，不會修改遠端資料。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .navigationTitle("舊庫轉換")
        .onAppear { vm.loadLegacySettings() }
    }
}

// MARK: - Git

struct GitView: View {
    @ObservedObject var vm: LauncherViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("版本資訊") {
                    VStack(alignment: .leading, spacing: 6) {
                        row("分支", vm.gitStatus.branch)
                        row("與遠端", "領先 \(vm.gitStatus.ahead) · 落後 \(vm.gitStatus.behind)")
                        row("最近提交", vm.gitStatus.lastCommit.isEmpty ? "—" : vm.gitStatus.lastCommit)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                GroupBox("工作目錄") {
                    VStack(alignment: .leading, spacing: 6) {
                        if vm.gitStatus.isClean {
                            Label("工作目錄乾淨", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Text("未提交變更（\(vm.gitStatus.changedFiles.count)）")
                                .font(.headline)
                            ForEach(vm.gitStatus.changedFiles, id: \.self) { file in
                                Text(file).font(.caption.monospaced())
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }

                GroupBox("操作") {
                    VStack(alignment: .leading, spacing: 12) {
                        Button {
                            vm.gitPull()
                        } label: {
                            Label("拉取最新程式碼 (git pull)", systemImage: "arrow.down.circle")
                        }
                        .disabled(vm.isBusy)

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Commit 訊息")
                                .font(.headline)
                            TextEditor(text: $vm.commitMessage)
                                .font(.body)
                                .frame(minHeight: 72, maxHeight: 120)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .stroke(Color.secondary.opacity(0.4), lineWidth: 1)
                                )
                                .disabled(vm.isBusy)
                            if vm.commitMessage.isEmpty {
                                Text("請輸入這次修改的說明，例如：新增 Mac 啟動器")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Button {
                            vm.gitPush()
                        } label: {
                            Label("提交並推送 (git push)", systemImage: "arrow.up.circle")
                        }
                        .disabled(vm.isBusy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
                }
            }
            .padding(20)
        }
        .navigationTitle("Git")
        .onAppear {
            Task { await vm.refreshGitOnly() }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
                .frame(width: 72, alignment: .leading)
            Text(value)
                .textSelection(.enabled)
        }
        .font(.subheadline)
    }
}

// MARK: - Logs

struct LogsView: View {
    @ObservedObject var vm: LauncherViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("執行紀錄").font(.title2.bold())
                Spacer()
                Button("清除") { vm.logStore.clear() }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(vm.logStore.entries) { entry in
                            Text("[\(entry.time)] \(entry.level.symbol) \(entry.message)")
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .id(entry.id)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .onChange(of: vm.logStore.entries.count) { _ in
                    if let last = vm.logStore.entries.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
        .navigationTitle("日誌")
    }
}

// MARK: - Settings

struct SettingsView: View {
    @ObservedObject var vm: LauncherViewModel

    var body: some View {
        Form {
            Section("專案") {
                TextField("專案根目錄", text: $vm.settings.projectRoot)
                Button("儲存設定") { vm.saveSettings() }
            }
            Section("MySQL") {
                TextField("MySQL 安裝路徑", text: $vm.settings.mysqlHome)
                TextField("資料目錄", text: $vm.settings.mysqlDataDir)
                TextField("Socket", text: $vm.settings.mysqlSocket)
            }
            Section("工具") {
                Button("npm install + Prisma generate") { vm.npmInstall() }
                    .disabled(vm.isBusy)
            }
            Section("說明") {
                Text("此啟動器僅供 Mac 開發環境使用。正式部署請在 Windows 伺服器執行。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("設定")
    }
}

#Preview {
    ContentView()
}
