import Foundation

/// What to capture. There is NO default: the user must pick one explicitly.
public enum CaptureSelection: Equatable, Codable, Sendable {
    case window(id: UInt32, title: String)
    case application(bundleID: String, name: String)
    case display(id: UInt32)

    public var summary: String {
        switch self {
        case .window(_, let t): return "Fenêtre : \(t)"
        case .application(_, let n): return "Application : \(n)"
        case .display(let id): return "Écran #\(id)"
        }
    }
    /// Window filters are NOT assumed to isolate audio per window -- see IsolationProbe. Application filter is the documented audio scope.
    public var isolationValidatedByDefault: Bool { false }
}

public struct CaptureOptions: Equatable, Sendable {
    public var selection: CaptureSelection
    public var includeMicrophone: Bool          // separate source, explicit consent, never mixed
    public var microphoneConsentGiven: Bool
    public init(selection: CaptureSelection, includeMicrophone: Bool = false, microphoneConsentGiven: Bool = false) {
        self.selection = selection; self.includeMicrophone = includeMicrophone; self.microphoneConsentGiven = microphoneConsentGiven
    }
}

public enum CaptureError: Error, Equatable {
    case permissionDenied(PermissionKind, PermissionStatus)
    case microphoneConsentMissing
    case alreadyRunning
    case notRunning
    case sourceFailed(String)
}

public enum PurgePolicy: Sendable { case purgeOnStop, keepForDrain }

/// Pipeline: sources -> converter (per kind) -> health monitor (per kind) -> encrypted ring buffer.
/// `stopAll()` closes the intake gate FIRST, so late callbacks from platform threads are dropped, then stops sources and purges.
public final class CaptureCoordinator {
    private let lock = NSLock()
    private var accepting = false
    private var sources: [AudioSource] = []
    private var converters: [AudioSourceKind: PCMConverter] = [:]
    public private(set) var monitors: [AudioSourceKind: AudioHealthMonitor] = [:]
    public let buffer: EncryptedRingBuffer
    private let clock: MonotonicClock
    private let purgePolicy: PurgePolicy

    public init(buffer: EncryptedRingBuffer, clock: MonotonicClock = SystemMonotonicClock(), purgePolicy: PurgePolicy = .purgeOnStop) {
        self.buffer = buffer; self.clock = clock; self.purgePolicy = purgePolicy
    }

    public var isRunning: Bool { lock.lock(); defer { lock.unlock() }; return accepting }

    public func start(sources new: [AudioSource]) throws {
        lock.lock()
        if accepting { lock.unlock(); throw CaptureError.alreadyRunning }
        accepting = true; sources = new
        converters = [:]; monitors = [:]
        for s in new { converters[s.kind] = PCMConverter(); monitors[s.kind] = AudioHealthMonitor() }
        lock.unlock()
        do {
            for s in new { try s.start { [weak self] raw in self?.ingest(raw) } }
        } catch {
            stopAll()
            throw CaptureError.sourceFailed(String(describing: error))
        }
    }

    private func ingest(_ raw: RawAudioBuffer) {
        lock.lock()
        guard accepting, let conv = converters[raw.kind] else { lock.unlock(); return }
        let chunk = conv.convert(raw)
        if let chunk { monitors[raw.kind]?.ingest(chunk) }
        lock.unlock()
        if let chunk { buffer.append(chunk) }
    }

    public func health(_ kind: AudioSourceKind) -> AudioHealthSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return monitors[kind]?.snapshot(nowNs: clock.nowNs())
    }

    /// Immediate. Idempotent. Never throws.
    public func stopAll() {
        lock.lock(); accepting = false; let toStop = sources; sources = []; lock.unlock()
        for s in toStop { s.stop() }
        if purgePolicy == .purgeOnStop { buffer.purge() }
    }
}
