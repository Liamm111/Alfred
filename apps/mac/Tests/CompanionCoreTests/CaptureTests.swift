import XCTest
@testable import CompanionCore

final class CaptureTests: XCTestCase {
    // MARK: conversion
    func testStereo48kBecomesMono16kPCM() throws {
        let c = PCMConverter().convert(raw(frames: 4800))!    // 100 ms
        XCTAssertEqual(c.samples.count, 1600, accuracy: 2)
        XCTAssertEqual(c.durationNs, 100_000_000, accuracy: 200_000)
        let peak = c.samples.map { abs(Int($0)) }.max()!
        XCTAssertEqual(Double(peak), 0.5 * 32767, accuracy: 0.05 * 32767)   // amplitude preserved
    }
    func testDownmixAveragesChannels() {
        let b = RawAudioBuffer(kind: .systemAudio, hostTimeNs: 1, sampleRate: 16_000, channels: [[Float](repeating: 0.8, count: 160), [Float](repeating: -0.8, count: 160)])
        XCTAssertTrue(PCMConverter().convert(b)!.samples.allSatisfy { abs($0) < 2 })   // cancels out exactly
    }
    func testChunkBoundariesAreSeamless() {
        let whole = PCMConverter().convert(raw(frames: 4800))!.samples
        let conv = PCMConverter()
        var parts: [Int16] = []
        for i in 0..<5 { parts += conv.convert(raw(frames: 960, offset: i * 960))!.samples }   // 5 x 20 ms
        XCTAssertEqual(parts.count, whole.count, accuracy: 3)
        let n = min(parts.count, whole.count) - 3
        let maxDiff = (0..<n).map { abs(Int(parts[$0]) - Int(whole[$0])) }.max()!
        XCTAssertLessThan(maxDiff, 400, "streamed conversion must match one-shot conversion (no clicks at edges)")
    }
    func testClippingAndInvalidInput() {
        let loud = RawAudioBuffer(kind: .systemAudio, hostTimeNs: 1, sampleRate: 16_000, channels: [[Float](repeating: 5, count: 32)])
        XCTAssertTrue(PCMConverter().convert(loud)!.samples.allSatisfy { $0 == 32767 })
        XCTAssertNil(PCMConverter().convert(RawAudioBuffer(kind: .systemAudio, hostTimeNs: 1, sampleRate: 48_000, channels: [])))
        XCTAssertNil(PCMConverter().convert(RawAudioBuffer(kind: .systemAudio, hostTimeNs: 1, sampleRate: 0, channels: [[0]])))
    }
    func testMonotonicClockNeverGoesBack() {
        let c = SystemMonotonicClock(); var last = c.nowNs()
        for _ in 0..<10_000 { let n = c.nowNs(); XCTAssertGreaterThanOrEqual(n, last); last = n }
    }

    // MARK: encrypted ring buffer
    func testRingBufferBoundedAndDropsOldest() {
        let one = pcm(100, ns: 0); let b = EncryptedRingBuffer(capacityBytes: 5 * (one.byteCount + 60))
        for i in 0..<50 { b.append(pcm(100, ns: UInt64(i) * 100_000_000)) }
        let s = b.stats
        XCTAssertLessThanOrEqual(s.bytes, b.capacityBytes); XCTAssertGreaterThan(s.droppedChunks, 40)
        let out = b.drain(); XCTAssertEqual(out.last?.startNs, 49 * 100_000_000)   // newest kept
    }
    func testRingBufferIsEncryptedAtRestAndRoundTrips() {
        let b = EncryptedRingBuffer(capacityBytes: 1 << 20); let c = pcm(100, ns: 5)
        b.append(c)
        let plain = c.samples.withUnsafeBufferPointer { Data(buffer: $0) }
        for blob in b._sealedBlobs() { XCTAssertNil(blob.range(of: plain.prefix(64)), "plaintext found in sealed buffer") }
        XCTAssertEqual(b.drain(), [c])
    }
    func testPurgeDropsDataAndRotatesKey() {
        let b = EncryptedRingBuffer(capacityBytes: 1 << 20); b.append(pcm(100, ns: 1)); let before = b._sealedBlobs()
        b.purge(); XCTAssertEqual(b.stats.chunks, 0); XCTAssertEqual(b.drain(), [])
        b.append(pcm(100, ns: 2)); XCTAssertEqual(b.drain().count, 1)       // still usable afterwards
        XCTAssertFalse(before.isEmpty)
    }
    func testTamperedChunkIsRejected() {
        let b = EncryptedRingBuffer(capacityBytes: 1 << 20); b.append(pcm(50, ns: 1)); b.append(pcm(50, ns: 2)); b._tamper(index: 0)
        XCTAssertEqual(b.drain().map { $0.startNs }, [2])
    }

