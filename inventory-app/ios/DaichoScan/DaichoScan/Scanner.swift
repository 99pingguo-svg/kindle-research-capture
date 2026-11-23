import AVFoundation
import SwiftUI
import UIKit

/// Tunable scan timing and guide margin constants (T-012).
enum ScanTiming {
    static let postActionCooldown: TimeInterval = 0.8
    static let differentCodeInterval: TimeInterval = 0.8
    static let sameCodeMinInterval: TimeInterval = 3.0
    static let sameCodeAbsenceThreshold: TimeInterval = 0.5
    /// Expand guide rect by +12% (within +10–15% target) for barcode & OCR tolerance.
    static let guideMarginRatio: CGFloat = 0.12
}

/// Shutter capture state machine (T-010 Stage 3): prevents double-capture without fixed cooldown timers.
enum ShutterState: Equatable {
    case idle
    case capturing
    case processing
}

/// The live camera: persistent AVCaptureSession shared across barcode scanning and manual product photo capture.
final class Scanner: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate, AVCapturePhotoCaptureDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
    private struct BufferedFrame {
        let buffer: CVPixelBuffer
        let sharpness: Double
        let focused: Bool
        let at: Date
    }

    let session = AVCaptureSession()
    private let metadata = AVCaptureMetadataOutput()
    private let photoOut = AVCapturePhotoOutput()
    private let videoOut = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "scanner")
    private let videoQueue = DispatchQueue(label: "scanner.video")
    private var camera: AVCaptureDevice?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var guideRectInLayer: CGRect = .zero
    private var waiting: [(Data?) -> Void] = []
    private var recentFrames: [BufferedFrame] = []
    private var lastFrameEval = Date.distantPast

    /// Track continuous in-frame presence of each barcode for the 0.5s absence requirement (T-012).
    private var lastSeenInFrameAt: [String: Date] = [:]
    private var absentLongEnough: Set<String> = []

    /// Callback delivers (code, wasAbsentEnoughSincePreviousFrame).
    var onCode: ((String, Bool) -> Void)?
    /// Vision-normalized ROI (origin at bottom-left, 0...1) corresponding to the expanded guide box.
    private(set) var ocrRegionOfInterest: CGRect?

    @Published var ready = false
    @Published var problem = ""
    @Published var shutterState: ShutterState = .idle
    @Published var flashTrigger = 0
    @Published var focusIndicatorPoint: CGPoint?

    func start() {
        AVCaptureDevice.requestAccess(for: .video) { ok in
            guard ok else { DispatchQueue.main.async { self.problem = "カメラの使用が許可されていません（設定 → 台帳スキャン）" }; return }
            self.queue.async { self.configure() }
        }
    }

    func setRunning(_ on: Bool) {
        queue.async {
            if on && !self.session.isRunning { self.session.startRunning() }
            if !on && self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func configure() {
        guard !ready, let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: cam) else {
            DispatchQueue.main.async { self.problem = "カメラを使えません" }
            return
        }
        self.camera = cam
        session.beginConfiguration()
        session.sessionPreset = .photo
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(photoOut) { session.addOutput(photoOut) }
        if session.canAddOutput(metadata) { session.addOutput(metadata) }
        videoOut.alwaysDiscardsLateVideoFrames = true
        videoOut.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOut.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(videoOut) { session.addOutput(videoOut) }
        metadata.setMetadataObjectsDelegate(self, queue: .main)
        let want: [AVMetadataObject.ObjectType] = [.code128, .ean13, .ean8, .upce, .code39]
        metadata.metadataObjectTypes = want.filter { metadata.availableMetadataObjectTypes.contains($0) }
        session.commitConfiguration()
        if (try? cam.lockForConfiguration()) != nil {
            if cam.isFocusModeSupported(.continuousAutoFocus) { cam.focusMode = .continuousAutoFocus }
            if cam.isAutoFocusRangeRestrictionSupported { cam.autoFocusRangeRestriction = .near }
            if cam.isExposureModeSupported(.continuousAutoExposure) { cam.exposureMode = .continuousAutoExposure }
            cam.unlockForConfiguration()
        }
        session.startRunning()
        DispatchQueue.main.async {
            self.ready = true
            self.applyGuideRectOfInterest()
        }
    }

    /// Register preview layer and guide frame rectangle (in preview view coordinates) for rectOfInterest + OCR ROI.
    func updatePreviewLayout(layer: AVCaptureVideoPreviewLayer, guideRect: CGRect?) {
        self.previewLayer = layer
        if let guideRect {
            self.guideRectInLayer = guideRect
            applyGuideRectOfInterest()
        }
    }

    func applyGuideRectOfInterest() {
        guard ready, let layer = previewLayer, layer.bounds.width > 10, layer.bounds.height > 10,
              guideRectInLayer.width > 10, guideRectInLayer.height > 10 else { return }
        let marginX = guideRectInLayer.width * ScanTiming.guideMarginRatio
        let marginY = guideRectInLayer.height * ScanTiming.guideMarginRatio
        let expanded = guideRectInLayer.insetBy(dx: -marginX, dy: -marginY).intersection(layer.bounds)
        let metaRect = layer.metadataOutputRectConverted(fromLayerRect: expanded)
        if metaRect.width > 0.05, metaRect.height > 0.05 {
            queue.async {
                self.metadata.rectOfInterest = metaRect
            }
            // Convert preview-relative normalized coordinates to portrait Vision coordinates (origin bottom-left).
            let nx = max(0, min(1, expanded.minX / layer.bounds.width))
            let nyTop = max(0, min(1, expanded.minY / layer.bounds.height))
            let nw = max(0.05, min(1 - nx, expanded.width / layer.bounds.width))
            let nh = max(0.05, min(1 - nyTop, expanded.height / layer.bounds.height))
            self.ocrRegionOfInterest = CGRect(x: nx, y: max(0, 1 - nyTop - nh), width: nw, height: nh)
        }
    }

    /// Tap outside the shutter button: tap-to-focus ONLY (never fires shutter).
    func focusAtLayerPoint(_ point: CGPoint) {
        guard let layer = previewLayer else { return }
        let devicePoint = layer.captureDevicePointConverted(fromLayerPoint: point)
        DispatchQueue.main.async {
            self.focusIndicatorPoint = point
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                if self?.focusIndicatorPoint == point { self?.focusIndicatorPoint = nil }
            }
        }
        queue.async {
            guard let cam = self.camera, (try? cam.lockForConfiguration()) != nil else { return }
            if cam.isFocusPointOfInterestSupported {
                cam.focusPointOfInterest = devicePoint
                if cam.isFocusModeSupported(.autoFocus) { cam.focusMode = .autoFocus }
                else if cam.isFocusModeSupported(.continuousAutoFocus) { cam.focusMode = .continuousAutoFocus }
            }
            if cam.isExposurePointOfInterestSupported {
                cam.exposurePointOfInterest = devicePoint
                if cam.isExposureModeSupported(.continuousAutoExposure) { cam.exposureMode = .continuousAutoExposure }
            }
            cam.unlockForConfiguration()
            // Restore continuous AF shortly after locking focus on the tapped area.
            self.queue.asyncAfter(deadline: .now() + 1.5) {
                guard let cam = self.camera, (try? cam.lockForConfiguration()) != nil else { return }
                if cam.isFocusModeSupported(.continuousAutoFocus) { cam.focusMode = .continuousAutoFocus }
                cam.unlockForConfiguration()
            }
        }
    }

    /// Reset absence tracker for a code when user explicitly requests "同じコードを再読".
    func clearAbsenceTracking(for code: String) {
        lastSeenInFrameAt.removeValue(forKey: code)
        absentLongEnough.insert(code)
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let now = Date()
        for case let o as AVMetadataMachineReadableCodeObject in objects {
            guard let s = o.stringValue, !s.isEmpty else { continue }
            let wasAbsent: Bool
            if let prev = lastSeenInFrameAt[s] {
                wasAbsent = now.timeIntervalSince(prev) >= ScanTiming.sameCodeAbsenceThreshold || absentLongEnough.contains(s)
            } else {
                wasAbsent = true
            }
            lastSeenInFrameAt[s] = now
            absentLongEnough.remove(s)
            onCode?(s, wasAbsent)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastFrameEval) >= 0.08,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrameEval = now
        let focused = !(camera?.isAdjustingFocus ?? false)
        let score = PhotoTools.sharpness(pixelBuffer: pb)
        recentFrames.append(BufferedFrame(buffer: pb, sharpness: score, focused: focused, at: now))
        if recentFrames.count > 6 { recentFrames.removeFirst(recentFrames.count - 6) }
    }

    /// Touch shutter action (T-010 Stage 3): state-machine guarded (idle -> capturing -> processing -> idle),
    /// provides medium haptic feedback and visual flash even in silent mode.
    @MainActor
    func triggerManualShutter(process: @escaping (Data) async -> Void) async {
        guard shutterState == .idle else { return }
        shutterState = .capturing
        let haptic = UIImpactFeedbackGenerator(style: .medium)
        haptic.prepare()
        let data = await capture(preferStillOnly: true)
        guard let data else {
            shutterState = .idle
            return
        }
        haptic.impactOccurred()
        flashTrigger += 1
        shutterState = .processing
        await process(data)
        shutterState = .idle
    }

    /// Wait briefly for autofocus to settle, then return the sharpest focused frame (high-res still preferred when sharp).
    func capture(preferStillOnly: Bool = false) async -> Data? {
        for _ in 0..<8 {
            let adjusting = queue.sync { self.camera?.isAdjustingFocus ?? false }
            if !adjusting { break }
            try? await Task.sleep(for: .milliseconds(45))
        }
        let stillData = await captureStill()
        if preferStillOnly { return stillData }
        let bestVideo: (data: Data, sharpness: Double, focused: Bool)? = videoQueue.sync {
            let cutoff = Date().addingTimeInterval(-1.2)
            let fresh = recentFrames.filter { $0.at >= cutoff }
            let pool = fresh.filter(\.focused).isEmpty ? fresh : fresh.filter(\.focused)
            guard let best = pool.max(by: { $0.sharpness < $1.sharpness }),
                  let jpg = PhotoTools.jpegData(from: best.buffer) else { return nil }
            return (jpg, best.sharpness, best.focused)
        }
        if let stillData {
            if let bestVideo, bestVideo.focused {
                let stillScore = await Task.detached { PhotoTools.sharpness(data: stillData) }.value
                if stillScore < bestVideo.sharpness * 0.45 {
                    return bestVideo.data
                }
            }
            return stillData
        }
        return bestVideo?.data
    }

    private func captureStill() async -> Data? {
        await withCheckedContinuation { cont in
            queue.async {
                guard self.session.isRunning else { cont.resume(returning: nil); return }
                self.waiting.append { cont.resume(returning: $0) }
                if self.waiting.count == 1 {
                    self.photoOut.capturePhoto(with: AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]), delegate: self)
                }
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let data = photo.fileDataRepresentation()
        queue.async {
            let all = self.waiting
            self.waiting.removeAll()
            all.forEach { $0(data) }
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let scanner: Scanner
    let guideSize: CGSize?

    final class View: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        weak var scanner: Scanner?
        var guideSize: CGSize?

        override func layoutSubviews() {
            super.layoutSubviews()
            updateGuide()
        }

        func updateGuide() {
            guard let scanner, bounds.width > 10, bounds.height > 10 else { return }
            if let size = guideSize {
                let rect = CGRect(
                    x: (bounds.width - size.width) / 2,
                    y: (bounds.height - size.height) / 2,
                    width: size.width,
                    height: size.height
                )
                scanner.updatePreviewLayout(layer: preview, guideRect: rect)
            } else {
                scanner.updatePreviewLayout(layer: preview, guideRect: nil)
            }
        }

        @objc func handleTap(_ g: UITapGestureRecognizer) {
            let pt = g.location(in: self)
            scanner?.focusAtLayerPoint(pt)
        }
    }

    func makeUIView(context: Context) -> View {
        let v = View()
        v.scanner = scanner
        v.guideSize = guideSize
        v.preview.session = scanner.session
        v.preview.videoGravity = .resizeAspectFill
        let tap = UITapGestureRecognizer(target: v, action: #selector(View.handleTap(_:)))
        v.addGestureRecognizer(tap)
        return v
    }

    func updateUIView(_ uiView: View, context: Context) {
        uiView.scanner = scanner
        uiView.guideSize = guideSize
        uiView.updateGuide()
    }
}
