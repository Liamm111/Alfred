import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Bounded buffer holding sealed (AES-256-GCM) PCM chunks. The key lives only in memory and is replaced on purge,
/// so previously sealed bytes become undecryptable even if some copy of the ciphertext survives.
public final class EncryptedRingBuffer {
    public struct Stats: Equatable { public var chunks: Int; public var bytes: Int; public var droppedChunks: Int }

    private let lock = NSLock()
    private var key = SymmetricKey(size: .bits256)
    private var items: [(meta: Meta, sealed: Data)] = []
    private var bytes = 0
    private var dropped = 0
    public let capacityBytes: Int

    struct Meta { var kind: AudioSourceKind; var startNs: UInt64 }

    public init(capacityBytes: Int) { precondition(capacityBytes > 0); self.capacityBytes = capacityBytes }

    public func append(_ c: PCMChunk) {
        let plain = c.samples.withUnsafeBufferPointer { Data(buffer: $0) }
        guard let box = try? AES.GCM.seal(plain, using: lockedKey(), authenticating: Self.aad(c)), let combined = box.combined else { return }
        lock.lock(); defer { lock.unlock() }
        items.append((Meta(kind: c.kind, startNs: c.startNs), combined)); bytes += combined.count
        while bytes > capacityBytes, !items.isEmpty { bytes -= items.removeFirst().sealed.count; dropped += 1 }
    }

    /// Decrypts and removes everything currently buffered, oldest first. Chunks that fail authentication are skipped.
    public func drain() -> [PCMChunk] {
        lock.lock(); let snapshot = items; let k = key; items = []; bytes = 0; lock.unlock()
        return snapshot.compactMap { item in
            guard let box = try? AES.GCM.SealedBox(combined: item.sealed) else { return nil }
            let aad = Self.aad(kind: item.meta.kind, startNs: item.meta.startNs)
            guard let plain = try? AES.GCM.open(box, using: k, authenticating: aad) else { return nil }
            let samples = plain.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
            return PCMChunk(kind: item.meta.kind, startNs: item.meta.startNs, samples: samples)
        }
    }

    /// Immediate purge: drop all data and rotate the key.
    public func purge() {
        lock.lock(); defer { lock.unlock() }
        items.removeAll(keepingCapacity: false); bytes = 0
        key = SymmetricKey(size: .bits256)
    }

    public var stats: Stats { lock.lock(); defer { lock.unlock() }; return Stats(chunks: items.count, bytes: bytes, droppedChunks: dropped) }

    /// Test hook: raw sealed bytes (to prove no plaintext is stored) and tampering.
    func _sealedBlobs() -> [Data] { lock.lock(); defer { lock.unlock() }; return items.map { $0.sealed } }
    func _tamper(index: Int) { lock.lock(); defer { lock.unlock() }; guard index < items.count else { return }; items[index].sealed[items[index].sealed.count - 1] ^= 0xFF }

    private func lockedKey() -> SymmetricKey { lock.lock(); defer { lock.unlock() }; return key }
    private static func aad(_ c: PCMChunk) -> Data { aad(kind: c.kind, startNs: c.startNs) }
    private static func aad(kind: AudioSourceKind, startNs: UInt64) -> Data { Data("\(kind.rawValue):\(startNs)".utf8) }
}
