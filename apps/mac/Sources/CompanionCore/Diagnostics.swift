import Foundation

public struct DiagnosticsReport: Sendable {
    public var appVersion: String
    public var osVersion: String
    public var phase: String
    public var permissions: PermissionSnapshot
    public var zoom: ZoomHint
    public var health: AudioHealthSnapshot?
    public var bufferBytes: Int
    public var droppedChunks: Int
    public var recentLog: [String]

    public init(appVersion: String, osVersion: String, phase: String, permissions: PermissionSnapshot, zoom: ZoomHint,
                health: AudioHealthSnapshot?, bufferBytes: Int, droppedChunks: Int, recentLog: [String]) {
        self.appVersion = appVersion; self.osVersion = osVersion; self.phase = phase; self.permissions = permissions
        self.zoom = zoom; self.health = health; self.bufferBytes = bufferBytes; self.droppedChunks = droppedChunks; self.recentLog = recentLog
    }

    /// Text meant to be copied into a bug report: everything passes through LogRedactor.
    public func render() -> String {
        var l = ["Alfred Companion \(appVersion) — \(osVersion)", "Phase: \(phase)"]
        for k in PermissionKind.allCases { l.append("Permission \(k.rawValue): \(permissions.status(k).rawValue)") }
        l.append("Zoom: running=\(zoom.zoomRunning) confidence=\(zoom.confidence.rawValue) (hint only)")
        if let h = health { l.append("Audio: \(h.status.rawValue) bitrate=\(Int(h.bitrateBps))bps rms=\(Int(h.rmsDbfs))dBFS gaps=\(h.gapCount)") }
        l.append("Buffer: \(bufferBytes) B (dropped chunks: \(droppedChunks))")
        l.append("— log —"); l.append(contentsOf: recentLog.suffix(50))
        return LogRedactor.redact(l.joined(separator: "\n"))
    }
}
