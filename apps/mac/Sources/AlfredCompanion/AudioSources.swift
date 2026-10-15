import AVFoundation
import CoreMedia
import ScreenCaptureKit
import CompanionCore

/// Host-time clock = the clock of CMSampleBuffer presentation timestamps, so "now" and chunk times are comparable.
struct HostTimeClock: MonotonicClock {
    func nowNs() -> UInt64 { UInt64(max(0, CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1e9)) }
}

enum SourceError: Error { case timeout, filterMissing }

/// System audio through ScreenCaptureKit (capturesAudio = true). The filter is chosen EXPLICITLY by the user
/// (window / application / display). We do not assume a window filter isolates that window's audio: see IsolationProbe + MANUAL_MAC_ZOOM.md.
final class ScreenCaptureKitSource: NSObject, AudioSource, SCStreamOutput, SCStreamDelegate {
    let kind: AudioSourceKind = .systemAudio
    private let filter: SCContentFilter
    private let onFailure: (String) -> Void
    private let queue = DispatchQueue(label: "alfred.sck.audio")
    private let lock = NSLock()
    private var stream: SCStream?
    private var handler: ((RawAudioBuffer) -> Void)?

    init(filter: SCContentFilter, onFailure: @escaping (String) -> Void) { self.filter = filter; self.onFailure = onFailure }

    func start(handler: @escaping (RawAudioBuffer) -> Void) throws {
        lock.lock(); self.handler = handler; lock.unlock()
        let cfg = SCStreamConfiguration()
        cfg.capturesAudio = true
        cfg.excludesCurrentProcessAudio = true      // never re-capture ourselves
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.width = 2; cfg.height = 2                // we do not want video: smallest possible frames, 1 fps
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)   // consumed and discarded (avoids "output not found" log spam)
        let sem = DispatchSemaphore(value: 0); var startError: Error?
        s.startCapture { e in startError = e; sem.signal() }
        if sem.wait(timeout: .now() + 5) == .timedOut { throw SourceError.timeout }
        if let startError { throw startError }
        lock.lock(); stream = s; lock.unlock()
    }

    func stop() {
        lock.lock(); handler = nil; let s = stream; stream = nil; lock.unlock()   // gate closed first: late buffers are dropped
        guard let s else { return }
        let sem = DispatchSemaphore(value: 0)
        s.stopCapture { _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 3)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        lock.lock(); let h = handler; lock.unlock()
        guard let h, let raw = Self.convert(sb) else { return }
        h(raw)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { onFailure("stream stopped: \(error.localizedDescription)") }

    /// ScreenCaptureKit delivers non-interleaved Float32 PCM (usually 48 kHz stereo). Copy it out before the buffer is recycled.
    static func convert(_ sb: CMSampleBuffer) -> RawAudioBuffer? {
        var result: RawAudioBuffer?
        try? sb.withAudioBufferList { list, _ in
            guard let asbd = sb.formatDescription?.audioStreamBasicDescription,
                  let format = AVAudioFormat(standardFormatWithSampleRate: asbd.mSampleRate, channels: asbd.mChannelsPerFrame),
                  let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer),
                  let data = pcm.floatChannelData else { return }
            let frames = Int(pcm.frameLength)
            let channels = (0..<Int(format.channelCount)).map { Array(UnsafeBufferPointer(start: data[$0], count: frames)) }
            let t = UInt64(max(0, CMTimeGetSeconds(sb.presentationTimeStamp) * 1e9))
            result = RawAudioBuffer(kind: .systemAudio, hostTimeNs: t, sampleRate: asbd.mSampleRate, channels: channels)
        }
        return result
    }
}

/// Microphone: separate source, created only when the user ticked the box AND consented. Never mixed with system audio.
final class MicrophoneSource: AudioSource {
    let kind: AudioSourceKind = .microphone
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var running = false

    func start(handler: @escaping (RawAudioBuffer) -> Void) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, when in
            guard let self, let data = buf.floatChannelData else { return }
            self.lock.lock(); let ok = self.running; self.lock.unlock()
            guard ok else { return }
            let frames = Int(buf.frameLength)
            let ch = (0..<Int(buf.format.channelCount)).map { Array(UnsafeBufferPointer(start: data[$0], count: frames)) }
            let ns = UInt64(max(0, AVAudioTime.seconds(forHostTime: when.hostTime) * 1e9))
            handler(RawAudioBuffer(kind: .microphone, hostTimeNs: ns, sampleRate: buf.format.sampleRate, channels: ch))
        }
        lock.lock(); running = true; lock.unlock()
        try engine.start()
    }

    func stop() {
        lock.lock(); running = false; lock.unlock()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}
