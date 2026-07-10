import Foundation

struct SchemaMigrationStatus: Codable {
    let ok: Bool
    let applied: [String]
    let pending: [String]
    let latest: String?
    let message: String?
    let appliedNow: [String]?

    var summaryText: String {
        if !ok {
            return message ?? "檢查失敗"
        }
        if pending.isEmpty {
            return "結構已最新（已套用 \(applied.count) 支 migration）"
        }
        return "待升級 \(pending.count) 支：\(pending.joined(separator: ", "))"
    }
}

enum SchemaMigrationService {
    static func parseStatus(from output: String) -> SchemaMigrationStatus? {
        let lines = output
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for line in lines.reversed() {
            guard line.hasPrefix("{"), let data = line.data(using: .utf8) else { continue }
            if let status = try? JSONDecoder().decode(SchemaMigrationStatus.self, from: data) {
                return status
            }
        }
        return nil
    }

    static func fetchStatus(projectRoot: String) async -> SchemaMigrationStatus? {
        guard let npm = ShellRunner.which("npm") else { return nil }
        let result = await ShellRunner.run(
            npm,
            arguments: ["run", "db:schema-status"],
            cwd: projectRoot
        )
        return parseStatus(from: result.output)
    }
}
