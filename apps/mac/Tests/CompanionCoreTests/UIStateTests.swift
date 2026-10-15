import XCTest
@testable import CompanionCore

/// "UI tests" at presentation level: StatusPresenter is exactly what the menu bar and window render.
/// Real XCUITest on the SwiftUI views cannot run on Linux -> see reports/BLOC_04.md (BLOCKED part).
final class UIStateTests: XCTestCase {
    func ui(_ phase: CompanionPhase, _ sr: PermissionStatus, selected: Bool = true, restart: Bool = false, resume: LifecycleEvent? = nil, health: AudioHealthSnapshot? = nil) -> StatusPresentation {
        StatusPresenter.make(phase: phase, permissions: PermissionSnapshot([.screenRecording: sr]),
                             selection: selected ? .application(bundleID: "us.zoom.xos", name: "zoom.us") : nil, zoom: .none,
                             interruptedByRestart: restart, resumeNeededAfter: resume, health: health)
    }
    func testPermissionDeniedShowsSettingsButtonAndDisablesStart() {
        let p = ui(.idle, .denied)
        XCTAssertFalse(p.canStart); XCTAssertEqual(p.level, .error)
        XCTAssertEqual(p.banner?.offersOpenSettings, .screenRecording)
        XCTAssertTrue(p.banner?.text.contains("refusé") ?? false)
    }
    func testEachPermissionStateHasDistinctMessage() {
        let texts = [PermissionStatus.notDetermined, .denied, .restricted, .unavailable].map { ui(.idle, $0).banner?.text }
        XCTAssertEqual(Set(texts.compactMap { $0 }).count, 4)
        XCTAssertNil(ui(.idle, .granted).banner)
        XCTAssertNil(ui(.idle, .restricted).banner?.offersOpenSettings)   // user cannot fix MDM restriction
    }
    func testGrantedWithSelectionCanStartButNotWithoutSelection() {
        XCTAssertTrue(ui(.idle, .granted).canStart); XCTAssertFalse(ui(.idle, .granted, selected: false).canStart)
    }
    func testStopAllAvailableWheneverSomethingRuns() {
        for ph in [CompanionPhase.starting, .capturing, .paused] { let p = ui(ph, .granted); XCTAssertTrue(p.canStopAll && p.canStop, "\(ph)") }
        // permission revoked mid-capture must NOT remove the kill switch
        XCTAssertTrue(ui(.capturing, .denied).canStopAll)
        XCTAssertFalse(ui(.idle, .granted).canStopAll)
        XCTAssertFalse(ui(.stopped, .granted).canStopAll)
    }
    func testButtonsPerPhase() {
        let c = ui(.capturing, .granted); XCTAssertTrue(c.canPause); XCTAssertFalse(c.canStart); XCTAssertFalse(c.canResume)
        let p = ui(.paused, .granted); XCTAssertTrue(p.canResume); XCTAssertFalse(p.canPause)
    }
    func testStatusIconsAndLevels() {
        XCTAssertEqual(ui(.capturing, .granted).level, .ok)
        XCTAssertEqual(ui(.failed("x"), .granted).level, .error)
        let silent = AudioHealthSnapshot(status: .silent, bitrateBps: 256_000, rmsDbfs: -90, gapCount: 0, lastGapMs: 0)
        let p = ui(.capturing, .granted, health: silent); XCTAssertEqual(p.level, .attention); XCTAssertEqual(p.subtitle, "Source silencieuse")
    }
    func testRestartAndSleepBanners() {
        XCTAssertNotNil(ui(.idle, .granted, restart: true).banner)
        XCTAssertTrue(ui(.stopped, .granted, resume: .willSleep).banner?.text.contains("veille") ?? false)
    }
    func testErrorTextIsRedacted() {
        XCTAssertFalse(ui(.failed("failed for bob@example.com at /Users/bob/x"), .granted).subtitle.contains("bob"))
    }
    func testOnboardingFlowSteps() {
        func n(_ c: Bool, _ sr: PermissionStatus, _ mic: PermissionStatus = .notDetermined, skip: Bool = false, seen: Bool = false) -> OnboardingStep {
            Onboarding.next(consentGiven: c, permissions: PermissionSnapshot([.screenRecording: sr, .microphone: mic]), microphoneSkipped: skip, zoomAppGuideSeen: seen).step
        }
        XCTAssertEqual(n(false, .granted), .consent)
        XCTAssertEqual(n(true, .notDetermined), .screenRecording)
        let d = Onboarding.next(consentGiven: true, permissions: PermissionSnapshot([.screenRecording: .denied]), microphoneSkipped: true, zoomAppGuideSeen: true)
        XCTAssertEqual(d.action, .openSystemSettings(.screenRecording))
        XCTAssertEqual(n(true, .granted, .notDetermined), .microphone)
        XCTAssertEqual(n(true, .granted, .denied, skip: true), .zoomApp)
        XCTAssertEqual(n(true, .granted, .granted, skip: false, seen: true), .done)
    }
    func testScreenRecordingResolver() {
        XCTAssertEqual(ScreenRecordingResolver.resolve(preflightGranted: true, alreadyRequested: false), .granted)
        XCTAssertEqual(ScreenRecordingResolver.resolve(preflightGranted: false, alreadyRequested: false), .notDetermined)
        XCTAssertEqual(ScreenRecordingResolver.resolve(preflightGranted: false, alreadyRequested: true), .denied)
        XCTAssertEqual(ScreenRecordingResolver.resolve(preflightGranted: false, alreadyRequested: true, osSupportsScreenCaptureKit: false), .unavailable)
    }
}
