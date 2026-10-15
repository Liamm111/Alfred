// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AlfredAuthClient",
    platforms: [.macOS(.v13)],
    products: [.library(name: "AlfredAuthClient", targets: ["AlfredAuthClient"])],
    targets: [
        .target(name: "AlfredAuthClient"),
        .testTarget(name: "AlfredAuthClientTests", dependencies: ["AlfredAuthClient"]),
    ]
)
