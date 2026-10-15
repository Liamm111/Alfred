import XCTest
@testable import AlfredAuthClient

/// NOTE: written on a Linux host without a Swift toolchain - NOT executed (see reports/BLOC_03.md).
final class PkceTests: XCTestCase {
    func testRfc7636Vector() {
        XCTAssertEqual(
            Pkce.challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testVerifierShapeAndUniqueness() {
        let a = Pkce.generateVerifier(), b = Pkce.generateVerifier()
        XCTAssertNotEqual(a, b)
        XCTAssertTrue((43...128).contains(a.count))
    }

    func testKeychainRoundTripAndLogout() throws {
        let store = KeychainStore(service: "com.alfred.tests.\(UUID().uuidString)")
        try store.set(Data("refresh".utf8), account: "product_refresh_token")
        XCTAssertEqual(try store.get(account: "product_refresh_token"), Data("refresh".utf8))
        try store.set(Data("rotated".utf8), account: "product_refresh_token")
        XCTAssertEqual(try store.get(account: "product_refresh_token"), Data("rotated".utf8))
        try store.delete(account: "product_refresh_token")
        XCTAssertThrowsError(try store.get(account: "product_refresh_token"))
        XCTAssertNoThrow(try store.delete(account: "product_refresh_token"))
    }
}
