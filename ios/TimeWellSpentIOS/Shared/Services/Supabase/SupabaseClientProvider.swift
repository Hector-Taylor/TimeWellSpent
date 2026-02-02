import Foundation
import Supabase
import AuthenticationServices

final class SupabaseClientProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SupabaseClientProvider()

    private(set) var client: SupabaseClient?
    private let keychain = DeviceIdentity.shared

    private override init() {
        super.init()
        configure()
    }

    func configure() {
        guard let urlString = Bundle.main.object(forInfoDictionaryKey: "SupabaseURL") as? String,
              let anonKey = Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") as? String,
              let url = URL(string: urlString), !anonKey.isEmpty else {
            print("[Supabase] Missing config; skip")
            return
        }
        client = SupabaseClient(supabaseURL: url, supabaseKey: anonKey, options: .init(auth: .init(flowType: .pkce)))
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.windows.first { $0.isKeyWindow } ?? UIWindow()
    }
}
