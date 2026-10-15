import ScreenCaptureKit
import CoreMedia
import CoreVideo

/// Capture strictement limitée à ce que l'utilisateur choisit dans le sélecteur système.
/// Aucune énumération « silencieuse » : le contenu capturé vient du SCContentFilter fourni par le picker.
final class SharePicker: NSObject, SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let emit: (Message) -> Void
    private let sampleQueue = DispatchQueue(label: "alfred.capture")
    private var lastEmit = CMTime.invalid

    init(emit: @escaping (Message) -> Void) { self.emit = emit }

    func present() {
        let picker = SCContentSharingPicker.shared
        var cfg = SCContentSharingPickerConfiguration()
        cfg.allowedPickerModes = [.singleWindow, .multipleWindows, .singleDisplay]
        cfg.allowsChangingSelectedContent = true
        picker.defaultConfiguration = cfg
        picker.add(self)
        picker.isActive = true
        picker.present()
    }

    // MARK: picker
    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { await start(filter: filter) }
    }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) { emit(.permission(granted: false, reason: "picker_cancelled")) }
    func contentSharingPickerStartDidFailWithError(_ error: Error) { emit(.permission(granted: false, reason: "picker_error")) }

    private func start(filter: SCContentFilter) async {
        try? await stream?.stopCapture()
        let cfg = SCStreamConfiguration()
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)   // ≤ 1 image/s ; le TS plafonne encore à 2/s max
        cfg.showsCursor = false
        cfg.queueDepth = 3
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            try await s.startCapture()
            stream = s
            emit(.permission(granted: true, reason: "picker_granted"))
        } catch { emit(.permission(granted: false, reason: "start_failed")) }
    }

    // MARK: delegate — la permission retirée en cours de capture arrive ici
    func stream(_ stream: SCStream, didStopWithError error: Error) { emit(.permission(granted: false, reason: "stream_stopped")) }

    // MARK: frames
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        // Seules les frames « complete » portent des pixels exploitables (les autres: idle/blank/suspended).
        guard let atts = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = atts[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        let gray = GrayFrame(pixelBuffer: pb)
        let lines = VisionOCR.recognize(pixelBuffer: pb)   // OCR local, image jamais écrite sur disque ici
        emit(.frame(gray: gray, lines: lines, localMs: Int(Date().timeIntervalSince1970 * 1000)))
    }
}

/// Instantané des fenêtres, pour détecter apparition/disparition/Space/écran.
enum WindowSnapshot {
    static func take() async -> [WindowDTO] {
        guard let c = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) else { return [] }
        return c.windows.compactMap { w in
            guard let bid = w.owningApplication?.bundleIdentifier else { return nil }
            // `minimized` n'est pas exposé par ScreenCaptureKit : isOnScreen=false regroupe réduit + autre Space + masqué.
            // Distinguer « réduit » exige l'API Accessibilité (kAXMinimizedAttribute) = permission supplémentaire → dette BLOC 08.
            return WindowDTO(window_id: Int(w.windowID), bundle_id: bid, title: w.title ?? "",
                             display_id: Int(c.displays.first { $0.frame.intersects(w.frame) }?.displayID ?? 0),
                             on_screen: w.isOnScreen, minimized: false, layer: w.windowLayer,
                             frame: .init(x: Int(w.frame.minX), y: Int(w.frame.minY), w: Int(w.frame.width), h: Int(w.frame.height)))
        }
    }
}
