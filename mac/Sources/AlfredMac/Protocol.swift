import Foundation
import CoreVideo
import Accelerate

struct RectDTO: Codable { var x: Int; var y: Int; var w: Int; var h: Int }
struct WindowDTO: Codable { var window_id: Int; var bundle_id: String; var title: String; var display_id: Int; var on_screen: Bool; var minimized: Bool; var layer: Int; var frame: RectDTO }
struct OcrLineDTO: Codable { var text: String; var confidence: Double; var bbox: RectDTO }

/// Luminance 8 bits en mémoire uniquement.
struct GrayFrame {
    let width: Int, height: Int, data: Data
    init(pixelBuffer pb: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pb, .readOnly); defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        var out = Data(count: w * h)
        out.withUnsafeMutableBytes { dst in
            for y in 0..<h { for x in 0..<w {
                let p = base + y * bpr + x * 4   // BGRA
                dst[y * w + x] = UInt8((Int(p[2]) * 77 + Int(p[1]) * 150 + Int(p[0]) * 29) >> 8)
            } }
        }
        width = w; height = h; data = out
    }
}

/// NDJSON sur stdout → src/vision/native_bridge.ts
enum Message {
    case permission(granted: Bool, reason: String)
    case snapshot(windows: [WindowDTO], localMs: Int)
    case frame(gray: GrayFrame, lines: [OcrLineDTO], localMs: Int)

    var json: String {
        let e = JSONEncoder()
        func s<T: Encodable>(_ v: T) -> String { String(data: try! e.encode(v), encoding: .utf8)! }
        switch self {
        case let .permission(g, r): return "{\"type\":\"permission\",\"granted\":\(g),\"reason\":\"\(r)\"}"
        case let .snapshot(w, t): return "{\"type\":\"snapshot\",\"local_ms\":\(t),\"windows\":\(s(w))}"
        case let .frame(g, l, t): return "{\"type\":\"frame\",\"local_ms\":\(t),\"width\":\(g.width),\"height\":\(g.height),\"gray_b64\":\"\(g.data.base64EncodedString())\",\"ocr\":\(s(l))}"
        }
    }
}
