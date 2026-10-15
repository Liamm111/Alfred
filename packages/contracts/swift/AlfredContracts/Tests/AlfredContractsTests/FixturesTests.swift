import Foundation
import XCTest
@testable import AlfredContracts

/// NOTE: written on a Linux host without a Swift toolchain — NOT executed yet (see reports/BLOC_01.md).
final class FixturesTests: XCTestCase {
    private func load(_ name: String) throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("fixtures/valid/\(name).json")
        return try Data(contentsOf: url)
    }

    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, _ name: String) throws {
        let data = try load(name)
        let value = try JSONDecoder().decode(T.self, from: data)
        let again = try JSONDecoder().decode(T.self, from: try JSONEncoder().encode(value))
        XCTAssertEqual(value, again, name)
        // Nullable keys must be re-emitted as explicit null (schema requires the key).
        let obj = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(value)) as! [String: Any]
        let orig = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(Set(obj.keys), Set(orig.keys), name)
    }

    func testEveryEntityRoundTrips() throws {
        try roundTrip(Session.self, "Session")
        try roundTrip(CaptureSource.self, "CaptureSource")
        try roundTrip(Packet.self, "Packet")
        try roundTrip(Evidence.self, "Evidence")
        try roundTrip(Gap.self, "Gap")
        try roundTrip(Alert.self, "Alert")
        try roundTrip(Assignment.self, "Assignment")
    }

    func testSchemaVersion() { XCTAssertEqual(alfredSchemaVersion, "1.0.0") }
}
