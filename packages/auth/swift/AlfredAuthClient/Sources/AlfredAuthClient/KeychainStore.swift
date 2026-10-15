import Foundation
import Security

public enum KeychainError: Error, Equatable {
    case unexpectedStatus(OSStatus)
    case notFound
}

/// Stores the PRODUCT refresh token (never a Zoom token: those stay on the server) and local
/// keys in the macOS Keychain. Items are device-bound (`ThisDeviceOnly`), unavailable before first
/// unlock, never synced to iCloud, and never written to UserDefaults / files / logs.
public struct KeychainStore {
    public let service: String
    public init(service: String = "com.alfred.app") { self.service = service }

    private func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    public func set(_ value: Data, account: String) throws {
        var attrs = base(account)
        attrs[kSecValueData as String] = value
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let add = SecItemAdd(attrs as CFDictionary, nil)
        if add == errSecDuplicateItem {
            let upd = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: value] as CFDictionary)
            guard upd == errSecSuccess else { throw KeychainError.unexpectedStatus(upd) }
        } else if add != errSecSuccess {
            throw KeychainError.unexpectedStatus(add)
        }
    }

    public func get(account: String) throws -> Data {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { throw KeychainError.notFound }
        guard st == errSecSuccess, let data = out as? Data else { throw KeychainError.unexpectedStatus(st) }
        return data
    }

    /// Logout: removing an item that is already gone is not an error.
    public func delete(account: String) throws {
        let st = SecItemDelete(base(account) as CFDictionary)
        guard st == errSecSuccess || st == errSecItemNotFound else { throw KeychainError.unexpectedStatus(st) }
    }
}
