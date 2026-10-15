import XCTest
@testable import CompanionCore

final class ControllerTests: XCTestCase {
    // MARK: permissions refused -> distinct errors, nothing started
    func testScreenRecordingDeniedBlocksStartAndStartsNothing() {
        let r = makeRig(perms: [.screenRecording: .denied])
        let res = r.controller.start(by: click)
        XCTAssertEqual(err(res), .permissionDenied(.screenRecording, .denied))
        XCTAssertEqual(r.controller.phase, .idle)
        XCTAssertEqual(r.factoryCalls(), 0, "no capture source may even be created")
        XCTAssertEqual(r.sys.startCount, 0)
    }
    func testEveryNonGrantedStateIsRefusedWithItsOwnReason() {
        for s in [PermissionStatus.notDetermined, .denied, .restricted, .unavailable] {
            let r = makeRig(perms: [.screenRecording: s])
            XCTAssertEqual(err(r.controller.start(by: click)), .permissionDenied(.screenRecording, s))
        }
    }
    func testMicrophoneNeedsConsentAndPermission() {
        var r = makeRig()
        XCTAssertEqual(err(r.controller.start(includeMicrophone: true, microphoneConsent: false, by: click)), .microphoneConsentMissing)
        r = makeRig(perms: [.screenRecording: .granted, .microphone: .denied])
        XCTAssertEqual(err(r.controller.start(includeMicrophone: true, microphoneConsent: true, by: click)), .permissionDenied(.microphone, .denied))
        XCTAssertEqual(r.sys.startCount, 0)
    }
    func testNoSelectionNoStart() {
        let r = makeRig(selected: false)
        XCTAssertNotNil(err(r.controller.start(by: click)))
        XCTAssertEqual(r.sys.startCount, 0)
    }

    // MARK: normal flow
    func testStartPauseResumeStop() {
        let r = makeRig()
        XCTAssertNil(err(r.controller.start(by: click)))
        XCTAssertEqual(r.controller.phase, .capturing)
        r.controller.pause(by: click)
        XCTAssertEqual(r.controller.phase, .paused); XCTAssertEqual(r.sys.stopCount, 1)
        XCTAssertNil(err(r.controller.resume(by: click))); XCTAssertEqual(r.controller.phase, .capturing)
        r.controller.stop(by: click); XCTAssertEqual(r.controller.phase, .stopped)
    }
    func testResumeRechecksPermissions() {
        let r = makeRig(); _ = r.controller.start(by: click); r.controller.pause(by: click)
        r.perms.snap.statuses[.screenRecording] = .denied     // revoked while paused
        XCTAssertEqual(err(r.controller.resume(by: click)), .permissionDenied(.screenRecording, .denied))
        XCTAssertNotEqual(r.controller.phase, .capturing)
    }
    func testSourceFailureCleansUpAndReports() {
        let r = makeRig(failStart: true)
        XCTAssertNotNil(err(r.controller.start(by: click)))
        if case .failed = r.controller.phase {} else { XCTFail("phase \(r.controller.phase)") }
        XCTAssertFalse(r.capture.isRunning)
    }

    // MARK: STOP ALL
    func testStopAllStopsEverySourceImmediatelyPurgesAndDropsLateCallbacks() {
        let r = makeRig()
        _ = r.controller.start(includeMicrophone: true, microphoneConsent: true, by: click)
        r.sys.emit(raw(.systemAudio)); r.mic.emit(raw(.microphone, channels: 1))
        XCTAssertGreaterThan(r.buffer.stats.chunks, 0)
        r.controller.stopAll(by: click)
        XCTAssertEqual(r.sys.stopCount, 1); XCTAssertEqual(r.mic.stopCount, 1, "microphone must stop too")
        XCTAssertEqual(r.buffer.stats.chunks, 0, "buffer purged")
        XCTAssertFalse(r.capture.isRunning)
        r.sys.emit(raw(.systemAudio)); r.mic.emit(raw(.microphone, channels: 1))   // late callback from a platform thread
        XCTAssertEqual(r.buffer.stats.chunks, 0, "late callbacks must be dropped")
        XCTAssertFalse(r.store.value.wasActive)
        XCTAssertEqual(r.controller.phase, .stopped)
    }
    func testStopAllIsIdempotentAndSafeWhenIdle() {
        let r = makeRig(); r.controller.stopAll(by: click); r.controller.stopAll(by: click)
        XCTAssertEqual(r.controller.phase, .stopped)
    }

