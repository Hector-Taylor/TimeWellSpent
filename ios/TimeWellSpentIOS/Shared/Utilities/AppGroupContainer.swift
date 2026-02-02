import Foundation

enum AppGroupContainer {
    static let identifier: String = {
        // Uses xcconfig APP_GROUP_IDENTIFIER; falls back for previews.
        if let override = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String, !override.isEmpty {
            return override
        }
        if let env = ProcessInfo.processInfo.environment["APP_GROUP_IDENTIFIER"], !env.isEmpty {
            return env
        }
        return "group.com.timewellspent.shared"
    }()

    static func containerURL() -> URL {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
            // Fallback to temporary directory to avoid crashes in simulators without groups configured.
            return FileManager.default.temporaryDirectory.appendingPathComponent("TimeWellSpentFallback", isDirectory: true)
        }
        return url
    }

    static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }
}
