import SwiftUI
import CompanionCore

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }   // menu bar app
    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.controller.handle(.willTerminate)
    }
}

@main
struct AlfredCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(model: model)
        } label: {
            Image(systemName: model.presentation.symbolName)       // icon follows the state: inactive / waveform / pause / error
        }
        .menuBarExtraStyle(.window)

        Window("Alfred", id: "main") { MainWindow(model: model) }
    }
}
