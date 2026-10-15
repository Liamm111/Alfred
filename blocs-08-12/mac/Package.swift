// swift-tools-version:5.9
// NON COMPILÉ dans la CI Linux de ce dépôt (BLOC 08/12) : à valider sur macOS 14+ avec Xcode.
import PackageDescription
let package = Package(
    name: "AlfredMac",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "AlfredMac", path: "Sources/AlfredMac")]
)
