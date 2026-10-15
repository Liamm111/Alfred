import Foundation

public enum CompanionPhase: Equatable, Sendable {
    case idle, starting, capturing, paused, stopped
    case failed(String)
}

public enum LifecycleEvent: String, Sendable { case willSleep, didWake, screenLocked, screenUnlocked, willTerminate }

public struct LifecyclePolicy: Sendable {
    public var stopOnSleep = true
    public var stopOnLock = true
    public init(stopOnSleep: Bool = true, stopOnLock: Bool = true) { self.stopOnSleep = stopOnSleep; self.stopOnLock = stopOnLock }
}

public struct PersistedState: Codable, Equatable, Sendable {
    public var wasActive: Bool          // capturing or paused when the app last ran
    public var selectionSummary: String?
    public var onboardingDone: Bool
    public var screenRecordingRequested: Bool
    public init(wasActive: Bool = false, selectionSummary: String? = nil, onboardingDone: Bool = false, screenRecordingRequested: Bool = false) {
        self.wasActive = wasActive; self.selectionSummary = selectionSummary; self.onboardingDone = onboardingDone; self.screenRecordingRequested = screenRecordingRequested
    }
}
public protocol StateStore: AnyObject { func load() -> PersistedState; func save(_ s: PersistedState) }

public final class MemoryStateStore: StateStore {
    public var value = PersistedState()
    public init() {}
    public func load() -> PersistedState { value }
    public func save(_ s: PersistedState) { value = s }
}

/// Single source of truth for the UI. Not thread-safe by design: the app calls it from the main actor.
public final class CompanionController {
    public private(set) var phase: CompanionPhase = .idle
    public private(set) var selection: CaptureSelection?
    public private(set) var options: CaptureOptions?
    public private(set) var interruptedByRestart = false
    public private(set) var resumeNeededAfter: LifecycleEvent?
    public private(set) var lastError: String?
    public var onChange: () -> Void = {}

    private let permissions: PermissionProvider
    private let capture: CaptureCoordinator
    private let makeSources: (CaptureOptions) throws -> [AudioSource]
    private let store: StateStore
    private let logger: RedactingLogger
    private let policy: LifecyclePolicy
    private var persisted: PersistedState

    public init(permissions: PermissionProvider, capture: CaptureCoordinator, store: StateStore, logger: RedactingLogger,
                policy: LifecyclePolicy = LifecyclePolicy(), makeSources: @escaping (CaptureOptions) throws -> [AudioSource]) {
        self.permissions = permissions; self.capture = capture; self.store = store; self.logger = logger
        self.policy = policy; self.makeSources = makeSources
        self.persisted = store.load()
        // App restart: whatever was running is NOT resumed. We only tell the user it was interrupted.
        if persisted.wasActive {
            interruptedByRestart = true
            persisted.wasActive = false; store.save(persisted)
            logger.warn("previous session was interrupted by app restart; capture stays OFF until the user starts it")
        }
    }

    public var permissionSnapshot: PermissionSnapshot { permissions.current() }

    public func select(_ s: CaptureSelection) { selection = s; onChange() }

    /// Requires an explicit user action token (button click). Never called by detection or lifecycle code.
    @discardableResult
    public func start(includeMicrophone: Bool = false, microphoneConsent: Bool = false, by action: UserAction) -> Result<Void, CaptureError> {
        guard phase == .idle || phase == .stopped || isFailed else { return .failure(.alreadyRunning) }
        guard let selection else { return fail(.sourceFailed("no selection")) }
        let snap = permissions.current()
        let sr = snap.status(.screenRecording)
        guard sr == .granted else { return fail(.permissionDenied(.screenRecording, sr), keepPhase: true) }
        if includeMicrophone {
            guard microphoneConsent else { return fail(.microphoneConsentMissing, keepPhase: true) }
            let m = snap.status(.microphone)
            guard m == .granted else { return fail(.permissionDenied(.microphone, m), keepPhase: true) }
        }
        let opts = CaptureOptions(selection: selection, includeMicrophone: includeMicrophone, microphoneConsentGiven: microphoneConsent)
        phase = .starting; onChange()
        do {
            try capture.start(sources: try makeSources(opts))
            options = opts; phase = .capturing; lastError = nil; resumeNeededAfter = nil
            persist(active: true)
            logger.info("capture started via \(action.source) selection=\(selection.summary) mic=\(includeMicrophone)")
            onChange(); return .success(())
        } catch {
            capture.stopAll()
            let e = (error as? CaptureError) ?? .sourceFailed(String(describing: error))
            phase = .failed(String(describing: e)); lastError = String(describing: e); persist(active: false)
            logger.error("capture start failed: \(e)"); onChange(); return .failure(e)
        }
    }

    private var isFailed: Bool { if case .failed = phase { return true } else { return false } }

    private func fail(_ e: CaptureError, keepPhase: Bool = false) -> Result<Void, CaptureError> {
        lastError = String(describing: e); logger.warn("start refused: \(e)")
        if !keepPhase { phase = .failed(lastError ?? "") }
        onChange(); return .failure(e)
    }

    /// Pause = stop sources and purge (we do not keep recording silently). Resume restarts them via the same checks.
    public func pause(by action: UserAction) {
        guard phase == .capturing else { return }
        capture.stopAll(); phase = .paused; persist(active: true)
        logger.info("capture paused via \(action.source)"); onChange()
    }

    @discardableResult
    public func resume(by action: UserAction) -> Result<Void, CaptureError> {
        guard phase == .paused else { return .failure(.notRunning) }
        phase = .stopped // so start() re-validates permissions
        return start(includeMicrophone: options?.includeMicrophone ?? false, microphoneConsent: options?.microphoneConsentGiven ?? false, by: action)
    }

    public func stop(by action: UserAction) { stopEverything(reason: "stop via \(action.source)", newPhase: .stopped) }

    /// Global kill switch: audio + microphone stop immediately, buffers purged, state persisted as inactive.
    public func stopAll(by action: UserAction) { stopEverything(reason: "STOP ALL via \(action.source)", newPhase: .stopped) }

    private func stopEverything(reason: String, newPhase: CompanionPhase) {
        capture.stopAll()
        phase = newPhase; persist(active: false)
        logger.info(reason); onChange()
    }

    public func handle(_ e: LifecycleEvent) {
        switch e {
        case .willSleep where policy.stopOnSleep, .screenLocked where policy.stopOnLock:
            if phase == .capturing || phase == .paused || phase == .starting {
                stopEverything(reason: "lifecycle \(e.rawValue): capture stopped and buffers purged", newPhase: .stopped)
                resumeNeededAfter = e
            }
        case .willTerminate:
            stopEverything(reason: "app terminating: capture stopped", newPhase: .stopped)
        case .didWake, .screenUnlocked:
            // NEVER auto-resume. The UI shows "capture stopped by sleep/lock -- restart manually".
            break
        default: break
        }
        onChange()
    }

    public func acknowledgeInterruption() { interruptedByRestart = false; resumeNeededAfter = nil; onChange() }

    public func markScreenRecordingRequested() { persisted.screenRecordingRequested = true; store.save(persisted) }
    public var screenRecordingWasRequested: Bool { persisted.screenRecordingRequested }
    public func completeOnboarding() { persisted.onboardingDone = true; store.save(persisted); onChange() }
    public var onboardingDone: Bool { persisted.onboardingDone }

    private func persist(active: Bool) {
        persisted.wasActive = active; persisted.selectionSummary = selection?.summary; store.save(persisted)
    }
}
