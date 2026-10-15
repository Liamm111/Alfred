import CryptoKit
import Foundation
import Security

/// PKCE (RFC 7636, S256 only). Mirrors src/auth/pkce.ts.
public enum Pkce {
    public static func generateVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 48)
        precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
        return base64url(Data(bytes))
    }

    public static func challengeS256(_ verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64url(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
