// 商品写真の自動仕上げ（Mac 上・無料・外部送信なし）。
// 被写体を切り抜き（macOS Vision の前景マスク＝iPhone の「被写体を持ち上げる」と同じ仕組み）→ 自動の色・明るさ補正 →
// 白背景に置いて薄い影 → 被写体に合わせて正方形にトリミング → JPEG。
//
// 使い方: studio <入力画像> <出力.jpg> [--mode auto|studio|enhance] [--bg auto|white|grey] [--fill 0.72] [--size 2048] [--no-shadow] [--deshadow 0〜1]
//   --bg: white＝白抜き / grey＝明るいグレーのスタジオ風グラデーション / auto＝白っぽい商品はグレー、それ以外は白
//   --fill: 正方形の中で商品が占める大きさ（長い辺の割合）。省略時は形で決める（細長い0.86・やや長い0.82・四角っぽい0.76）。
//   傾き（四角い・細長い商品が1.5〜30°傾いていたらまっすぐに）も自動で直す。向きは写真の EXIF のまま。商品は少し上寄せ、下に接地影。
//   --deshadow: 商品の上に落ちた影（手・スマホ・物の影、片側だけ暗い）を明るく戻す強さ。文字や模様など小さな暗い部分は残す。
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
let opt0Fill: CGFloat? = opt("--fill").flatMap { Double($0) }.map { CGFloat(min(0.95, max(0.4, $0))) }
let bgOpt = opt("--bg") ?? "auto"
_ = opt("--pad") // (old option, no longer used)
let mode = opt("--mode") ?? "auto"
let deshadow = min(1, max(0, Double(opt("--deshadow") ?? "") ?? 0))
let shadow = !args.contains("--no-shadow")
args.removeAll { $0 == "--no-shadow" }
guard args.count == 2 else { emit(["ok": false, "reason": "usage: studio <in> <out.jpg>"]) }
let inURL = URL(fileURLWithPath: args[0])
let outURL = URL(fileURLWithPath: args[1])

// Upright pixels (EXIF orientation applied), so the mask and the crop line up.
guard let src0 = CIImage(contentsOf: inURL, options: [.applyOrientationProperty: true]) else { emit(["ok": false, "reason": "画像を読めません"]) }
let ctx = CIContext(options: [.useSoftwareRenderer: false])

// (Turning by 90°/180° from the printed text was tried and dropped: on a remote full of digits it chose upside down.
//  Photos already arrive upright from the camera's EXIF orientation.)
let src = src0
let extent = src.extent
guard let cg = ctx.createCGImage(src, from: extent) else { emit(["ok": false, "reason": "画像を展開できません"]) }

// Colour and exposure: Core Image's own auto adjustments (no red-eye, no face tweaks) and a touch of vibrance.
var adjusted = src
for f in src.autoAdjustmentFilters(options: [.redEye: false, .features: []]) {
    f.setValue(adjusted, forKey: kCIInputImageKey)
    if let o = f.outputImage { adjusted = o }
}
// Only 70% of the auto adjustment (the full one flattened highlights and pushed colours), then a touch of vibrance.
let mix = CIFilter.dissolveTransition(); mix.inputImage = src; mix.targetImage = adjusted; mix.time = 0.7
adjusted = (mix.outputImage ?? adjusted).cropped(to: extent)
let vib = CIFilter.vibrance(); vib.inputImage = adjusted; vib.amount = 0.08
adjusted = (vib.outputImage ?? adjusted).cropped(to: extent)

/**
 * Lift shadows cast on the product. Lighting is estimated from the product pixels only (dilate, then a wide
 * normalised blur, so text and small dark details do not count as shadow); areas darker than the product's typical
 * lighting are divided back up. Only ever brightens, at most ×4 (linear light: a shadow that looks half as bright is about a quarter of the light).
 */
