import Foundation

public enum OnboardingStep: String, CaseIterable, Sendable {
    case consent, screenRecording, microphone, zoomApp, done
}

public struct OnboardingState: Equatable, Sendable {
    public var step: OnboardingStep
    public var instruction: String
    public var action: Action?
    public enum Action: Equatable, Sendable { case requestPermission(PermissionKind), openSystemSettings(PermissionKind), openZoomAppGuide, acknowledgeConsent, none }
}

public enum Onboarding {
    /// Pure function of what the user already did -> next screen. Optional steps can be skipped.
    public static func next(consentGiven: Bool, permissions: PermissionSnapshot, microphoneSkipped: Bool, zoomAppGuideSeen: Bool) -> OnboardingState {
        if !consentGiven {
            return .init(step: .consent, instruction: "Alfred ne capture que la source que vous choisissez, uniquement après votre clic. Vous pouvez tout arrêter à tout moment.", action: .acknowledgeConsent)
        }
        switch permissions.status(.screenRecording) {
        case .notDetermined: return .init(step: .screenRecording, instruction: "Autorisez l’enregistrement d’écran (nécessaire pour capter l’audio de l’app).", action: .requestPermission(.screenRecording))
        case .denied: return .init(step: .screenRecording, instruction: "Refusé : activez Alfred dans Réglages Système › Confidentialité › Enregistrement d’écran, puis relancez l’app.", action: .openSystemSettings(.screenRecording))
        case .restricted, .unavailable: return .init(step: .screenRecording, instruction: "Indisponible sur ce Mac (restriction ou version de macOS).", action: OnboardingState.Action.none)
        case .granted: break
        }
        if !microphoneSkipped {
            switch permissions.status(.microphone) {
            case .notDetermined: return .init(step: .microphone, instruction: "Optionnel : autoriser le micro (source séparée). Vous pouvez passer.", action: .requestPermission(.microphone))
            case .denied: return .init(step: .microphone, instruction: "Micro refusé. Optionnel : activez-le dans Réglages Système ou passez.", action: .openSystemSettings(.microphone))
            default: break
            }
        }
        if !zoomAppGuideSeen { return .init(step: .zoomApp, instruction: "Ouvrez l’app Alfred dans Zoom pendant une réunion pour activer RTMS. L’app Mac ne se connecte jamais à Zoom à votre place.", action: .openZoomAppGuide) }
        return .init(step: .done, instruction: "Prêt.", action: OnboardingState.Action.none)
    }
}
