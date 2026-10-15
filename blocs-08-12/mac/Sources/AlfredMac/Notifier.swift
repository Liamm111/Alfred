import UserNotifications
import AppKit

/// Notifications locales Mac. NON COMPILÉ dans ce dépôt (Linux) : à valider sur macOS 14+.
/// Règle : Zoom n'est ouvert QUE dans `didReceive`, quand l'utilisateur clique l'action « Ouvrir Zoom ».
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let category = "ALFRED_ALERT"
    static let openZoomAction = "OPEN_ZOOM"
    static let zoomBundleID = "us.zoom.xos"

    private let emit: (String) -> Void   // lignes NDJSON vers le processus Node
    init(emit: @escaping (String) -> Void) { self.emit = emit; super.init() }

    func configure() async -> Bool {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        let open = UNNotificationAction(identifier: Self.openZoomAction, title: "Ouvrir Zoom", options: [])   // aucune option d'activation automatique : rien ne s'ouvre seul
        c.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [open], intentIdentifiers: [], options: [])])
        do { return try await c.requestAuthorization(options: [.alert, .sound, .timeSensitive]) } catch { return false }
    }

    func notify(token: String, title: String, body: String, tag: String, urgent: Bool, joinURL: String?) async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            emit("{\"type\":\"notify_result\",\"token\":\"\(token)\",\"status\":\"denied\"}"); return
        }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body
        content.categoryIdentifier = Self.category
        content.threadIdentifier = tag
        content.interruptionLevel = urgent ? .timeSensitive : .active    // .timeSensitive exige l'entitlement correspondant
        content.sound = urgent ? .default : nil
        content.userInfo = ["token": token, "join": joinURL ?? ""]
        // Identifiant = tag de question : une alerte ou sa rétractation REMPLACE la précédente au lieu de s'empiler.
        let req = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
        do { try await UNUserNotificationCenter.current().add(req); emit("{\"type\":\"notify_result\",\"token\":\"\(token)\",\"status\":\"added\"}") }
        catch { emit("{\"type\":\"notify_result\",\"token\":\"\(token)\",\"status\":\"error\"}") }
    }

    // Affichée au premier plan aussi → « delivered » (device_ack).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions {
        if let t = n.request.content.userInfo["token"] as? String { emit("{\"type\":\"delivered\",\"token\":\"\(t)\"}") }
        return [.banner, .sound]
    }

    // UNIQUE endroit où Zoom peut être ouvert : clic utilisateur sur l'action « Ouvrir Zoom ».
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let token = info["token"] as? String else { return }
        emit("{\"type\":\"clicked\",\"token\":\"\(token)\"}")
        guard response.actionIdentifier == Self.openZoomAction else { return }
        if let s = info["join"] as? String, let u = URL(string: s), u.scheme == "https", (u.host ?? "").hasSuffix("zoom.us") { NSWorkspace.shared.open(u) }
        else { NSRunningApplication.runningApplications(withBundleIdentifier: Self.zoomBundleID).first?.activate() }
        emit("{\"type\":\"zoom_opened\",\"token\":\"\(token)\"}")
    }
}
