// 商品写真の自動仕上げ（Mac 上・無料・外部送信なし）。
// 被写体を切り抜き（macOS Vision の前景マスク＝iPhone の「被写体を持ち上げる」と同じ仕組み）→ 自動の色・明るさ補正 →
// 白背景に置いて薄い影 → 被写体に合わせて正方形にトリミング → JPEG。
//
// 使い方: studio <入力画像> <出力.jpg> [--mode auto|studio|enhance] [--size 2048] [--pad 0.08] [--no-shadow]
//   auto（既定）: 被写体が画面の中に収まっていれば studio、はみ出し・大写し・被写体なしなら enhance
//   studio : 切り抜き＋白背景＋正方形トリミング＋補正 / enhance: 色・明るさの補正だけ（構図はそのまま）
// 標準出力に JSON: {"ok":true,"mode":"studio","coverage":0.31,"touchesEdge":false,"instances":1,"width":2048,"height":2048}
// ビルド: swiftc -O tools/studio.swift -o tools/bin/studio
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func emit(_ d: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: d)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(d["ok"] as? Bool == true ? 0 : 2)
}

var args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}
let size = CGFloat(Double(opt("--size") ?? "") ?? 2048)
let pad = CGFloat(Double(opt("--pad") ?? "") ?? 0.08)
let mode = opt("--mode") ?? "auto"
let shadow = !args.contains("--no-shadow")
args.removeAll { $0 == "--no-shadow" }
guard args.count == 2 else { emit(["ok": false, "reason": "usage: studio <in> <out.jpg>"]) }
let inURL = URL(fileURLWithPath: args[0])
let outURL = URL(fileURLWithPath: args[1])

// Upright pixels (EXIF orientation applied), so the mask and the crop line up.
guard let src = CIImage(contentsOf: inURL, options: [.applyOrientationProperty: true]) else { emit(["ok": false, "reason": "画像を読めません"]) }
let ctx = CIContext(options: [.useSoftwareRenderer: false])
let extent = src.extent
guard let cg = ctx.createCGImage(src, from: extent) else { emit(["ok": false, "reason": "画像を展開できません"]) }

// Colour and exposure: Core Image's own auto adjustments (no red-eye, no face tweaks) and a touch of vibrance.
var adjusted = src
for f in src.autoAdjustmentFilters(options: [.redEye: false, .features: []]) {
    f.setValue(adjusted, forKey: kCIInputImageKey)
    if let o = f.outputImage { adjusted = o }
}
let vib = CIFilter.vibrance(); vib.inputImage = adjusted; vib.amount = 0.12
adjusted = (vib.outputImage ?? adjusted).cropped(to: extent)

guard let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { emit(["ok": false, "reason": "色空間"]) }
func save(_ img: CIImage) {
    do {
        try ctx.writeJPEGRepresentation(of: img, to: outURL, colorSpace: srgb, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9])
    } catch { emit(["ok": false, "reason": "保存に失敗: \(error.localizedDescription)"]) }
}
/** Colour only, framing kept (long side at most `size`). */
func enhanceOnly(_ why: String, _ extra: [String: Any] = [:]) -> Never {
    let k = min(1, size / max(extent.width, extent.height))
    let img = adjusted.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)).transformed(by: CGAffineTransform(scaleX: k, y: k))
    save(img)
    emit(extra.merging(["ok": true, "mode": "enhance", "why": why, "width": Int(img.extent.width), "height": Int(img.extent.height)]) { a, _ in a })
}
if mode == "enhance" { enhanceOnly("指定") }

// 1) Foreground mask (all subjects: a product and its box both stay).
let req = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { emit(["ok": false, "reason": "切り抜きに失敗: \(error.localizedDescription)"]) }
guard let obs = req.results?.first, !obs.allInstances.isEmpty else { enhanceOnly("被写体が見つからない") }
guard let maskBuf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else { enhanceOnly("マスクを作れない") }
let mask = CIImage(cvPixelBuffer: maskBuf)

