import Foundation

@MainActor
final class LogStore: ObservableObject {
    @Published private(set) var entries: [LogEntry] = []
    private let maxEntries = 2000

    func log(_ level: LogLevel, _ message: String) {
        // 多行輸出拆成多筆，方便滾動檢視轉換日誌
        let chunks = message.split(separator: "\n", omittingEmptySubsequences: false)
        for chunk in chunks {
            let entry = LogEntry(
                time: Self.formatter.string(from: Date()),
                level: level,
                message: String(chunk)
            )
            entries.append(entry)
        }
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
    }

    func info(_ message: String) { log(.info, message) }
    func success(_ message: String) { log(.success, message) }
    func warn(_ message: String) { log(.warn, message) }
    func error(_ message: String) { log(.error, message) }

    func clear() { entries.removeAll() }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()
}

enum ShellRunner {
    struct Result {
        let exitCode: Int32
        let output: String
        var ok: Bool { exitCode == 0 }
    }

    static func run(
        _ launchPath: String,
        arguments: [String] = [],
        cwd: String? = nil,
        env: [String: String]? = nil,
        onLine: (@MainActor (String) -> Void)? = nil
    ) async -> Result {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let outPipe = Pipe()
                let errPipe = Pipe()
                process.executableURL = URL(fileURLWithPath: launchPath)
                process.arguments = arguments
                if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
                var environment = ProcessInfo.processInfo.environment
                let home = FileManager.default.homeDirectoryForCurrentUser.path
                environment["PATH"] = "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "")
                // Node／tsx 關閉輸出緩衝，方便啟動器即時顯示轉換日誌
                environment["PYTHONUNBUFFERED"] = "1"
                environment["NODE_OPTIONS"] = (environment["NODE_OPTIONS"] ?? "") + " --no-warnings"
                env?.forEach { environment[$0.key] = $0.value }
                process.environment = environment
                process.standardOutput = outPipe
                process.standardError = errPipe

                let lock = NSLock()
                var combinedChunks: [String] = []

                func handleChunk(_ data: Data, isError: Bool) {
                    guard let text = String(data: data, encoding: .utf8), !text.isEmpty else { return }
                    lock.lock()
                    combinedChunks.append(text)
                    lock.unlock()
                    if let onLine {
                        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                            let s = String(line)
                            if s.isEmpty { continue }
                            DispatchQueue.main.async {
                                onLine(s)
                            }
                        }
                    }
                    _ = isError
                }

                outPipe.fileHandleForReading.readabilityHandler = { handle in
                    let data = handle.availableData
                    if data.isEmpty {
                        handle.readabilityHandler = nil
                        return
                    }
                    handleChunk(data, isError: false)
                }
                errPipe.fileHandleForReading.readabilityHandler = { handle in
                    let data = handle.availableData
                    if data.isEmpty {
                        handle.readabilityHandler = nil
                        return
                    }
                    handleChunk(data, isError: true)
                }

                do {
                    try process.run()
                    process.waitUntilExit()
                    outPipe.fileHandleForReading.readabilityHandler = nil
                    errPipe.fileHandleForReading.readabilityHandler = nil
                    // 讀取殘餘
                    handleChunk(outPipe.fileHandleForReading.readDataToEndOfFile(), isError: false)
                    handleChunk(errPipe.fileHandleForReading.readDataToEndOfFile(), isError: true)
                    let combined = combinedChunks.joined().trimmingCharacters(in: .whitespacesAndNewlines)
                    continuation.resume(returning: Result(exitCode: process.terminationStatus, output: combined))
                } catch {
                    continuation.resume(returning: Result(exitCode: 1, output: error.localizedDescription))
                }
            }
        }
    }

    static func which(_ name: String) -> String? {
        let result = runSync("/usr/bin/which", arguments: [name])
        return result.ok ? result.output : nil
    }

    private static func runSync(_ launchPath: String, arguments: [String]) -> Result {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Result(exitCode: process.terminationStatus, output: output)
        } catch {
            return Result(exitCode: 1, output: error.localizedDescription)
        }
    }
}
