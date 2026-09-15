// Render the real setup HTML with default settings, plus a brand promotional tile.
// Usage: swift scripts/render-store-assets.swift /absolute/path/to/repository
import AppKit
import WebKit

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let output = root.appendingPathComponent("store/assets", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

func writePNG(_ image: NSImage, to url: URL) throws {
    let width = Int(image.size.width), height = Int(image.size.height)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
          let original = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("Bitmap creation failed") }
    context.draw(original, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let rendered = context.makeImage(), let png = NSBitmapImageRep(cgImage: rendered).representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
    try png.write(to: url)
}

let promo = NSImage(size: NSSize(width: 440, height: 280))
promo.lockFocus()
NSColor(calibratedRed: 0.07, green: 0.13, blue: 0.24, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 440, height: 280).fill()
NSColor(calibratedRed: 0.16, green: 0.38, blue: 0.76, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 226, y: 42, width: 180, height: 128), xRadius: 14, yRadius: 14).fill()
NSColor(calibratedWhite: 0.95, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 242, y: 56, width: 148, height: 85), xRadius: 5, yRadius: 5).fill()
NSColor(calibratedRed: 0.12, green: 0.27, blue: 0.5, alpha: 1).setFill()
for (i, width) in [100, 124, 75].enumerated() { NSRect(x: 254, y: 116 - i * 20, width: width, height: 7).fill() }
NSColor.white.setFill()
for x in [245, 257, 269] { NSBezierPath(ovalIn: NSRect(x: x, y: 150, width: 5, height: 5)).fill() }
NSColor(calibratedRed: 0.3, green: 0.78, blue: 0.75, alpha: 1).setStroke()
let line = NSBezierPath(); line.lineWidth = 3
line.move(to: NSPoint(x: 132, y: 102)); line.line(to: NSPoint(x: 226, y: 102)); line.stroke()
NSImage(contentsOf: root.appendingPathComponent("extension/icons/icon-128.png"))?.draw(in: NSRect(x: 38, y: 52, width: 96, height: 96))
let titleStyle: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 27, weight: .bold), .foregroundColor: NSColor.white]
("Aionda Browser MCP" as NSString).draw(at: NSPoint(x: 32, y: 212), withAttributes: titleStyle)
("Your assistant. Your browser." as NSString).draw(at: NSPoint(x: 33, y: 186), withAttributes: [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor(calibratedWhite: 0.8, alpha: 1)])
promo.unlockFocus()
try writePNG(promo, to: output.appendingPathComponent("promo-440x280.png"))

final class Renderer: NSObject, WKNavigationDelegate {
    let view: WKWebView
    override init() {
        let configuration = WKWebViewConfiguration()
        // Match chrome.storage.local's initial settings; this is a rendering fixture,
        // not a live connection or a simulated automation result.
        let bootstrap = "window.chrome = {storage:{local:{get:async defaults => defaults}}};"
        configuration.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration)
        view.pageZoom = 0.95
        super.init()
        view.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: 1280, height: 800)
            config.snapshotWidth = 1280
            webView.takeSnapshot(with: config) { image, error in
                guard let image = image else { print(error as Any); exit(1) }
                do { try writePNG(image, to: output.appendingPathComponent("setup-1280x800.png")); print("Store images rendered."); exit(0) }
                catch { print(error); exit(1) }
            }
        }
    }
}
let renderer = Renderer()
renderer.view.loadFileURL(root.appendingPathComponent("extension/options.html"), allowingReadAccessTo: root.appendingPathComponent("extension"))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("Render timed out"); exit(1) }
app.run()