    // MARK: app restart
    func testRestartNeverResumesCapture() {
        let store = MemoryStateStore()
        var r = makeRig(store: store); _ = r.controller.start(by: click)
        XCTAssertTrue(store.value.wasActive)
        // "kill -9" then relaunch: new objects over the same persisted store
        r = makeRig(store: store)
        XCTAssertEqual(r.controller.phase, .idle)
        XCTAssertTrue(r.controller.interruptedByRestart)
        XCTAssertEqual(r.factoryCalls(), 0); XCTAssertEqual(r.sys.startCount, 0)
        XCTAssertFalse(store.value.wasActive)
        let ui = StatusPresenter.make(phase: r.controller.phase, permissions: r.perms.current(), selection: nil, zoom: .none,
                                      interruptedByRestart: true, resumeNeededAfter: nil, health: nil)
        XCTAssertTrue(ui.banner?.text.contains("interrompue") ?? false)
        r.controller.acknowledgeInterruption(); XCTAssertFalse(r.controller.interruptedByRestart)
    }
    func testOnboardingFlagSurvivesRestart() {
        let store = MemoryStateStore(); var r = makeRig(store: store); r.controller.completeOnboarding()
        r = makeRig(store: store); XCTAssertTrue(r.controller.onboardingDone)
    }

    // MARK: sleep / wake / lock
    func testSleepAndLockStopAndPurgeWakeNeverResumes() {
        for ev in [LifecycleEvent.willSleep, .screenLocked] {
            let r = makeRig(); _ = r.controller.start(by: click); r.sys.emit(raw())
            r.controller.handle(ev)
            XCTAssertEqual(r.controller.phase, .stopped, ev.rawValue); XCTAssertEqual(r.buffer.stats.chunks, 0)
            XCTAssertEqual(r.controller.resumeNeededAfter, ev)
            r.controller.handle(.didWake); r.controller.handle(.screenUnlocked)
            XCTAssertEqual(r.controller.phase, .stopped, "no auto-resume after wake/unlock")
            XCTAssertEqual(r.sys.startCount, 1)
        }
    }
    func testPolicyCanKeepCapturingThroughLock() {
        let r = makeRig(policy: LifecyclePolicy(stopOnSleep: true, stopOnLock: false)); _ = r.controller.start(by: click)
        r.controller.handle(.screenLocked); XCTAssertEqual(r.controller.phase, .capturing)
    }
    func testTerminateStopsEverything() {
        let r = makeRig(); _ = r.controller.start(by: click); r.controller.handle(.willTerminate)
        XCTAssertFalse(r.capture.isRunning); XCTAssertFalse(r.store.value.wasActive)
    }

    // MARK: Zoom is only a hint; focus only after a click
    func testDetectionStartAndLifecycleNeverFocusZoom() {
        let p = FakeProcesses(); p.apps = [RunningAppInfo(bundleID: "us.zoom.xos", name: "zoom.us", pid: 42)]
        p.wins = [WindowInfo(ownerPID: 42, ownerName: "zoom.us", title: "Zoom Meeting", onScreen: true)]
        let f = FakeFocuser(), fc = ZoomFocusCoordinator(focuser: f)
        let hint = ZoomHintDetector.detect(p)
        XCTAssertEqual(hint.confidence, .medium)
        let r = makeRig(); _ = r.controller.start(by: click); r.controller.handle(.willSleep); r.controller.handle(.didWake)
        XCTAssertEqual(f.count, 0)
        fc.focusZoom(UserAction(source: "open-zoom-button")); XCTAssertEqual(f.count, 1)
    }
    func testZoomHintLevels() {
        let p = FakeProcesses()
        XCTAssertEqual(ZoomHintDetector.detect(p), .none)
        p.apps = [RunningAppInfo(bundleID: "us.zoom.xos", name: "zoom.us", pid: 42)]
        XCTAssertEqual(ZoomHintDetector.detect(p).confidence, .low)               // running, no window info (no permission)
        p.wins = [WindowInfo(ownerPID: 42, ownerName: "zoom.us", title: "Zoom Workplace", onScreen: true)]
        XCTAssertEqual(ZoomHintDetector.detect(p).confidence, .low)               // home window is not a meeting
        p.wins = [WindowInfo(ownerPID: 42, ownerName: "zoom.us", title: "Zoom Meeting", onScreen: false)]
        XCTAssertEqual(ZoomHintDetector.detect(p).confidence, .low)               // off-screen
        p.wins = [WindowInfo(ownerPID: 99, ownerName: "other", title: "Zoom Meeting", onScreen: true)]
        XCTAssertEqual(ZoomHintDetector.detect(p).confidence, .low)               // not Zoom's window
    }
}


func err(_ r: Result<Void, CaptureError>) -> CaptureError? { if case .failure(let e) = r { return e } else { return nil } }
