import Foundation

public enum AudioHealthStatus: String, Equatable, Sendable {
    case ok
    case silent      // data flows but the signal is below the silence threshold for too long
    case absent      // no data at all for too long (device switched, app muted/closed, permission lost)
    case gap         // timestamp discontinuity detected recently
}

public struct AudioHealthSnapshot: Equatable, Sendable {
    public var status: AudioHealthStatus
    public var bitrateBps: Double      // PCM bytes/s * 8 over the sliding window
    public var rmsDbfs: Double
    public var gapCount: Int
    public var lastGapMs: Double
}

public final class AudioHealthMonitor {
    private let windowNs: UInt64, silenceDb: Double, silenceAfterNs: UInt64, absentAfterNs: UInt64, gapToleranceNs: UInt64
    private var recent: [(t: UInt64, bytes: Int)] = []
    private var lastEndNs: UInt64?
    private var lastDataNs: UInt64?
    private var silentSinceNs: UInt64?
    private var lastRms: Double = -120
    private var gaps = 0, lastGapMs = 0.0
    private var lastGapAtNs: UInt64 = 0
    public init(windowSeconds: Double = 5, silenceDbfs: Double = -55, silenceAfterSeconds: Double = 8,
                absentAfterSeconds: Double = 3, gapToleranceMs: Double = 100) {
        windowNs = UInt64(windowSeconds * 1e9); silenceDb = silenceDbfs; silenceAfterNs = UInt64(silenceAfterSeconds * 1e9)
        absentAfterNs = UInt64(absentAfterSeconds * 1e9); gapToleranceNs = UInt64(gapToleranceMs * 1e6)
    }

    public static func rmsDbfs(_ s: [Int16]) -> Double {
        guard !s.isEmpty else { return -120 }
        let sum = s.reduce(0.0) { $0 + Double($1) * Double($1) }
        let rms = (sum / Double(s.count)).squareRoot() / 32768
        return rms <= 0 ? -120 : max(-120, 20 * log10(rms))
    }

    public func ingest(_ c: PCMChunk) {
        let t = c.startNs
        if let end = lastEndNs, t > end, t - end > gapToleranceNs { gaps += 1; lastGapMs = Double(t - end) / 1e6; lastGapAtNs = t }
        lastEndNs = max(lastEndNs ?? 0, t + c.durationNs)
        lastDataNs = t + c.durationNs
        recent.append((t, c.byteCount)); recent.removeAll { t > $0.t && t - $0.t > windowNs }
        lastRms = Self.rmsDbfs(c.samples)
        if lastRms < silenceDb { silentSinceNs = silentSinceNs ?? t } else { silentSinceNs = nil }
    }

    public func snapshot(nowNs: UInt64) -> AudioHealthSnapshot {
        let bytes = recent.reduce(0) { $0 + $1.bytes }
        let span = max(Double(windowNs) / 1e9, 0.001)
        let bitrate = Double(bytes) * 8 / span
        let status: AudioHealthStatus
        if let last = lastDataNs == nil ? nil : lastDataNs, nowNs > last, nowNs - last > absentAfterNs { status = .absent }
        else if lastDataNs == nil { status = .absent }
        else if let s = silentSinceNs, nowNs > s, nowNs - s >= silenceAfterNs { status = .silent }
        else if lastGapAtNs > 0, nowNs > lastGapAtNs, nowNs - lastGapAtNs < 2_000_000_000 { status = .gap }
        else { status = .ok }
        return AudioHealthSnapshot(status: status, bitrateBps: bitrate, rmsDbfs: lastRms, gapCount: gaps, lastGapMs: lastGapMs)
    }

    public func reset() { recent = []; lastEndNs = nil; lastDataNs = nil; silentSinceNs = nil; gaps = 0; lastGapMs = 0; lastGapAtNs = 0; lastRms = -120 }
}

/// Decides, from a deliberate two-phase test, whether the chosen filter really isolates Zoom's audio.
/// Phase A: only Zoom plays a tone. Phase B: ONLY ANOTHER app plays a tone (Zoom silent).
/// A filter that "isolates" must hear A and not hear B. We never assume it; the result is recorded in the report.
public enum IsolationVerdict: Equatable { case isolated(marginDb: Double), polluted(leakDb: Double), noSignalFromZoom, inconclusive }

public enum IsolationProbe {
    public static func evaluate(zoomPhase: [Int16], otherAppPhase: [Int16], minSignalDbfs: Double = -50, minMarginDb: Double = 20) -> IsolationVerdict {
        guard !zoomPhase.isEmpty, !otherAppPhase.isEmpty else { return .inconclusive }
        let a = AudioHealthMonitor.rmsDbfs(zoomPhase), b = AudioHealthMonitor.rmsDbfs(otherAppPhase)
        if a < minSignalDbfs { return .noSignalFromZoom }
        let margin = a - b
        return margin >= minMarginDb ? .isolated(marginDb: margin) : .polluted(leakDb: b)
    }
}
