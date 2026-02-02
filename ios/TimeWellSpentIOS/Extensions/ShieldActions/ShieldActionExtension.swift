import ManagedSettings
import DeviceActivity

class ShieldActionExtension: ShieldActionDelegate {
    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        // For now, simply re-shield; app handles purchases.
        completionHandler(.close)
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }
}
