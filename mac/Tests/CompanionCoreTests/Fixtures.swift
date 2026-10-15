import Foundation
@testable import CompanionCore

final class FakePermissions: PermissionProvider {
    var snap: PermissionSnapshot
    var requested: [PermissionKind] = []
    init(_ s: [PermissionKind: PermissionStatus] = [.screenRecording: .granted, .microphone: .granted]) { snap = PermissionSnapshot(s) }
    func current() -> PermissionSnapshot { snap }
    func request(_ kind: PermissionKind, completion: @escaping (PermissionStatus) -> Void) { requested.append(kind); completion(snap.status(kind)) }
}

final class FakeSource: AudioSource {
    let kind: AudioSourceKind
    var handler: ((RawAudioBuffer) -> Void)?
    var startCount = 0, stopCount = 0
    var failOnStart = false
    init(_ k: AudioSourceKind) { kind = k }
    func start(handler: @escaping (RawAudioBuffer) -> Void) throws {
        startCount += 1
        if failOnStart { throw CaptureError.sourceFailed("boom") }
        self.handler = handler
    }
    func stop() { stopCount += 1 }                       // NB: keeps the handler, to simulate a late callback from a platform thread
    func emit(_ b: RawAudioBuffer) { handler?(b) }
}

final class FakeFocuser: ZoomFocuser { var count = 0; func bringZoomToFront() { count += 1 } }

final class FakeProcesses: ProcessWindowProvider {
    var apps: [RunningAppInfo] = []; var wins: [WindowInfo] = []
    func runningApps() -> [RunningAppInfo] { apps }
    func windows() -> [WindowInfo] { wins }
}

struct TestClock: MonotonicClock { var t: UInt64; func nowNs() -> UInt64 { t } }

func sine(frames: Int, rate: Double, hz: Double = 440, amp: Float = 0.5, offset: Int = 0) -> [Float] {
    (0..<frames).map { amp * Float(sin(2 * Double.pi * hz * Double(offset + $0) / rate)) }
}
func raw(_ kind: AudioSourceKind = .systemAudio, ns: UInt64 = 1_000_000_000, rate: Double = 48_000, frames: Int = 960, amp: Float = 0.5, channels: Int = 2, offset: Int = 0) -> RawAudioBuffer {
    RawAudioBuffer(kind: kind, hostTimeNs: ns, sampleRate: rate, channels: Array(repeating: sine(frames: frames, rate: rate, amp: amp, offset: offset), count: channels))
}
func pcm(_ ms: Int, ns: UInt64, amp: Int16 = 8000, kind: AudioSourceKind = .systemAudio) -> PCMChunk {
    PCMChunk(kind: kind, startNs: ns, samples: (0..<(ms * 16)).map { Int16(Double(amp) * sin(2 * .pi * 440 * Double($0) / 16000)) })
}

struct Rig {
    let perms: FakePermissions, store: MemoryStateStore, sys: FakeSource, mic: FakeSource, buffer: EncryptedRingBuffer
    let capture: CaptureCoordinator, controller: CompanionController, log: MemoryLogSink
    var factoryCalls: () -> Int
}

func makeRig(perms: [PermissionKind: PermissionStatus] = [.screenRecording: .granted, .microphone: .granted],
             store: MemoryStateStore = MemoryStateStore(), policy: LifecyclePolicy = LifecyclePolicy(), selected: Bool = true,
             failStart: Bool = false) -> Rig {
    let p = FakePermissions(perms), sys = FakeSource(.systemAudio), mic = FakeSource(.microphone)
    sys.failOnStart = failStart
    let buffer = EncryptedRingBuffer(capacityBytes: 1 << 20)
    let capture = CaptureCoordinator(buffer: buffer, clock: TestClock(t: 2_000_000_000))
    let log = MemoryLogSink()
    var calls = 0
    let c = CompanionController(permissions: p, capture: capture, store: store, logger: RedactingLogger(sink: log), policy: policy) { o in
        calls += 1; return o.includeMicrophone ? [sys, mic] : [sys]
    }
    if selected { c.select(.application(bundleID: "us.zoom.xos", name: "zoom.us")) }
    return Rig(perms: p, store: store, sys: sys, mic: mic, buffer: buffer, capture: capture, controller: c, log: log, factoryCalls: { calls })
}
let click = UserAction(source: "test-click")