// Subject bounds and coverage from a small copy of the mask.
let small = mask.transformed(by: CGAffineTransform(scaleX: 256 / extent.width, y: 256 / extent.height))
var px = [UInt8](repeating: 0, count: 256 * 256)
ctx.render(small, toBitmap: &px, rowBytes: 256, bounds: CGRect(x: 0, y: 0, width: 256, height: 256), format: .L8, colorSpace: nil)
var minX = 256, minY = 256, maxX = -1, maxY = -1, on = 0
for y in 0..<256 { for x in 0..<256 where px[y * 256 + x] > 127 {
    on += 1; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
} }
let coverage = Double(on) / 65536
let cov = (coverage * 1000).rounded() / 1000
// The bitmap is rendered top-down; CI coordinates start at the bottom.
let sx = extent.width / 256, sy = extent.height / 256
let box = CGRect(x: CGFloat(minX) * sx, y: extent.height - CGFloat(maxY + 1) * sy, width: CGFloat(maxX - minX + 1) * sx, height: CGFloat(maxY - minY + 1) * sy)
let touchesEdge = minX <= 1 || minY <= 1 || maxX >= 254 || maxY >= 254
// Cutting out only works when the whole product is in the picture and not a close-up.
if mode == "auto" {
    if touchesEdge { enhanceOnly("被写体が画面の端で切れている", ["coverage": cov]) }
    if coverage > 0.75 { enhanceOnly("大写し", ["coverage": cov]) }
    if coverage < 0.02 { enhanceOnly("被写体が小さすぎる", ["coverage": cov]) }
}

// 3) Background: white, but a soft light grey when the product itself is mostly white (a white box on white disappears).
var sub = [UInt8](repeating: 0, count: 256 * 256 * 4)
let smallAdj = adjusted.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)).transformed(by: CGAffineTransform(scaleX: 256 / extent.width, y: 256 / extent.height))
ctx.render(smallAdj, toBitmap: &sub, rowBytes: 256 * 4, bounds: CGRect(x: 0, y: 0, width: 256, height: 256), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
var whiteish = 0
for i in 0..<(256 * 256) where px[i] > 127 {
    let r = Double(sub[i * 4]) / 255, g = Double(sub[i * 4 + 1]) / 255, b = Double(sub[i * 4 + 2]) / 255
    let mx = max(r, g, b), mn = min(r, g, b)
    if mx > 0.82 && (mx - mn) < 0.12 { whiteish += 1 }
}
let whiteRatio = on > 0 ? Double(whiteish) / Double(on) : 0
let lightProduct = whiteRatio > 0.35
let bgColor = lightProduct ? CIColor(red: 0.886, green: 0.894, blue: 0.906) : CIColor.white
let white = CIImage(color: bgColor).cropped(to: extent)
var base = white
if shadow {
    let soft = mask.applyingGaussianBlur(sigma: Double(max(extent.width, extent.height)) * 0.012)
        .transformed(by: CGAffineTransform(translationX: 0, y: -extent.height * 0.008))
    let grey = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.16)).cropped(to: extent)
    let blend = CIFilter.blendWithMask()
    blend.inputImage = grey; blend.backgroundImage = white; blend.maskImage = soft.cropped(to: extent)
    base = blend.outputImage?.cropped(to: extent) ?? white
}
let cut = CIFilter.blendWithMask()
cut.inputImage = adjusted; cut.backgroundImage = base; cut.maskImage = mask
guard var out = cut.outputImage?.cropped(to: extent) else { emit(["ok": false, "reason": "合成に失敗"]) }

// 4) Square crop around the subject with some air; beyond the photo it is just more white.
let side = max(box.width, box.height) * (1 + 2 * pad)
let crop = CGRect(x: box.midX - side / 2, y: box.midY - side / 2, width: side, height: side)
let canvas = CIImage(color: bgColor).cropped(to: crop)
out = out.composited(over: canvas).cropped(to: crop)
let scale = min(1, size / side)
out = out.transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY)).transformed(by: CGAffineTransform(scaleX: scale, y: scale))

save(out)
emit(["ok": true, "mode": "studio", "background": lightProduct ? "grey" : "white", "whiteRatio": (whiteRatio * 100).rounded() / 100, "coverage": cov, "touchesEdge": touchesEdge, "instances": obs.allInstances.count, "width": Int(out.extent.width), "height": Int(out.extent.height)])
