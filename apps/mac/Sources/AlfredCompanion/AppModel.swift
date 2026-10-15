import AppKit
import ScreenCaptureKit
import SwiftUI
import CompanionCore

/// Optional launch arguments so a UI test (XCUITest) can force a state without touching real permissions:
///   --uitest-permission=denied|granted|restricted|notDetermined
struct UITestScenario {
    var forced: PermissionStatus?
    init(_ args: [String] = ProcessInfo.processInfo.arguments) {
        if let a = args.first(where: { $0.hasPrefix("--uitest-permission=") }) { forced = PermissionStatus(rawValue: String(a.dropFirst("--uitest-permission=".count))) }
    }
}
final class StubPermissions: PermissionProvider {
    var status: PermissionStatus
    init(_ s: PermissionStatus) { status = s }
    func current() -> PermissionSnapshot { PermissionSnapshot([.screenRecording: status, .microphone: status]) }
    func request(_ kind: PermissionKind, completion: @escaping (PermissionStatus) -> Void) { completion(status) }
}

struct SourceChoice: Identifiable, Hashable {
    let id: String; let label: String; let selection: CaptureSelection
    static func == (l: Self, r: Self) -> Bool { l.id == r.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var presentation: StatusPresentation
    @Published private(set) var zoomHint: ZoomHint = .none
    @Published private(set) var health: AudioHealthSnapshot?
    @Published private(set) var choices: [SourceChoice] = []
    @Published var chosen: SourceChoice? { didSet { chooseChanged() } }
    @Published var includeMicrophone = false
    @Published var microphoneConsent = false
    @Published private(set) var diagnosticsText = ""
    @Published var consentGiven = false
    @Published var zoomGuideSeen = false
    @Published var micSkipped = false

    let controller: CompanionController
    private let permissions: PermissionProvider
    private let capture: CaptureCoordinator
    private let logSink = FileLogSink()
    private let logger: RedactingLogger
    private let processes = MacProcessWindowProvider()
    private let focus = ZoomFocusCoordinator(focuser: MacZoomFocuser())
    private var lifecycle: LifecycleObserver?
    private let filterStore = FilterStore()
    private var timer: Timer?

    private init() {
        let store = FileStateStore()
        let logSink = self.logSink
        let logger = RedactingLogger(sink: logSink)
        self.logger = logger
        let buffer = EncryptedRingBuffer(capacityBytes: 64 << 20)   // ~35 min of 16 kHz mono s16, then oldest dropped
        let capture = CaptureCoordinator(buffer: buffer, clock: HostTimeClock(), purgePolicy: .purgeOnStop)
        self.capture = capture
        let filterStore = self.filterStore
        let scenario = UITestScenario()
        let box = ControllerBox()
        let permissions: PermissionProvider = scenario.forced.map { StubPermissions($0) as PermissionProvider }
            ?? MacPermissionProvider(wasRequested: { box.controller?.screenRecordingWasRequested ?? store.load().screenRecordingRequested },
                                  markRequested: { box.controller?.markScreenRecordingRequested() })
        self.permissions = permissions
        let failure = FailureRelay()
        let controller = CompanionController(permissions: permissions, capture: capture, store: store, logger: logger) { opts in
            try buildSources(opts, filters: filterStore, onFailure: { failure.fire($0) })
        }
        self.controller = controller
        box.controller = controller
        presentation = StatusPresenter.make(phase: .idle, permissions: permissions.current(), selection: nil, zoom: .none,
                                            interruptedByRestart: controller.interruptedByRestart, resumeNeededAfter: nil, health: nil)
        failure.handler = { [weak self] msg in
            DispatchQueue.main.async { logger.error(msg); self?.controller.stopAll(by: UserAction(source: "stream-failure")) }
        }
        consentGiven = controller.onboardingDone
        startObservers()
    }

    private func startObservers() {
        controller.onChange = { [weak self] in Task { @MainActor [weak self] in self?.refresh() } }
        lifecycle = LifecycleObserver { [weak self] e in Task { @MainActor [weak self] in self?.controller.handle(e) } }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor [weak self] in self?.refresh() } }
        Task { await reloadChoices() }
    }

    private func filterKey(_ s: CaptureSelection) -> String { s.summary }

    func reloadChoices() async {
        guard CGPreflightScreenCaptureAccess(), let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else { choices = []; return }
        var list: [SourceChoice] = []; var map: [String: SCContentFilter] = [:]
        let display = content.displays.first
        for app in content.applications where !app.applicationName.isEmpty {
            guard let d = display else { break }
            let sel = CaptureSelection.application(bundleID: app.bundleIdentifier, name: app.applicationName)
            list.append(SourceChoice(id: "app:\(app.bundleIdentifier)", label: "App — \(app.applicationName)", selection: sel))
            map[filterKey(sel)] = SCContentFilter(display: d, including: [app], exceptingWindows: [])
        }
        for w in content.windows where w.isOnScreen && !(w.title ?? "").isEmpty {
            let sel = CaptureSelection.window(id: w.windowID, title: "\(w.owningApplication?.applicationName ?? "?") — \(w.title ?? "")")
            list.append(SourceChoice(id: "win:\(w.windowID)", label: "Fenêtre — \(sel.summary.dropFirst(10))", selection: sel))
            map[filterKey(sel)] = SCContentFilter(desktopIndependentWindow: w)
        }
        for d in content.displays {
            let sel = CaptureSelection.display(id: d.displayID)
            list.append(SourceChoice(id: "disp:\(d.displayID)", label: "Écran #\(d.displayID) (tout l’audio système)", selection: sel))
            map[filterKey(sel)] = SCContentFilter(display: d, excludingApplications: [], exceptingWindows: [])
        }
        filterStore.set(map); choices = list
    }

    private func chooseChanged() { if let c = chosen { controller.select(c.selection) } }

    // MARK: actions -- each one is a button handler and carries a UserAction
    func start(from src: String) { _ = controller.start(includeMicrophone: includeMicrophone, microphoneConsent: microphoneConsent, by: UserAction(source: src)) }
    func pause(from src: String) { controller.pause(by: UserAction(source: src)) }
    func resume(from src: String) { _ = controller.resume(by: UserAction(source: src)) }
    func stop(from src: String) { controller.stop(by: UserAction(source: src)) }
    func stopAll(from src: String) { controller.stopAll(by: UserAction(source: src)) }
    func openZoom(from src: String) { focus.focusZoom(UserAction(source: src)) }
    func request(_ k: PermissionKind) { permissions.request(k) { [weak self] _ in Task { @MainActor [weak self] in self?.refresh(); await self?.reloadChoices() } } }
    func openSettings(_ k: PermissionKind) {
        let pane = k == .screenRecording ? "Privacy_ScreenCapture" : "Privacy_Microphone"
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    }
    func completeConsent() { consentGiven = true; controller.completeOnboarding() }

    func refresh() {
        zoomHint = ZoomHintDetector.detect(processes)
        health = capture.health(.systemAudio)
        let perms = permissions.current()
        presentation = StatusPresenter.make(phase: controller.phase, permissions: perms, selection: controller.selection, zoom: zoomHint,
                                            interruptedByRestart: controller.interruptedByRestart, resumeNeededAfter: controller.resumeNeededAfter, health: health)
        diagnosticsText = DiagnosticsReport(
            appVersion: CompanionCoreVersion.string, osVersion: ProcessInfo.processInfo.operatingSystemVersionString, phase: "\(controller.phase)",
            permissions: perms, zoom: zoomHint, health: health, bufferBytes: capture.buffer.stats.bytes, droppedChunks: capture.buffer.stats.droppedChunks,
            recentLog: logSink.recent).render()
    }

    var onboarding: OnboardingState {
        Onboarding.next(consentGiven: consentGiven, permissions: permissions.current(), microphoneSkipped: micSkipped, zoomAppGuideSeen: zoomGuideSeen)
    }
}

// MARK: helpers usable from non-main threads
final class FilterStore: @unchecked Sendable {
    private let lock = NSLock(); private var map: [String: SCContentFilter] = [:]
    func set(_ m: [String: SCContentFilter]) { lock.lock(); map = m; lock.unlock() }
    func get(_ key: String) -> SCContentFilter? { lock.lock(); defer { lock.unlock() }; return map[key] }
}
final class ControllerBox: @unchecked Sendable { weak var controller: CompanionController? }
final class FailureRelay: @unchecked Sendable { var handler: ((String) -> Void)?; func fire(_ m: String) { handler?(m) } }

func buildSources(_ o: CaptureOptions, filters: FilterStore, onFailure: @escaping (String) -> Void) throws -> [AudioSource] {
    guard let f = filters.get(o.selection.summary) else { throw SourceError.filterMissing }
    var sources: [AudioSource] = [ScreenCaptureKitSource(filter: f, onFailure: onFailure)]
    if o.includeMicrophone && o.microphoneConsentGiven { sources.append(MicrophoneSource()) }
    return sources
}
