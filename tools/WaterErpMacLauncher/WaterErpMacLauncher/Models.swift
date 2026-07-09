import Foundation

enum ServiceId: String, CaseIterable, Identifiable {
    case mysql, api, admin, driver

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .mysql: return "MySQL"
        case .api: return "API"
        case .admin: return "後台"
        case .driver: return "司機端"
        }
    }

    var port: Int {
        switch self {
        case .mysql: return 3306
        case .api: return 3000
        case .admin: return 5173
        case .driver: return 5174
        }
    }

    var url: String {
        switch self {
        case .mysql: return "127.0.0.1:3306"
        case .api: return "http://localhost:3000"
        case .admin: return "http://localhost:5173"
        case .driver: return "http://localhost:5174"
        }
    }

    var npmScript: String? {
        switch self {
        case .mysql: return nil
        case .api: return "dev:api"
        case .admin: return "dev:admin"
        case .driver: return "dev:driver"
        }
    }
}

struct ServiceStatus: Identifiable {
    let id: ServiceId
    var running: Bool
    var healthy: Bool
    var detail: String

    var statusLabel: String {
        if running && healthy { return "運行中" }
        if running { return "異常" }
        return "已停止"
    }
}

struct GitStatusInfo {
    var branch: String = "—"
    var ahead: Int = 0
    var behind: Int = 0
    var changedFiles: [String] = []
    var lastCommit: String = ""
    var isClean: Bool { changedFiles.isEmpty }
}

struct LogEntry: Identifiable {
    let id = UUID()
    let time: String
    let level: LogLevel
    let message: String
}

enum LogLevel: String {
    case info, success, warn, error

    var symbol: String {
        switch self {
        case .info: return "ℹ️"
        case .success: return "✅"
        case .warn: return "⚠️"
        case .error: return "❌"
        }
    }
}

struct LauncherSettings: Codable {
    var projectRoot: String
    var mysqlHome: String
    var mysqlDataDir: String
    var mysqlSocket: String

    static func makeDefault() -> LauncherSettings {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return LauncherSettings(
            projectRoot: "\(home)/Projects/WaterERP",
            mysqlHome: "\(home)/mysql/current",
            mysqlDataDir: "\(home)/mysql/data",
            mysqlSocket: "/tmp/mysql.sock"
        )
    }

    static var settingsURL: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/WaterErpMacLauncher", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("settings.json")
    }

    static func load() -> LauncherSettings {
        let url = settingsURL
        guard let data = try? Data(contentsOf: url),
              let settings = try? JSONDecoder().decode(LauncherSettings.self, from: data) else {
            var defaults = makeDefault()
            if let detected = Self.detectProjectRoot() { defaults.projectRoot = detected }
            return defaults
        }
        return settings
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            try? data.write(to: Self.settingsURL)
        }
    }

    private static func detectProjectRoot() -> String? {
        let fm = FileManager.default
        let candidates = [
            "\(fm.homeDirectoryForCurrentUser.path)/Projects/WaterERP",
            "\(fm.homeDirectoryForCurrentUser.path)/WaterERP",
        ]
        for path in candidates {
            let pkg = URL(fileURLWithPath: path).appendingPathComponent("package.json")
            if fm.fileExists(atPath: pkg.path) { return path }
        }
        return nil
    }
}
