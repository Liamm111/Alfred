import Foundation

public enum AudioSourceKind: String, Codable, Sendable { case systemAudio, microphone }

/// Raw audio as delivered by a platform source (ScreenCaptureKit gives planar Float32, often 48 kHz stereo).
public struct RawAudioBuffer: Sendable {
    public var kind: AudioSourceKind
    public var hostTimeNs: UInt64          // monotonic, same clock as MonotonicClock
    public var sampleRate: Double
    public var channels: [[Float]]         // planar: channels[c][frame]
    public init(kind: AudioSourceKind, hostTimeNs: UInt64, sampleRate: Double, channels: [[Float]]) {
        self.kind = kind; self.hostTimeNs = hostTimeNs; self.sampleRate = sampleRate; self.channels = channels
    }
    public var frameCount: Int { channels.first?.count ?? 0 }
}

/// Stable output format: PCM s16le, 16 kHz, mono (matches the gateway's RTMS normalisation).
public struct PCMChunk: Equatable, Sendable {
    public static let sampleRate = 16_000
    public var kind: AudioSourceKind
    public var startNs: UInt64
    public var samples: [Int16]
    public var durationNs: UInt64 { UInt64(samples.count) * 1_000_000_000 / UInt64(PCMChunk.sampleRate) }
    public var byteCount: Int { samples.count * 2 }
}

public protocol MonotonicClock { func nowNs() -> UInt64 }
/// Never goes backwards across sleep/NTP/timezone changes (unlike Date()).
public struct SystemMonotonicClock: MonotonicClock {
    public init() {}
    public func nowNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
}

/// Platform audio source (ScreenCaptureKit system audio, or microphone). One instance per kind: never mixed.
public protocol AudioSource: AnyObject {
    var kind: AudioSourceKind { get }
    func start(handler: @escaping (RawAudioBuffer) -> Void) throws
    func stop()   // must be synchronous and idempotent: after return no handler call may be in flight
}

/// Stateful downmix + resample to 16 kHz mono s16. State carries across buffers so chunk edges are seamless.
public final class PCMConverter {
    private var phase: Double = 0          // fractional read position into the "virtual" input stream
    private var lastSample: Float = 0
    private var lastRate: Double = 0
    public init() {}

    public func reset() { phase = 0; lastSample = 0; lastRate = 0 }

    public func convert(_ buf: RawAudioBuffer) -> PCMChunk? {
        guard buf.frameCount > 0, buf.sampleRate > 0 else { return nil }
        if buf.sampleRate != lastRate { reset(); lastRate = buf.sampleRate }
        let n = buf.frameCount, chCount = Double(buf.channels.count)
        var mono = [Float](repeating: 0, count: n)
        for ch in buf.channels where ch.count == n { for i in 0..<n { mono[i] += ch[i] } }
        if chCount > 1 { for i in 0..<n { mono[i] /= Float(chCount) } }

        let step = buf.sampleRate / Double(PCMChunk.sampleRate)
        var out: [Int16] = []
        out.reserveCapacity(Int(Double(n) / step) + 2)
        // q = read position relative to this buffer's first sample; q in [-1, 0) interpolates with the previous buffer's last sample.
        var q = phase
        while true {
            let i0 = Int(q.rounded(.down))
            if i0 + 1 >= n { break }
            let frac = Float(q - Double(i0))
            let a: Float = i0 >= 0 ? mono[i0] : lastSample
            let b = mono[i0 + 1]
            let v = a + (b - a) * frac
            out.append(Int16(max(-1, min(1, v)) * 32767))
            q += step
        }
        phase = q - Double(n)
        lastSample = mono[n - 1]
        return PCMChunk(kind: buf.kind, startNs: buf.hostTimeNs, samples: out)
    }
}
