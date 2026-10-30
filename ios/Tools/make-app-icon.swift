#!/usr/bin/env swift
// Draws the app icon as a 1024x1024 PNG.
//
// Kept as source rather than a checked-in binary blob nobody can edit: the icon
// is a few shapes, and this way changing it is a code change with a diff.
//
//   swift Tools/make-app-icon.swift Flood/Assets.xcassets/AppIcon.appiconset/AppIcon.png

import AppKit
import CoreGraphics

let size = 1024
let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "AppIcon.png"

guard let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("could not create a bitmap context") }

let side = CGFloat(size)

// Background: a vertical gradient, teal into deep blue. No rounded corners --
// iOS masks the icon itself, and rounding it here would show as a dark seam.
let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    colors: [
        CGColor(red: 0.18, green: 0.78, blue: 0.84, alpha: 1),
        CGColor(red: 0.07, green: 0.40, blue: 0.66, alpha: 1),
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(gradient,
                           start: CGPoint(x: 0, y: side),
                           end: CGPoint(x: 0, y: 0),
                           options: [])

/// A teardrop centred on `centre`: a circular bottom with a point on top.
func droplet(centre: CGPoint, radius r: CGFloat, height h: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let apex = CGPoint(x: centre.x, y: centre.y + h)

    path.move(to: apex)
    // Down the right flank into the circle's rightmost point.
    path.addCurve(to: CGPoint(x: centre.x + r, y: centre.y),
                  control1: CGPoint(x: centre.x + r * 0.42, y: centre.y + h * 0.55),
                  control2: CGPoint(x: centre.x + r, y: centre.y + r * 0.72))
    // The bottom half, from right round to left.
    path.addArc(center: centre, radius: r, startAngle: 0, endAngle: .pi, clockwise: true)
    // Back up the left flank to the point.
    path.addCurve(to: apex,
                  control1: CGPoint(x: centre.x - r, y: centre.y + r * 0.72),
                  control2: CGPoint(x: centre.x - r * 0.42, y: centre.y + h * 0.55))
    path.closeSubpath()
    return path
}

let centre = CGPoint(x: side * 0.5, y: side * 0.40)
let radius = side * 0.20
let height = side * 0.40

// A soft shadow so the drop lifts off the gradient rather than sitting flat on it.
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -side * 0.012),
                  blur: side * 0.045,
                  color: CGColor(red: 0, green: 0.15, blue: 0.3, alpha: 0.35))
context.addPath(droplet(centre: centre, radius: radius, height: height))
context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.fillPath()
context.restoreGState()

// Three strokes to the upper left, echoing the humidity mark used in the app.
context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.85))
context.setLineCap(.round)
context.setLineWidth(side * 0.045)
for (index, y) in [0.60, 0.70, 0.80].enumerated() {
    let lineY = side * CGFloat(y)
    let inset = side * (0.20 + CGFloat(index) * 0.035)
    context.move(to: CGPoint(x: inset, y: lineY))
    context.addLine(to: CGPoint(x: inset + side * (0.26 - CGFloat(index) * 0.045), y: lineY))
}
context.strokePath()

guard let image = context.makeImage() else { fatalError("could not render") }
let rep = NSBitmapImageRep(cgImage: image)
guard let png = rep.representation(using: .png, properties: [:]) else {
    fatalError("could not encode PNG")
}
try png.write(to: URL(fileURLWithPath: outputPath))
print("wrote \(outputPath) (\(size)x\(size))")