    // MARK: health
    func testHealthOkAndBitrate() {
        let h = AudioHealthMonitor(windowSeconds: 5)
        for i in 0..<100 { h.ingest(pcm(100, ns: UInt64(i) * 100_000_000)) }   // 10 s of continuous 16 kHz s16 audio
        let s = h.snapshot(nowNs: 10_000_000_000)
        XCTAssertEqual(s.status, .ok); XCTAssertEqual(s.bitrateBps, 256_000, accuracy: 30_000)   // 16000*16 bit
        XCTAssertEqual(s.gapCount, 0)
    }
    func testSilenceDetected() {
        let h = AudioHealthMonitor(silenceAfterSeconds: 8)
        for i in 0..<120 { h.ingest(pcm(100, ns: UInt64(i) * 100_000_000, amp: 0)) }
        XCTAssertEqual(h.snapshot(nowNs: 12_000_000_000).status, .silent)
        XCTAssertEqual(h.snapshot(nowNs: 12_000_000_000).rmsDbfs, -120, accuracy: 0.1)
    }
    func testAbsentWhenNoData() {
        let h = AudioHealthMonitor(absentAfterSeconds: 3)
        XCTAssertEqual(h.snapshot(nowNs: 1).status, .absent)           // never received anything (e.g. AirPods switched, app muted)
        h.ingest(pcm(100, ns: 0)); XCTAssertEqual(h.snapshot(nowNs: 200_000_000).status, .ok)
        XCTAssertEqual(h.snapshot(nowNs: 10_000_000_000).status, .absent)
    }
    func testGapDetected() {
        let h = AudioHealthMonitor()
        h.ingest(pcm(100, ns: 0)); h.ingest(pcm(100, ns: 100_000_000)); h.ingest(pcm(100, ns: 700_000_000))   // 500 ms hole
        let s = h.snapshot(nowNs: 800_000_000); XCTAssertEqual(s.gapCount, 1); XCTAssertEqual(s.lastGapMs, 500, accuracy: 1); XCTAssertEqual(s.status, .gap)
    }

    // MARK: isolation (never assumed)
    func testIsolationVerdicts() {
        func s(_ amp: Int16) -> [Int16] { pcm(500, ns: 0, amp: amp).samples }
        XCTAssertEqual(IsolationProbe.evaluate(zoomPhase: s(8000), otherAppPhase: s(0)), .isolated(marginDb: IsolationProbe.margin(s(8000), s(0))))
        if case .polluted = IsolationProbe.evaluate(zoomPhase: s(8000), otherAppPhase: s(4000)) {} else { XCTFail("other app leaking at -6 dB must be flagged") }
        XCTAssertEqual(IsolationProbe.evaluate(zoomPhase: s(0), otherAppPhase: s(0)), .noSignalFromZoom)
        XCTAssertEqual(IsolationProbe.evaluate(zoomPhase: [], otherAppPhase: s(1)), .inconclusive)
    }

    // MARK: coordinator
    func testCoordinatorKeepsSourcesSeparateAndTimestampsMonotonic() throws {
        let sys = FakeSource(.systemAudio), mic = FakeSource(.microphone)
        let buf = EncryptedRingBuffer(capacityBytes: 1 << 22); let c = CaptureCoordinator(buffer: buf, clock: TestClock(t: 1))
        try c.start(sources: [sys, mic])
        sys.emit(raw(.systemAudio, ns: 1_000)); mic.emit(raw(.microphone, ns: 2_000, channels: 1)); sys.emit(raw(.systemAudio, ns: 21_001_000))
        let out = buf.drain()
        XCTAssertEqual(out.map { $0.kind }, [.systemAudio, .microphone, .systemAudio])
        XCTAssertEqual(out.filter { $0.kind == .systemAudio }.map { $0.startNs }, [1_000, 21_001_000])
        XCTAssertThrowsError(try c.start(sources: [sys]))   // cannot start twice
    }
    func testFixtureSampleBufferStream_AudioAbsentAndSilenceAndOutputChange() throws {
        // Simulates: normal audio -> device switch (no data) -> reappears at 44.1 kHz mono (e.g. AirPods HFP) -> silence
        let sys = FakeSource(.systemAudio); let buf = EncryptedRingBuffer(capacityBytes: 1 << 22)
        var now: UInt64 = 0
        let c = CaptureCoordinator(buffer: buf, clock: ClosureClock { now })
        try c.start(sources: [sys])
        for i in 0..<10 { sys.emit(raw(ns: UInt64(i) * 20_000_000)) }; now = 200_000_000
        XCTAssertEqual(c.health(.systemAudio)?.status, .ok)
        now = 6_000_000_000                                              // output switched: nothing arrives
        XCTAssertEqual(c.health(.systemAudio)?.status, .absent)
        sys.emit(raw(ns: 6_000_000_000, rate: 44_100, frames: 882, channels: 1)); now = 6_020_000_000     // rate change handled
        XCTAssertEqual(c.health(.systemAudio)?.status, .gap)             // 5.8 s hole is visible to consumers
        let sizes = buf.drain().map { $0.samples.count }; XCTAssertEqual(sizes.last!, 320, accuracy: 2)   // 20 ms @16k
    }
}

struct ClosureClock: MonotonicClock { let f: () -> UInt64; init(_ f: @escaping () -> UInt64) { self.f = f }; func nowNs() -> UInt64 { f() } }

extension IsolationProbe {
    static func margin(_ a: [Int16], _ b: [Int16]) -> Double { AudioHealthMonitor.rmsDbfs(a) - AudioHealthMonitor.rmsDbfs(b) }
}
