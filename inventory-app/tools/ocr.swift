// 写真の文字とバーコードを読む（Mac 上・無料・外部送信なし）。商品の検索に使う。
// macOS Vision の文字認識（日本語・英語）とバーコード検出（JAN/EAN・QR など）。
//
// 使い方: ocr <入力画像>
// 標準出力に JSON: {"ok":true,"lines":[{"text":"…","conf":0.98,"h":0.06,"box":[x,y,w,h]}],"barcodes":["4901234567894"],"barcodeBoxes":[{"value":"…","box":[x,y,w,h]}]}
//   box は画像に対する割合（0〜1）、左上が原点。
//   h = 文字の高さ（画像の高さに対する比）。大きい文字ほど商品名らしいので、並びは大きい順。
// ビルド: swiftc -O tools/ocr.swift -o tools/bin/ocr
import Foundation
import ImageIO
import Vision

func emit(_ d: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: d)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(d["ok"] as? Bool == true ? 0 : 2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let input = args.first else { emit(["ok": false, "error": "usage: ocr <image>"]) }
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { emit(["ok": false, "error": "画像を読めません"]) }
// Respect the EXIF orientation so sideways phone photos read correctly.
let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
let orientation = CGImagePropertyOrientation(rawValue: (props?[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up

let text = VNRecognizeTextRequest()
text.recognitionLevel = .accurate
text.usesLanguageCorrection = true
text.recognitionLanguages = ["ja-JP", "en-US"]
let barcodes = VNDetectBarcodesRequest()

do {
    try VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:]).perform([text, barcodes])
} catch {
    emit(["ok": false, "error": "文字認識に失敗しました: \(error.localizedDescription)"])
}

var lines: [[String: Any]] = []
for obs in text.results ?? [] {
    guard let best = obs.topCandidates(1).first else { continue }
    let s = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { continue }
    let b = obs.boundingBox // Vision: bottom-left origin → top-left for callers
    lines.append(["text": s, "conf": Double(best.confidence), "h": Double(b.height), "box": [Double(b.minX), Double(1 - b.maxY), Double(b.width), Double(b.height)]])
}
lines.sort { ($0["h"] as! Double) > ($1["h"] as! Double) }
var codes: [String] = []
var codeBoxes: [[String: Any]] = []
for b in barcodes.results ?? [] {
    guard let v = b.payloadStringValue else { continue }
    if !codes.contains(v) { codes.append(v) }
    let r = b.boundingBox
    codeBoxes.append(["value": v, "box": [Double(r.minX), Double(1 - r.maxY), Double(r.width), Double(r.height)]])
}
emit(["ok": true, "lines": lines, "barcodes": codes, "barcodeBoxes": codeBoxes])
