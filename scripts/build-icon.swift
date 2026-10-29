import AppKit

let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.32, green: 0.42, blue: 0.29, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 205, yRadius: 205).fill()
let glyph = NSAttributedString(string: "⌘", attributes: [
    .font: NSFont.systemFont(ofSize: 620, weight: .ultraLight),
    .foregroundColor: NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.93, alpha: 1)
])
let bounds = glyph.size()
glyph.draw(at: NSPoint(x: (1024 - bounds.width) / 2, y: (1024 - bounds.height) / 2 + 20))
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "resources/icon.png"))
