import Foundation

public struct RunningAppInfo: Equatable, Sendable {
    public var bundleID: String?; public var name: String; public var pid: Int32
    public init(bundleID: String?, name: String, pid: Int32) { self.bundleID = bundleID; self.name = name; self.pid = pid }
}
public struct WindowInfo: Equatable, Sendable {
    public var ownerPID: Int32; public var ownerName: String; public var title: String?; public var onScreen: Bool
    public init(ownerPID: Int32, ownerName: String, title: String?, onScreen: Bool) { self.ownerPID = ownerPID; self.ownerName = ownerName; self.title = title; self.onScreen = onScreen }
}
public protocol ProcessWindowProvider: AnyObject {
    func runningApps() -> [RunningAppInfo]
    func windows() -> [WindowInfo]
}

/// A HINT only. It is displayed to the user ("Zoom seems to be in a meeting"); it never starts, selects or enables anything.
/// There is deliberately no API on this type (or on ZoomHintDetector) that can trigger a capture.
public struct ZoomHint: Equatable, Sendable {
    public enum Confidence: String, Sendable { case none, low, medium }
    public var zoomRunning: Bool
    public var confidence: Confidence
    public var zoomPID: Int32?
    public static let none = ZoomHint(zoomRunning: false, confidence: .none, zoomPID: nil)
}

public enum ZoomHintDetector {
    public static let bundleID = "us.zoom.xos"
    static let meetingTitles = ["zoom meeting", "zoom webinar", "réunion zoom", "zoom workplace"]

    public static func detect(_ p: ProcessWindowProvider) -> ZoomHint {
        guard let app = p.runningApps().first(where: { $0.bundleID == bundleID }) else { return .none }
        let wins = p.windows().filter { $0.ownerPID == app.pid && $0.onScreen }
        // Window titles are only visible when Screen Recording is granted; without it we can only say "Zoom runs".
        let meetingLike = wins.contains { w in
            guard let t = w.title?.lowercased() else { return false }
            return meetingTitles.contains { t.contains($0) } && !t.contains("zoom workplace") // home window is not a meeting
        }
        return ZoomHint(zoomRunning: true, confidence: meetingLike ? .medium : .low, zoomPID: app.pid)
    }
}

/// Proof-of-intent token. Created ONLY by UI button handlers; required by every action that touches another app.
public struct UserAction: Sendable {
    public let source: String
    public init(source: String) { self.source = source }
}

public protocol ZoomFocuser: AnyObject { func bringZoomToFront() }

/// Zoom is brought to the front only after an explicit click (e.g. "Open Zoom" button). Never from detection, wake, or start.
public final class ZoomFocusCoordinator {
    private let focuser: ZoomFocuser
    public init(focuser: ZoomFocuser) { self.focuser = focuser }
    public func focusZoom(_ action: UserAction) { focuser.bringZoomToFront() }
}
