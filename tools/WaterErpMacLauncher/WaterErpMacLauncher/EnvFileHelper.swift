import Foundation

enum EnvFileHelper {
    static func envPath(projectRoot: String) -> String {
        URL(fileURLWithPath: projectRoot).appendingPathComponent("apps/api/.env").path
    }

    static func readValue(projectRoot: String, key: String) -> String {
        let path = envPath(projectRoot: projectRoot)
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else { return "" }
        for line in content.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") || !trimmed.contains("=") { continue }
            let parts = trimmed.split(separator: "=", maxSplits: 1)
            guard parts.count == 2, parts[0] == Substring(key) else { continue }
            return sanitizeEnvValue(String(parts[1]), key: key)
        }
        return ""
    }

    /// 清理 .env 值：去除引號、修正誤貼上的 KEY= 前綴、擷取 mysql:// URL。
    static func sanitizeEnvValue(_ raw: String, key: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let keyPrefix = "\(key)="
        if value.hasPrefix(keyPrefix) {
            value = String(value.dropFirst(keyPrefix.count))
        }
        value = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        if let range = value.range(of: "mysql://") {
            value = String(value[range.lowerBound...])
            if let quote = value.firstIndex(where: { $0 == "\"" || $0 == "'" }) {
                value = String(value[..<quote])
            }
        }
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    static func setValue(projectRoot: String, key: String, value: String) throws {
        let path = envPath(projectRoot: projectRoot)
        guard FileManager.default.fileExists(atPath: path) else {
            throw EnvFileError.missingEnv(path)
        }
        let clean = sanitizeEnvValue(value, key: key)
        guard !clean.isEmpty else { return }
        var lines = try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let newLine = "\(key)=\"\(clean)\""
        var found = false
        for i in lines.indices {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") { continue }
            if trimmed.hasPrefix("\(key)=") {
                lines[i] = newLine
                found = true
                break
            }
        }
        if !found {
            lines.append(newLine)
        }
        try lines.joined(separator: "\n").write(toFile: path, atomically: true, encoding: .utf8)
    }
}

enum EnvFileError: LocalizedError {
    case missingEnv(String)

    var errorDescription: String? {
        switch self {
        case .missingEnv(let path): return "找不到 .env：\(path)"
        }
    }
}

enum LegacyMigrationTask: String, CaseIterable, Identifiable {
    case zones
    case companies
    case customers
    case users
    case drivers
    case products

    var id: String { rawValue }

    var title: String {
        switch self {
        case .zones: return "轉換地址分區"
        case .companies: return "轉換隸屬公司"
        case .customers: return "轉換客戶資料"
        case .users: return "轉換使用者資料"
        case .drivers: return "轉換司機資料"
        case .products: return "轉換商品資料"
        }
    }

    var npmScript: String {
        switch self {
        case .zones: return "db:migrate-zones"
        case .companies: return "db:migrate-companies"
        case .customers: return "db:migrate-customers"
        case .users: return "db:migrate-users"
        case .drivers: return "db:migrate-drivers"
        case .products: return "db:migrate-products"
        }
    }

    var confirmMessage: String {
        switch self {
        case .zones:
            return """
            將從舊庫 database.area 匯入 address_zones（排除 99 尚未分配），
            寫入本機 water_erp。
            舊庫僅讀取、不修改。確定繼續？
            """
        case .companies:
            return """
            將從舊庫 customer.company 匯入 affiliated_companies。
            寫入本機 water_erp。
            舊庫僅讀取、不修改。確定繼續？
            """
        case .customers:
            return """
            將從舊庫 customer 匯入 customers 與 delivery_addresses。
            請先完成「地址分區」「隸屬公司」轉換。

            舊庫僅讀取、不修改。確定繼續？
            """
        case .users:
            return """
            將清空本機 users，建立 id=1 的 admin（密碼 admin123），
            再從舊庫 personnel_list 匯入其餘使用者（自 id=2 起）。

            舊庫僅讀取、不修改。確定繼續？
            """
        case .drivers:
            return """
            將清空本機司機帳號（role=driver），從舊庫 driver 匯入司機，
            登入帳號為 driver_id，預設密碼 888888。

            舊庫僅讀取、不修改。確定繼續？
            """
        case .products:
            return """
            將清空本機 products 與庫存，從舊庫 product 匯入實體商品。
            排除標語／帳務虛擬行。

            舊庫僅讀取、不修改。確定繼續？
            """
        }
    }
}
