import Vision
import CoreVideo

enum VisionOCR {
    /// OCR 100 % local (Vision). FR + EN. Pas d'envoi réseau.
    static func recognize(pixelBuffer: CVPixelBuffer) -> [OcrLineDTO] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["fr-FR", "en-US"]
        req.usesLanguageCorrection = true
        req.minimumTextHeight = 0            // on laisse le TS écarter ce qui est < 9 px, avec trace
        let h = CVPixelBufferGetHeight(pixelBuffer), w = CVPixelBufferGetWidth(pixelBuffer)
        try? VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:]).perform([req])
        return (req.results ?? []).compactMap { o in
            guard let top = o.topCandidates(1).first else { return nil }
            let b = o.boundingBox // normalisé, origine en bas à gauche
            return OcrLineDTO(text: top.string, confidence: Double(top.confidence),
                              bbox: .init(x: Int(b.minX * Double(w)), y: Int((1 - b.maxY) * Double(h)), w: Int(b.width * Double(w)), h: Int(b.height * Double(h))))
        }
    }
}
