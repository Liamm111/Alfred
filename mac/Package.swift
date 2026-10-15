// swift-tools-version:5.9
import PackageDescription

// CompanionCore: platform-agnostic logic (state machines, permissions model, capture pipeline, redaction).
//   Builds and is unit-tested on Linux AND macOS.
// AlfredCompanion: SwiftUI/AppKit/ScreenCaptureKit app. macOS only (manifest drops it elsewhere).
var targets: [Target] = [
    .target(
        name: "CompanionCore",
        dependencies: [.product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux]))]
    ),
    .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore"]),
]
var products: [Product] = [.library(name: "CompanionCore", targets: ["CompanionCore"])]

#if os(macOS)
targets.append(.executableTarget(
    name: "AlfredCompanion",
    dependencies: ["CompanionCore"],
    exclude: ["Info.plist", "AlfredCompanion.entitlements"]
))
products.append(.executable(name: "AlfredCompanion", targets: ["AlfredCompanion"]))
#endif

let package = Package(
    name: "AlfredCompanion",
    platforms: [.macOS(.v13)],
    products: products,
    dependencies: [.package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0")],
    targets: targets
)
