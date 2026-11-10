// Draws the app's placeholder icon: the wordmark's first two letters on a dark tile, in the shape and margins
// macOS expects of an app icon (an 824pt rounded square centered on a 1024pt canvas).
// Usage: swift scripts/make-icon.swift OUT.png   (scripts/make-icon.sh turns that into build/icon.icns)
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let side = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: side, height: side)
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

// The tile: near black, a little lighter at the top, with a hairline so it keeps its edge on a dark Dock.
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: NSColor.black.withAlphaComponent(0.3).cgColor)
ctx.addPath(shape)
ctx.setFillColor(NSColor(white: 0.07, alpha: 1).cgColor)
ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let shades = [NSColor(white: 0.2, alpha: 1).cgColor, NSColor(white: 0.04, alpha: 1).cgColor] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: shades, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])
ctx.addPath(shape)
ctx.setStrokeColor(NSColor(white: 1, alpha: 0.16).cgColor)
ctx.setLineWidth(6)
ctx.strokePath()
ctx.restoreGState()

// The letters, centered on what is actually inked rather than on the line box.
let text = NSAttributedString(string: "Ch", attributes: [
  .font: NSFont.systemFont(ofSize: 430, weight: .semibold),
  .foregroundColor: NSColor(white: 0.96, alpha: 1),
  .kern: -14,
])
let line = CTLineCreateWithAttributedString(text)
let ink = CTLineGetImageBounds(line, ctx)
ctx.textPosition = CGPoint(x: tile.midX - ink.width / 2 - ink.minX, y: tile.midY - ink.height / 2 - ink.minY)
CTLineDraw(line, ctx)

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
