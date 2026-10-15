import Foundation

// Processus auxiliaire : lit des commandes NDJSON sur stdin (src/outbox/process_bridge.ts), écrit des événements sur stdout.
setvbuf(stdout, nil, _IOLBF, 0)
let notifier = Notifier(emit: { print($0) })
Task { _ = await notifier.configure() }

struct NotifyCmd: Decodable { let type: String; let token: String; let title: String; let body: String; let tag: String; let level: String; let join_url: String? }
while let line = readLine() {
    guard let d = line.data(using: .utf8), let c = try? JSONDecoder().decode(NotifyCmd.self, from: d), c.type == "notify" else { continue }
    Task { await notifier.notify(token: c.token, title: c.title, body: c.body, tag: c.tag, urgent: c.level == "urgent", joinURL: c.join_url) }
}
RunLoop.main.run()
