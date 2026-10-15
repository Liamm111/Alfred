// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AlfredContracts",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "AlfredContracts", targets: ["AlfredContracts"])],
    targets: [
        .target(name: "AlfredContracts"),
        .testTarget(
            name: "AlfredContractsTests",
            dependencies: ["AlfredContracts"]
        ),
    ]
)
