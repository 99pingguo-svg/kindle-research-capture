import UIKit
import CoreImage
import CoreVideo
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

/// Converted manual product photo (long edge 2000px, JPEG 0.82, orientation normalized, location/EXIF metadata stripped).
struct ProcessedManualPhoto {
    let jpeg: Data
    let thumb: Data
    let width: Int
    let height: Int
    let digest: String
}

enum PhotoTools {
    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

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

    /// Shared single-image pipeline for manual camera & manual library photos (Part 5):
    /// ImageIO thumbnail decode -> long edge 2000px, orientation applied, GPS/EXIF metadata stripped, JPEG 0.82.
    static func processManualPhoto(fileURL: URL) -> ProcessedManualPhoto? {
        guard let src = CGImageSourceCreateWithURL(fileURL as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return processManualPhoto(source: src)
    }

    static func processManualPhoto(data: Data) -> ProcessedManualPhoto? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return processManualPhoto(source: src)
    }

    private static func processManualPhoto(source src: CGImageSource) -> ProcessedManualPhoto? {
        let mainOpts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2000,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let mainImg = CGImageSourceCreateThumbnailAtIndex(src, 0, mainOpts as CFDictionary) else { return nil }
        let mainOut = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(mainOut, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        // Writing CGImage directly without source properties strips GPS/camera metadata while keeping orientation baked in.
        CGImageDestinationAddImage(dest, mainImg, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let jpeg = mainOut as Data

        guard let thumb = resized(src, 400) else { return nil }
        let digest = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        return ProcessedManualPhoto(jpeg: jpeg, thumb: thumb, width: mainImg.width, height: mainImg.height, digest: digest)
    }

    /// Fast center-crop gradient sharpness score for JPEG data (used to prefer sharp, focused frames).
    static func sharpness(data: Data) -> Double {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 480,
              ] as CFDictionary) else { return 0 }
        return sharpness(cgImage: img)
    }

    static func sharpness(cgImage: CGImage) -> Double {
        let side = 160
        var buf = [UInt8](repeating: 0, count: side * side)
        guard let ctx = CGContext(
            data: &buf,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        let w = cgImage.width
        let h = cgImage.height
        let crop = CGRect(x: Double(w) * 0.15, y: Double(h) * 0.15, width: Double(w) * 0.7, height: Double(h) * 0.7)
        if let cropped = cgImage.cropping(to: crop) {
            ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: side, height: side))
        } else {
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        return gradientEnergy(buf: buf, width: side, height: side, stride: side)
    }

    /// Direct Y-plane sharpness on a live video CVPixelBuffer (avoids allocations per frame).
    static func sharpness(pixelBuffer: CVPixelBuffer) -> Double {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return 0 }
        let w = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let h = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        guard w >= 64, h >= 64 else { return 0 }
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        let stepX = max(1, (w * 7 / 10) / 120)
        let stepY = max(1, (h * 7 / 10) / 120)
        let x0 = w * 15 / 100
        let x1 = w * 85 / 100 - stepX
        let y0 = h * 15 / 100
        let y1 = h * 85 / 100 - stepY
        var sum = 0.0
        var count = 0
        var y = y0
        while y < y1 {
            let row = ptr + y * stride
            let next = ptr + (y + stepY) * stride
            var x = x0
            while x < x1 {
                let c = Int(row[x])
                let dx = Int(row[x + stepX]) - c
                let dy = Int(next[x]) - c
                sum += Double(dx * dx + dy * dy)
                count += 1
                x += stepX
            }
            y += stepY
        }
        return count > 0 ? sum / Double(count) : 0
    }

    /// Convert a portrait back-camera video frame to oriented JPEG data.
    static func jpegData(from pixelBuffer: CVPixelBuffer) -> Data? {
        let ci = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return nil }
        return UIImage(cgImage: cg).jpegData(compressionQuality: 0.9)
    }

    private static func gradientEnergy(buf: [UInt8], width: Int, height: Int, stride: Int) -> Double {
        var sum = 0.0
        var count = 0
        for y in 1..<(height - 1) {
            let row = y * stride
            let next = (y + 1) * stride
            for x in 1..<(width - 1) {
                let c = Int(buf[row + x])
                let dx = Int(buf[row + x + 1]) - c
                let dy = Int(buf[next + x]) - c
                sum += Double(dx * dx + dy * dy)
                count += 1
            }
        }
        return count > 0 ? sum / Double(count) : 0
    }

    private static func resized(_ src: CGImageSource, _ side: Int) -> Data? {
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: side]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: img).jpegData(compressionQuality: 0.85)
    }

    /// Barcodes and printed text in a photo (with optional Vision regionOfInterest matching the scan guide frame).
    static func read(_ data: Data, barcodes: Bool, regionOfInterest: CGRect? = nil) -> (codes: [String], lines: [String]) {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2400] as CFDictionary) else { return ([], []) }
        let text = VNRecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.recognitionLanguages = ["ja-JP", "en-US"]
        text.usesLanguageCorrection = false
        if let roi = regionOfInterest, roi.width > 0.05, roi.height > 0.05 {
            text.regionOfInterest = roi
        }
        let bars = VNDetectBarcodesRequest()
        bars.symbologies = [.code128, .ean13, .ean8, .upce, .code39]
        try? VNImageRequestHandler(cgImage: img).perform(barcodes ? [text, bars] : [text])
        let lines = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        let codes = barcodes ? Array(Set((bars.results ?? []).compactMap { $0.payloadStringValue })) : []
        return (codes, lines)
    }
}
