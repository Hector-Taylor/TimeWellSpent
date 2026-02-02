import Foundation
import UserNotifications

final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()
    private override init() {}

    func registerCategories() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let expire = UNNotificationAction(identifier: "EXPIRE", title: "Expire Now", options: [.destructive])
        let category = UNNotificationCategory(identifier: "PAYWALL_EXPIRY", actions: [expire], intentIdentifiers: [], options: [])
        center.setNotificationCategories([category])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func scheduleExpiryAlerts(for session: PaywallSession) async {
        let center = UNUserNotificationCenter.current()
        let id = session.id.uuidString
        center.removePendingNotificationRequests(withIdentifiers: [id])
        let intervals: [TimeInterval] = [120, 60, 0]
        for delta in intervals {
            let content = UNMutableNotificationContent()
            content.title = "Time pack ending"
            if delta == 0 {
                content.body = "Access for \(session.targetName) expired"
            } else {
                content.body = "\(Int(delta / 60)) minutes left for \(session.targetName)"
            }
            content.categoryIdentifier = "PAYWALL_EXPIRY"
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, session.expiresAt.timeIntervalSinceNow - delta), repeats: false)
            let request = UNNotificationRequest(identifier: "\(id)-\(delta)", content: content, trigger: trigger)
            center.add(request)
        }
    }

    func cancelAlerts(forSessionId id: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    }
}
