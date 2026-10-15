import Foundation

public enum StatusLevel: String, Sendable { case off, ok, attention, error }

public struct StatusPresentation: Equatable, Sendable {
    public var symbolName: String          // SF Symbol
    public var title: String
    public var subtitle: String
    public var level: StatusLevel
    public var canStart: Bool
    public var canPause: Bool
    public var canResume: Bool
    public var canStop: Bool
    public var canStopAll: Bool            // the global kill switch is available whenever anything could be running
    public var banner: Banner?
    public var zoomLine: String

    public struct Banner: Equatable, Sendable {
        public var text: String
        public var offersOpenSettings: PermissionKind?   // button "Ouvrir Réglages Système" for this permission
    }
}

public enum StatusPresenter {
    public static func make(phase: CompanionPhase, permissions: PermissionSnapshot, selection: CaptureSelection?, zoom: ZoomHint,
                            interruptedByRestart: Bool, resumeNeededAfter: LifecycleEvent?, health: AudioHealthSnapshot?) -> StatusPresentation {
        let sr = permissions.status(.screenRecording)
        var banner: StatusPresentation.Banner?
        switch sr {
        case .denied: banner = .init(text: "Enregistrement d’écran refusé. Autorisez Alfred dans Réglages Système › Confidentialité › Enregistrement d’écran, puis relancez l’app.", offersOpenSettings: .screenRecording)
        case .restricted: banner = .init(text: "Enregistrement d’écran restreint par votre organisation : impossible de l’activer ici.", offersOpenSettings: nil)
        case .unavailable: banner = .init(text: "Capture d’écran/audio non disponible sur ce Mac (macOS 13+ requis).", offersOpenSettings: nil)
        case .notDetermined: banner = .init(text: "Permission d’enregistrement d’écran non demandée : lancez l’onboarding.", offersOpenSettings: nil)
        case .granted: break
        }
        if banner == nil, interruptedByRestart { banner = .init(text: "La capture précédente a été interrompue par un redémarrage. Rien n’est repris automatiquement.", offersOpenSettings: nil) }
        if banner == nil, let e = resumeNeededAfter { banner = .init(text: e == .willSleep ? "Capture arrêtée par la mise en veille. Redémarrez-la manuellement." : "Capture arrêtée par le verrouillage. Redémarrez-la manuellement.", offersOpenSettings: nil) }

        let zoomLine: String = {
            guard zoom.zoomRunning else { return "Zoom non détecté" }
            return zoom.confidence == .medium ? "Zoom semble en réunion (indice seulement)" : "Zoom ouvert (indice seulement)"
        }()
        let canStart = (phase == .idle || phase == .stopped || { if case .failed = phase { return true } else { return false } }())
            && sr == .granted && selection != nil
        let running = phase == .capturing || phase == .paused || phase == .starting
        var p = StatusPresentation(symbolName: "mic.slash", title: "Inactif", subtitle: selection?.summary ?? "Aucune source choisie", level: .off,
                                   canStart: canStart, canPause: phase == .capturing, canResume: phase == .paused && sr == .granted,
                                   canStop: running, canStopAll: running, banner: banner, zoomLine: zoomLine)
        switch phase {
        case .idle: break
        case .starting: p.title = "Démarrage…"; p.symbolName = "hourglass"; p.level = .attention
        case .capturing:
            p.title = "Capture en cours"; p.symbolName = "waveform"; p.level = .ok
            switch health?.status {
            case .silent?: p.subtitle = "Source silencieuse"; p.level = .attention
            case .absent?: p.subtitle = "Aucun audio reçu"; p.level = .attention
            case .gap?: p.subtitle = "Coupure audio détectée"; p.level = .attention
            default: break
            }
        case .paused: p.title = "En pause"; p.symbolName = "pause.circle"; p.level = .attention
        case .stopped: p.title = "Arrêté"; p.symbolName = "stop.circle"
        case .failed(let why): p.title = "Erreur"; p.subtitle = LogRedactor.redact(why); p.symbolName = "exclamationmark.triangle"; p.level = .error
        }
        if sr == .denied && !running { p.level = .error; p.symbolName = "lock.slash" }
        return p
    }
}