var shadowScore = 0.0
func liftShadows(_ img: CIImage, mask m: CIImage, strength: Double) -> CIImage {
    let ext = img.extent
    let long = Double(max(ext.width, ext.height))
    let grey = CIFilter.colorMatrix()
    grey.inputImage = img
    let w = CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0)
    grey.rVector = w; grey.gVector = w; grey.bVector = w; grey.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    let lum = (grey.outputImage ?? img).cropped(to: ext)
    let mul = CIFilter.multiplyCompositing()
    mul.inputImage = lum; mul.backgroundImage = m
    let masked = (mul.outputImage ?? lum).cropped(to: ext)
    let dil = CIFilter.morphologyMaximum()
    dil.inputImage = masked.clampedToExtent(); dil.radius = Float(long * 0.01)
    let sigma = long * 0.015
    let num = (dil.outputImage ?? masked).cropped(to: ext).clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: ext)
    let mul2 = CIFilter.multiplyCompositing()
    mul2.inputImage = num; mul2.backgroundImage = m
    let numM = (mul2.outputImage ?? num).cropped(to: ext).clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: ext)
    let den = m.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: ext)
    let div = CIFilter.divideBlendMode()
    div.inputImage = den; div.backgroundImage = numM
    let illum = (div.outputImage ?? num).cropped(to: ext)
    // Typical lighting on the product = masked average of the estimate, a little raised.
    func avg(_ i: CIImage) -> Double {
        let a = CIFilter.areaAverage(); a.inputImage = i; a.extent = ext
        var px = [Float](repeating: 0, count: 4)
        ctx.render(a.outputImage!, toBitmap: &px, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: nil)
        return Double(px[0])
    }
    let mulI = CIFilter.multiplyCompositing(); mulI.inputImage = illum; mulI.backgroundImage = m
    let mArea = avg(m)
    guard mArea > 0.001 else { return img }
    let target = min(0.98, avg((mulI.outputImage ?? illum).cropped(to: ext)) / mArea * 1.12)
    // Shadow score: share of the product lit at under 45% of its typical light (≈ two thirds as bright to the eye).
    let n = 128
    let toSmall = CGAffineTransform(translationX: -ext.minX, y: -ext.minY).scaledBy(x: CGFloat(n) / ext.width, y: CGFloat(n) / ext.height)
    var il = [Float](repeating: 0, count: n * n), mk = [Float](repeating: 0, count: n * n)
    ctx.render(illum.transformed(by: toSmall), toBitmap: &il, rowBytes: n * 4, bounds: CGRect(x: 0, y: 0, width: n, height: n), format: .Rf, colorSpace: nil)
    ctx.render(m.transformed(by: toSmall), toBitmap: &mk, rowBytes: n * 4, bounds: CGRect(x: 0, y: 0, width: n, height: n), format: .Rf, colorSpace: nil)
    var inside = 0, dark = 0
    for i in 0..<(n * n) where mk[i] > 0.5 { inside += 1; if Double(il[i]) < target * 0.45 { dark += 1 } }
    shadowScore = inside > 0 ? (Double(dark) / Double(inside) * 1000).rounded() / 1000 : 0
    if strength <= 0 { return img }
    // ratio = illum / target, clamped to [0.5, 1], then eased by strength: 1 - s·(1 − ratio).
    let k = CGFloat(strength / target)
    let ratio = CIFilter.colorMatrix()
    ratio.inputImage = illum
    ratio.rVector = CIVector(x: k, y: 0, z: 0, w: 0); ratio.gVector = CIVector(x: k, y: 0, z: 0, w: 0); ratio.bVector = CIVector(x: k, y: 0, z: 0, w: 0)
    ratio.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    let b = CGFloat(1 - strength)
    ratio.biasVector = CIVector(x: b, y: b, z: b, w: 0)
    let clamp = CIFilter.colorClamp()
    clamp.inputImage = ratio.outputImage
    clamp.minComponents = CIVector(x: CGFloat(1 - strength * 0.75), y: CGFloat(1 - strength * 0.75), z: CGFloat(1 - strength * 0.75), w: 1)
    clamp.maxComponents = CIVector(x: 1, y: 1, z: 1, w: 1)
    let lift = CIFilter.divideBlendMode()
    lift.inputImage = (clamp.outputImage ?? illum).cropped(to: ext); lift.backgroundImage = img
    return (lift.outputImage ?? img).cropped(to: ext)
}

guard let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { emit(["ok": false, "reason": "色空間"]) }
func save(_ img: CIImage) {
    do {
        try ctx.writeJPEGRepresentation(of: img, to: outURL, colorSpace: srgb, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9])
    } catch { emit(["ok": false, "reason": "保存に失敗: \(error.localizedDescription)"]) }
}
/** Colour only, framing kept (long side at most `size`). */
func enhanceOnly(_ why: String, _ extra: [String: Any] = [:]) -> Never {
    let k = min(1, size / max(extent.width, extent.height))
    let lit = adjusted // shadows are only lifted on a cut-out product (on the whole frame it lightened the background too)
    let img = lit.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)).transformed(by: CGAffineTransform(scaleX: k, y: k))
    save(img)
    emit(extra.merging(["ok": true, "mode": "enhance", "why": why, "deshadow": 0, "width": Int(img.extent.width), "height": Int(img.extent.height)]) { a, _ in a })
}
if mode == "enhance" { enhanceOnly("指定") }

