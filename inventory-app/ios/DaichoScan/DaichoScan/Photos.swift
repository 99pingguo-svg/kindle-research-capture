import UIKit
import ImageIO
import UniformTypeIdentifiers
import Vision
import CryptoKit

/// A photo ready to send: the JPEG with its own metadata, plus the smaller copies the ledger shows.
struct PhotoData {
    let original: Data
    let work: Data
    let thumb: Data
    let width: Int
    let height: Int
    let takenAt: Date
    let digest: String
}

enum PhotoTools {
    /// When the photo was really taken (EXIF DateTimeOriginal), works for HEIC and JPEG.
    static func shotTime(_ data: Data) -> Date? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        return f.date(from: s)
    }

    /// JPEG with the original metadata kept (HEIC from the library becomes JPEG), and work/thumb copies.
    static func prepare(_ data: Data, fallbackTime: Date) -> PhotoData? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let original: Data
        if (CGImageSourceGetType(src) as String?) == UTType.jpeg.identifier {
            original = data
        } else {
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImageFromSource(dest, src, 0, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            original = out as Data
        }
        guard let work = resized(src, 1600), let thumb = resized(src, 400) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
        let h = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return PhotoData(original: original, work: work, thumb: thumb, width: w, height: h, takenAt: shotTime(data) ?? fallbackTime, digest: digest)
    }

    private static func resized(_ src: CGImageSource, _ side: Int) -> Data? {
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: side]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: img).jpegData(compressionQuality: 0.85)
    }

    /// Barcodes and printed text in a photo (the label shows the start of the Amazon name).
    static func read(_ data: Data, barcodes: Bool) -> (codes: [String], lines: [String]) {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400] as CFDictionary) else { return ([], []) }
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.recognitionLanguages = ["ja-JP", "en-US"]
        text.usesLanguageCorrection = false
        let bars = VNDetectBarcodesRequest()
        bars.symbologies = [.code128, .ean13, .ean8, .upce, .code39]
        try? VNImageRequestHandler(cgImage: img).perform(barcodes ? [text, bars] : [text])
        let lines = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let codes = barcodes ? Array(Set((bars.results ?? []).compactMap { $0.payloadStringValue })) : []
        return (codes, lines)
    }
}
