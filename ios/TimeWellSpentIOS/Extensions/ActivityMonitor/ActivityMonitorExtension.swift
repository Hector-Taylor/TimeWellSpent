import DeviceActivity
import FamilyControls

class ActivityMonitorExtension: DeviceActivityMonitorExtension {
    override func intervalDidStart(for activity: DeviceActivityName) {
        NotificationCenter.default.post(name: .deviceActivityIntervalStarted, object: activity.rawValue)
    }
}

extension Notification.Name {
    static let deviceActivityIntervalStarted = Notification.Name("twsp.deviceActivityIntervalStarted")
}
