import DeviceActivity
import FamilyControls
import ManagedSettings

final class ActivityMonitor: DeviceActivityMonitorExtension {
    private let paywall = PaywallService.shared
    private let notifications = NotificationService.shared

    override func intervalDidStart(for activity: DeviceActivityName) {
        Task { await paywall.tickSessions() }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        Task { await paywall.tickSessions() }
    }

    override func eventsDidReachThreshold(for event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
        Task { await paywall.tickSessions() }
    }
}
