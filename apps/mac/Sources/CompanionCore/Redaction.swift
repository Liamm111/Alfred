import Foundation

/// Removes anything that could identify a person, a meeting or a credential before a line is written or shown.
public enum LogRedactor {
    private static let rules: [(NSRegularExpression, String)] = {
        func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: [.caseInsensitive]) }
        return [
            (re(#"bearer\s+[A-Za-z0-9._~+/=\-]+"#), "Bearer [redacted]"),
            (re(#"(token|secret|signature|password|nonce|apikey|api_key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+"#), "$1$2[redacted]"),
            (re(#"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}"#), "[email]"),
            (re(#"https?://[^\s"']+"#), "[url]"),
            (re(#"wss?://[^\s"']+"#), "[url]"),
            (re(#"/Users/[^/\s]+"#), "/Users/~"),
            (re(#"\b[0-9a-f]{24,}\b"#), "[hex]"),
            (re(#"\b[A-Za-z0-9+/_\-]{32,}={0,2}"#), "[blob]"),
            (re(#"\b\d{9,11}\b"#), "[meeting-id]"),
        ]
    }()

    public static func redact(_ s: String) -> String {
        var out = s
        for (re, tpl) in rules {
            out = re.stringByReplacingMatches(in: out, options: [], range: NSRange(out.startIndex..., in: out), withTemplate: tpl)
        }
        return out
    }
}

public protocol LogSink: AnyObject { func write(_ line: String) }

public final class MemoryLogSink: LogSink {
    public private(set) var lines: [String] = []
    public init() {}
    public func write(_ line: String) { lines.append(line) }
}

public final class RedactingLogger {
    private let sink: LogSink
    private let now: () -> Date
    public init(sink: LogSink, now: @escaping () -> Date = Date.init) { self.sink = sink; self.now = now }
    public func log(_ level: String, _ message: String) {
        sink.write("\(ISO8601DateFormatter().string(from: now())) [\(level)] \(LogRedactor.redact(message))")
    }
    public func info(_ m: String) { log("info", m) }
    public func warn(_ m: String) { log("warn", m) }
    public func error(_ m: String) { log("error", m) }
}
