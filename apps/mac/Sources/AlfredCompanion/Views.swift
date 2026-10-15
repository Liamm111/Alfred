import SwiftUI
import CompanionCore

struct MenuBarContent: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        let p = model.presentation
        VStack(alignment: .leading, spacing: 6) {
            Label(p.title, systemImage: p.symbolName).font(.headline)
            Text(p.subtitle).font(.caption).foregroundStyle(.secondary)
            Text(p.zoomLine).font(.caption2).foregroundStyle(.secondary)
            if let b = p.banner { Text(b.text).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            Divider()
            Button("Démarrer") { model.start(from: "menu-start") }.disabled(!p.canStart).accessibilityIdentifier("menu.start")
            Button("Pause") { model.pause(from: "menu-pause") }.disabled(!p.canPause).accessibilityIdentifier("menu.pause")
            Button("Reprendre") { model.resume(from: "menu-resume") }.disabled(!p.canResume).accessibilityIdentifier("menu.resume")
            Button("Arrêter") { model.stop(from: "menu-stop") }.disabled(!p.canStop).accessibilityIdentifier("menu.stop")
            Button("STOP TOUT (audio + micro, purge)") { model.stopAll(from: "menu-stop-all") }
                .disabled(!p.canStopAll).accessibilityIdentifier("menu.stopAll").foregroundStyle(.red)
            Divider()
            Button("Ouvrir Zoom") { model.openZoom(from: "menu-open-zoom") }.accessibilityIdentifier("menu.openZoom")
            Button("Fenêtre Alfred…") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            Button("Quitter") { model.stopAll(from: "menu-quit"); NSApp.terminate(nil) }
        }.padding(10).frame(minWidth: 280)
    }
}

struct MainWindow: View {
    @ObservedObject var model: AppModel
    var body: some View {
        TabView {
            StatusTab(model: model).tabItem { Label("Statut", systemImage: "waveform") }
            OnboardingTab(model: model).tabItem { Label("Onboarding", systemImage: "checklist") }
            DiagnosticsTab(model: model).tabItem { Label("Diagnostics", systemImage: "stethoscope") }
        }.frame(minWidth: 520, minHeight: 420).padding()
    }
}

struct StatusTab: View {
    @ObservedObject var model: AppModel
    var body: some View {
        let p = model.presentation
        Form {
            Section {
                Label(p.title, systemImage: p.symbolName).font(.title3).accessibilityIdentifier("status.title")
                Text(p.subtitle); Text(p.zoomLine).foregroundStyle(.secondary)
                if let b = p.banner {
                    Text(b.text).foregroundStyle(.orange).accessibilityIdentifier("status.banner")
                    if let k = b.offersOpenSettings { Button("Ouvrir Réglages Système") { model.openSettings(k) }.accessibilityIdentifier("status.openSettings") }
                }
            }
            Section("Source (choix explicite, aucun défaut)") {
                Picker("Source", selection: $model.chosen) {
                    Text("— choisir —").tag(SourceChoice?.none)
                    ForEach(model.choices) { Text($0.label).tag(Optional($0)) }
                }
                Button("Actualiser la liste") { Task { await model.reloadChoices() } }
                Toggle("Inclure le micro (source séparée)", isOn: $model.includeMicrophone)
                Toggle("Je consens à l’enregistrement de mon micro", isOn: $model.microphoneConsent).disabled(!model.includeMicrophone)
            }
            Section {
                HStack {
                    Button("Démarrer") { model.start(from: "window-start") }.disabled(!p.canStart).accessibilityIdentifier("window.start")
                    Button("Pause") { model.pause(from: "window-pause") }.disabled(!p.canPause)
                    Button("Reprendre") { model.resume(from: "window-resume") }.disabled(!p.canResume)
                    Button("Arrêter") { model.stop(from: "window-stop") }.disabled(!p.canStop)
                    Button("STOP TOUT") { model.stopAll(from: "window-stop-all") }.disabled(!p.canStopAll).tint(.red).accessibilityIdentifier("window.stopAll")
                }
                Button("Ouvrir Zoom") { model.openZoom(from: "window-open-zoom") }
            }
        }
    }
}

struct OnboardingTab: View {
    @ObservedObject var model: AppModel
    var body: some View {
        let s = model.onboarding
        VStack(alignment: .leading, spacing: 12) {
            Text("Étape : \(s.step.rawValue)").font(.headline).accessibilityIdentifier("onboarding.step")
            Text(s.instruction)
            switch s.action {
            case .acknowledgeConsent?: Button("J’ai compris") { model.completeConsent() }
            case .requestPermission(let k)?: HStack { Button("Autoriser") { model.request(k) }
                if k == .microphone { Button("Passer") { model.micSkipped = true } } }
            case .openSystemSettings(let k)?: HStack { Button("Ouvrir Réglages Système") { model.openSettings(k) }
                if k == .microphone { Button("Passer") { model.micSkipped = true } } }
            case .openZoomAppGuide?: Button("C’est fait") { model.zoomGuideSeen = true }
            default: EmptyView()
            }
            Spacer()
        }
    }
}

struct DiagnosticsTab: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading) {
            ScrollView { Text(model.diagnosticsText).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
            Button("Copier (expurgé)") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.diagnosticsText, forType: .string) }
        }
    }
}