// 1) Foreground mask (all subjects: a product and its box both stay).
let req = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch { emit(["ok": false, "reason": "切り抜きに失敗: \(error.localizedDescription)"]) }
guard let obs = req.results?.first, !obs.allInstances.isEmpty else { enhanceOnly("被写体が見つからない") }
guard let maskBuf = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else { enhanceOnly("マスクを作れない") }
var mask = CIImage(cvPixelBuffer: maskBuf)

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
var box = CGRect(x: CGFloat(minX) * sx, y: extent.height - CGFloat(maxY + 1) * sy, width: CGFloat(maxX - minX + 1) * sx, height: CGFloat(maxY - minY + 1) * sy)
let touchesEdge = minX <= 1 || minY <= 1 || maxX >= 254 || maxY >= 254
// Cutting out only works when the whole product is in the picture and not a close-up.
if mode == "auto" {
    if touchesEdge { enhanceOnly("被写体が画面の端で切れている", ["coverage": cov]) }
    if coverage > 0.75 { enhanceOnly("大写し", ["coverage": cov]) }
    if coverage < 0.02 { enhanceOnly("被写体が小さすぎる", ["coverage": cov]) }
}

// 3) Background: white, or a light grey studio sweep (auto: grey when the product itself is mostly white, which vanishes on white).
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
let grey = bgOpt == "grey" || (bgOpt == "auto" && whiteRatio > 0.35)

// Clean edge: pull the mask in a hair (drops the fringe of the old background), then soften it.
let long = Double(max(extent.width, extent.height))
let choke = CIFilter.morphologyMinimum(); choke.inputImage = mask.clampedToExtent(); choke.radius = Float(max(1, long * 0.0012))
var edge = (choke.outputImage ?? mask).cropped(to: extent).clampedToExtent().applyingGaussianBlur(sigma: max(0.6, long * 0.0007)).cropped(to: extent)
var product = liftShadows(adjusted, mask: mask, strength: deshadow)

/**
 * 傾き: the smallest rectangle around the product's outline (convex hull, rotating calipers). A boxy or long product
 * that leans 1.5–30° is straightened. Round or irregular shapes (outline fills < 86% of that rectangle) are left as shot.
 */
func straightenAngle() -> (angle: Double, rectangular: Double) {
    var pts: [CGPoint] = []
    for y in 0..<256 {
        var lo = -1, hi = -1
        for x in 0..<256 where px[y * 256 + x] > 127 { if lo < 0 { lo = x }; hi = x }
        if lo >= 0 {
            let cy = extent.height - (CGFloat(y) + 0.5) * sy
            pts.append(CGPoint(x: (CGFloat(lo) + 0.5) * sx, y: cy)); pts.append(CGPoint(x: (CGFloat(hi) + 0.5) * sx, y: cy))
        }
    }
    guard pts.count >= 6 else { return (0, 0) }
    // Monotone-chain convex hull.
    let sorted = pts.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
    func cross(_ o: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat { (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x) }
    var lower: [CGPoint] = [], upper: [CGPoint] = []
    for q in sorted { while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], q) <= 0 { lower.removeLast() }; lower.append(q) }
    for q in sorted.reversed() { while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], q) <= 0 { upper.removeLast() }; upper.append(q) }
    let hull = Array(lower.dropLast() + upper.dropLast())
    guard hull.count >= 3 else { return (0, 0) }
    var hullArea: CGFloat = 0
    for i in 0..<hull.count { let a = hull[i], b = hull[(i + 1) % hull.count]; hullArea += a.x * b.y - b.x * a.y }
    hullArea = abs(hullArea) / 2
    var bestArea = CGFloat.infinity, bestAngle = 0.0
    for i in 0..<hull.count {
        let a = hull[i], b = hull[(i + 1) % hull.count]
        let t = atan2(Double(b.y - a.y), Double(b.x - a.x))
        let c = CGFloat(cos(t)), s = CGFloat(sin(t))
        var x0 = CGFloat.infinity, x1 = -CGFloat.infinity, y0 = CGFloat.infinity, y1 = -CGFloat.infinity
        for q in hull { let u = q.x * c + q.y * s, v = -q.x * s + q.y * c; x0 = min(x0, u); x1 = max(x1, u); y0 = min(y0, v); y1 = max(y1, v) }
        let area = (x1 - x0) * (y1 - y0)
        if area < bestArea { bestArea = area; bestAngle = t }
    }
    // Fold to (-45°, 45°]: the turn that brings the nearest rectangle side level.
    var deg = bestAngle * 180 / .pi
    while deg > 45 { deg -= 90 }
    while deg <= -45 { deg += 90 }
    return (deg, Double(hullArea / bestArea))
}
let (tilt, rectangular) = straightenAngle()
var straightened = 0.0
if abs(tilt) >= 1.5 && abs(tilt) <= 30 && rectangular >= 0.86 {
    let c = CGPoint(x: extent.midX, y: extent.midY)
    let r = CGAffineTransform(translationX: c.x, y: c.y).rotated(by: CGFloat(-tilt * .pi / 180)).translatedBy(x: -c.x, y: -c.y)
    product = product.transformed(by: r); edge = edge.transformed(by: r); mask = mask.transformed(by: r)
    // New bounds from the turned mask.
    let me = mask.extent
    let k = 256 / max(me.width, me.height)
    var q = [UInt8](repeating: 0, count: 256 * 256)
    ctx.render(mask.transformed(by: CGAffineTransform(translationX: -me.minX, y: -me.minY).concatenating(CGAffineTransform(scaleX: k, y: k))), toBitmap: &q, rowBytes: 256, bounds: CGRect(x: 0, y: 0, width: 256, height: 256), format: .L8, colorSpace: nil)
    var a0 = 256, a1 = -1, b0 = 256, b1 = -1
    for y in 0..<256 { for x in 0..<256 where q[y * 256 + x] > 127 { a0 = min(a0, x); a1 = max(a1, x); b0 = min(b0, y); b1 = max(b1, y) } }
    if a1 >= 0 {
        // (rendered top-down from the top of the rendered area)
        let top = me.minY + 256 / k
        box = CGRect(x: me.minX + CGFloat(a0) / k, y: top - CGFloat(b1 + 1) / k, width: CGFloat(a1 - a0 + 1) / k, height: CGFloat(b1 - b0 + 1) / k)
        straightened = (tilt * 10).rounded() / 10
    }
}

