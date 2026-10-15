import Foundation

public enum PermissionKind: String, CaseIterable, Codable, Sendable {
    case screenRecording   // required: ScreenCaptureKit (also gates system-audio capture)
    case microphone        // optional: separate, explicitly consented, never mixed with system audio
}

/// Distinct states -- the UI must never collapse them into a single "no permission".
public enum PermissionStatus: String, Codable, Sendable {
    case notDetermined   // never asked
    case granted
    case denied          // asked, user said no (or revoked) -> only System Settings can fix it
    case restricted      // MDM / parental controls: the user cannot change it
    case unavailable     // OS or hardware cannot provide it (e.g. no input device, OS too old)
}

public struct PermissionSnapshot: Equatable, Codable, Sendable {
    public var statuses: [PermissionKind: PermissionStatus]
    public init(_ s: [PermissionKind: PermissionStatus] = [:]) {
        var all = s
        for k in PermissionKind.allCases where all[k] == nil { all[k] = .notDetermined }
        statuses = all
    }
    public func status(_ k: PermissionKind) -> PermissionStatus { statuses[k] ?? .notDetermined }
}

public protocol PermissionProvider: AnyObject {
    func current() -> PermissionSnapshot
    /// Triggers the system prompt when possible. Must only be called from an explicit user action (onboarding button).
    func request(_ kind: PermissionKind, completion: @escaping (PermissionStatus) -> Void)
}

/// macOS gives no tri-state for Screen Recording: CGPreflightScreenCaptureAccess() is just true/false.
/// We recover "denied" vs "not determined" by remembering that we already asked.
public enum ScreenRecordingResolver {
    public static func resolve(preflightGranted: Bool, alreadyRequested: Bool, osSupportsScreenCaptureKit: Bool = true) -> PermissionStatus {
        if !osSupportsScreenCaptureKit { return .unavailable }
        if preflightGranted { return .granted }
        return alreadyRequested ? .denied : .notDetermined
    }
}
