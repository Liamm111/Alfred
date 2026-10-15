import AppKit
import AVFoundation
import CoreGraphics
import CompanionCore

/// Permission provider backed by real macOS APIs. `request` is only reachable from onboarding buttons.
final class MacPermissionProvider: PermissionProvider {
    private let wasRequested: () -> Bool
    private let markRequested: () -> Void
    init(wasRequested: @escaping () -> Bool, markRequested: @escaping () -> Void) { self.wasRequested = wasRequested; self.markRequested = markRequested }

    func current() -> PermissionSnapshot {
        let sr = ScreenRecordingResolver.resolve(preflightGranted: CGPreflightScreenCaptureAccess(), alreadyRequested: wasRequested())
        let mic: PermissionStatus
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined: mic = .notDetermined
        case .authorized: mic = .granted
        case .denied: mic = .denied
        case .restricted: mic = .restricted
        @unknown default: mic = .unavailable
        }
        return PermissionSnapshot([.screenRecording: sr, .microphone: mic])
    }

    func request(_ kind: PermissionKind, completion: @escaping (PermissionStatus) -> Void) {
        switch kind {
        case .screenRecording:
            markRequested()
            _ = CGRequestScreenCaptureAccess()          // shows the system prompt once; later calls do nothing
            completion(current().status(.screenRecording))
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
                DispatchQueue.main.async { completion(self?.current().status(.microphone) ?? .unavailable) }
            }
        }
    }
}

/// Zoom detection input. Window titles are only available when Screen Recording is granted -- that is fine, it is only a hint.
final class MacProcessWindowProvider: ProcessWindowProvider {
    func runningApps() -> [RunningAppInfo] {
        NSWorkspace.shared.runningApplications.map { RunningAppInfo(bundleID: $0.bundleIdentifier, name: $0.localizedName ?? "?", pid: $0.processIdentifier) }
    }
    func windows() -> [WindowInfo] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32 else { return nil }
            return WindowInfo(ownerPID: pid, ownerName: w[kCGWindowOwnerName as String] as? String ?? "", title: w[kCGWindowName as String] as? String, onScreen: true)
        }
    }
}

/// Brings Zoom to the front. Only ever invoked through ZoomFocusCoordinator.focusZoom(UserAction) from a button handler.
final class MacZoomFocuser: ZoomFocuser {
    func bringZoomToFront() {
        NSRunningApplication.runningApplications(withBundleIdentifier: ZoomHintDetector.bundleID).first?.activate(options: [.activateIgnoringOtherApps])
    }
}

/// Translates sleep / wake / lock / quit notifications into core lifecycle events.
final class LifecycleObserver {
    private var tokens: [(NotificationCenter, NSObjectProtocol)] = []
    init(_ send: @escaping (LifecycleEvent) -> Void) {
        let ws = NSWorkspace.shared.notificationCenter, dist = DistributedNotificationCenter.default()
        func add(_ c: NotificationCenter, _ n: Notification.Name, _ e: LifecycleEvent) {
            tokens.append((c, c.addObserver(forName: n, object: nil, queue: .main) { _ in send(e) }))
        }
        add(ws, NSWorkspace.willSleepNotification, .willSleep)
        add(ws, NSWorkspace.didWakeNotification, .didWake)
        add(dist, Notification.Name("com.apple.screenIsLocked"), .screenLocked)      // undocumented-but-stable distributed notifications
        add(dist, Notification.Name("com.apple.screenIsUnlocked"), .screenUnlocked)
        add(NotificationCenter.default, NSApplication.willTerminateNotification, .willTerminate)
    }
    deinit { tokens.forEach { $0.0.removeObserver($0.1) } }
}

/// Redacted file log: ~/Library/Logs/AlfredCompanion/companion.log (RedactingLogger redacts BEFORE this sink sees the line).
final class FileLogSink: LogSink {
    private let url: URL
    private let queue = DispatchQueue(label: "alfred.log")
    private(set) var recent: [String] = []
    init() {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/AlfredCompanion")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("companion.log")
    }
    func write(_ line: String) {
        queue.async { [url] in
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close() }
            else { try? Data((line + "\n").utf8).write(to: url) }
        }
        DispatchQueue.main.async { self.recent.append(line); if self.recent.count > 200 { self.recent.removeFirst(100) } }
    }
}

struct FileStateStore: StateStore {
    private let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AlfredCompanion/state.json")
    func load() -> PersistedState { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(PersistedState.self, from: $0) } ?? PersistedState() }
    func save(_ s: PersistedState) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(s).write(to: url, options: .atomic)
    }
}
