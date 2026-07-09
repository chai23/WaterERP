import Foundation
import Network

struct HealthService {
    private static func checkConnection(host: NWEndpoint.Host, port: Int) async -> Bool {
        await withCheckedContinuation { continuation in
            guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
                continuation.resume(returning: false)
                return
            }
            let connection = NWConnection(host: host, port: nwPort, using: .tcp)
            var resumed = false
            connection.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    connection.cancel()
                    continuation.resume(returning: true)
                case .failed, .cancelled:
                    if !resumed {
                        resumed = true
                        continuation.resume(returning: false)
                    }
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) {
                if !resumed {
                    resumed = true
                    connection.cancel()
                    continuation.resume(returning: false)
                }
            }
        }
    }

    /// Vite 在 macOS 上常只監聽 IPv6 localhost，需同時檢查 v4 與 v6。
    static func isPortOpen(_ port: Int) async -> Bool {
        if await checkConnection(host: .ipv4(.loopback), port: port) { return true }
        return await checkConnection(host: .ipv6(.loopback), port: port)
    }

    static func isWebDevServerUp(port: Int) async -> Bool {
        for host in ["http://localhost:\(port)", "http://127.0.0.1:\(port)"] {
            guard let url = URL(string: host) else { continue }
            var request = URLRequest(url: url)
            request.timeoutInterval = 2
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse,
                   (200 ... 399).contains(http.statusCode) {
                    return true
                }
            } catch {
                continue
            }
        }
        return false
    }

    static func isServiceRunning(id: ServiceId) async -> Bool {
        switch id {
        case .mysql:
            return false
        case .admin, .driver:
            return await isWebDevServerUp(port: id.port)
        case .api:
            if await isPortOpen(id.port) { return true }
            return (await apiHealth()).ok
        }
    }

    static func isMysqlRunning(settings: LauncherSettings) async -> Bool {
        if FileManager.default.fileExists(atPath: settings.mysqlSocket) {
            let mysql = "\(settings.mysqlHome)/bin/mysql"
            let result = await ShellRunner.run(mysql, arguments: [
                "-u", "root", "--socket=\(settings.mysqlSocket)", "-e", "SELECT 1"
            ])
            if result.ok { return true }
        }
        return await isPortOpen(3306)
    }

    static func apiHealth() async -> (ok: Bool, db: String?) {
        for host in ["http://127.0.0.1:3000/api/health", "http://localhost:3000/api/health"] {
            guard let url = URL(string: host) else { continue }
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    continue
                }
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    return (json["ok"] as? Bool == true, json["db"] as? String)
                }
            } catch {
                continue
            }
        }
        return (false, nil)
    }

    static func statuses(settings: LauncherSettings) async -> [ServiceStatus] {
        async let mysqlRunning = isMysqlRunning(settings: settings)
        async let apiPort = isPortOpen(3000)
        async let adminUp = isWebDevServerUp(port: 5173)
        async let driverUp = isWebDevServerUp(port: 5174)

        let mysql = await mysqlRunning
        let apiUp = await apiPort
        let adminRunning = await adminUp
        let driverRunning = await driverUp
        let health = await apiHealth()

        return ServiceId.allCases.map { id in
            switch id {
            case .mysql:
                return ServiceStatus(id: id, running: mysql, healthy: mysql,
                                     detail: mysql ? "資料庫連線正常" : "未啟動")
            case .api:
                let detail: String
                if health.ok { detail = "健康檢查通過（db: \(health.db ?? "—")）" }
                else if apiUp { detail = "埠已開啟但健康檢查失敗" }
                else { detail = "未啟動" }
                return ServiceStatus(id: id, running: apiUp || health.ok, healthy: health.ok, detail: detail)
            case .admin:
                return ServiceStatus(id: id, running: adminRunning, healthy: adminRunning,
                                     detail: adminRunning ? "Vite 開發伺服器運行中" : "未啟動")
            case .driver:
                return ServiceStatus(id: id, running: driverRunning, healthy: driverRunning,
                                     detail: driverRunning ? "Vite 開發伺服器運行中" : "未啟動")
            }
        }
    }
}