// 4) Square canvas: the product fills `fill` of it, sitting a little above centre so its shadow has room.
// トリミング: long products fill more of the square, near-square ones a little less (they look heavy otherwise).
let aspect = max(box.width, box.height) / max(1, min(box.width, box.height))
let fillNow = opt0Fill ?? (aspect >= 2.2 ? 0.86 : aspect >= 1.4 ? 0.82 : 0.76)
let side = max(box.width, box.height) / fillNow
let crop = CGRect(x: box.midX - side / 2, y: box.midY - side / 2 - side * 0.03, width: side, height: side)
func srgbColor(_ v: Double) -> CIColor { CIColor(red: v, green: v, blue: v, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)! }
var bg: CIImage
if grey {
    let g = CIFilter.linearGradient()
    g.point0 = CGPoint(x: crop.midX, y: crop.maxY); g.color0 = srgbColor(0.965)
    g.point1 = CGPoint(x: crop.midX, y: crop.minY); g.color1 = srgbColor(0.885)
    bg = (g.outputImage ?? CIImage(color: srgbColor(0.93))).cropped(to: crop)
} else {
    bg = CIImage(color: .white).cropped(to: crop)
}
func shade(_ m: CIImage, _ alpha: Double) {
    let dark = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: alpha)).cropped(to: crop)
    let b = CIFilter.blendWithMask(); b.inputImage = dark; b.backgroundImage = bg; b.maskImage = m.cropped(to: crop)
    bg = (b.outputImage ?? bg).cropped(to: crop)
}
if shadow {
    // Soft ambient shadow, then a thin contact shadow: the silhouette squashed flat at the product's foot.
    shade(mask.clampedToExtent().applyingGaussianBlur(sigma: Double(side) * 0.03).transformed(by: CGAffineTransform(translationX: 0, y: -side * 0.012)), grey ? 0.10 : 0.07)
    let foot = box.minY
    // (one transform at a time: move the foot to y=0, squash, move back just under the foot)
    let flat = mask.transformed(by: CGAffineTransform(translationX: 0, y: -foot))
        .transformed(by: CGAffineTransform(scaleX: 1, y: 0.04))
        .transformed(by: CGAffineTransform(translationX: 0, y: foot - side * 0.006))
    shade(flat.applyingGaussianBlur(sigma: Double(side) * 0.012), grey ? 0.22 : 0.17)
}
let cut = CIFilter.blendWithMask()
cut.inputImage = product; cut.backgroundImage = bg; cut.maskImage = edge.cropped(to: crop)
guard var out = cut.outputImage?.cropped(to: crop) else { emit(["ok": false, "reason": "合成に失敗"]) }
let scale = min(1, size / side)
out = out.transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY)).transformed(by: CGAffineTransform(scaleX: scale, y: scale))

save(out)
emit(["ok": true, "mode": "studio", "straightened": straightened, "rectangular": (rectangular * 100).rounded() / 100, "deshadow": deshadow, "shadowScore": shadowScore, "background": grey ? "grey" : "white", "whiteRatio": (whiteRatio * 100).rounded() / 100, "coverage": cov, "touchesEdge": touchesEdge, "instances": obs.allInstances.count, "width": Int(out.extent.width), "height": Int(out.extent.height)])
