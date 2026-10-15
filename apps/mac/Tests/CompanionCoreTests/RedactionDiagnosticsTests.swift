import XCTest
@testable import CompanionCore

final class RedactionDiagnosticsTests: XCTestCase {
    func testRedaction() {
        let raw = "user bob@example.com url https://us02web.zoom.us/j/12345678901?pwd=AbCdEf123 token=abc123SECRET Bearer eyJhbGciOi.zzz path /Users/bob/Library/x id 12345678901 blob AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        let out = LogRedactor.redact(raw)
        for bad in ["bob", "us02web", "pwd=", "abc123SECRET", "eyJhbGciOi", "12345678901", "AAAAAAAAAAAAAAAAAAAA"] { XCTAssertFalse(out.contains(bad), "\(bad) leaked in: \(out)") }
        XCTAssertTrue(out.contains("/Users/~"))
    }
    func testLoggerRedactsOnWrite() {
        let sink = MemoryLogSink(); RedactingLogger(sink: sink).info("signature=deadbeefdeadbeefdeadbeefdeadbeef joined meeting 987654321")
        XCTAssertFalse(sink.lines[0].contains("deadbeef")); XCTAssertFalse(sink.lines[0].contains("987654321"))
    }
    func testDiagnosticsReportIsRedactedAndComplete() {
        let rep = DiagnosticsReport(appVersion: "0.1.0", osVersion: "macOS 14.5", phase: "capturing",
            permissions: PermissionSnapshot([.screenRecording: .granted, .microphone: .denied]), zoom: ZoomHint(zoomRunning: true, confidence: .low, zoomPID: 1),
            health: nil, bufferBytes: 10, droppedChunks: 0, recentLog: ["error for alice@corp.io /Users/alice/x token=SECRETVALUE"]).render()
        XCTAssertTrue(rep.contains("Permission screenRecording: granted")); XCTAssertTrue(rep.contains("Permission microphone: denied"))
        XCTAssertTrue(rep.contains("hint only"))
        for bad in ["alice", "SECRETVALUE"] { XCTAssertFalse(rep.contains(bad)) }
    }
}
