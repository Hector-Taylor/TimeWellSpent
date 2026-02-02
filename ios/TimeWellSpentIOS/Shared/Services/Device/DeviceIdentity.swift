import Foundation
import Security

final class DeviceIdentity {
    static let shared = DeviceIdentity()
    private let deviceIdKey = "twsp.device.id"
    private let deviceNameKey = "twsp.device.name"

    private init() {}

    var id: String {
        if let existing = readKeychain(for: deviceIdKey) {
            return existing
        }
        let new = UUID().uuidString
        saveKeychain(new, for: deviceIdKey)
        return new
    }

    var name: String {
        get {
            if let stored = AppGroupContainer.sharedDefaults.string(forKey: deviceNameKey), !stored.isEmpty {
                return stored
            }
            return UIDevice.current.name
        }
        set {
            AppGroupContainer.sharedDefaults.setValue(newValue, forKey: deviceNameKey)
        }
    }

    private func readKeychain(for key: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    private func saveKeychain(_ value: String, for key: String) {
        let data = value.data(using: .utf8) ?? Data()
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key] as CFDictionary)
        SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecValueData as String: data] as CFDictionary, nil)
    }
}
