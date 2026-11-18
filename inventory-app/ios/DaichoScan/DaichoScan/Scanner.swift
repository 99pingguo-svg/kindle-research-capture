import AVFoundation
import SwiftUI

/// The live camera: reports barcodes as they come into view and takes a still photo on request.
final class Scanner: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate, AVCapturePhotoCaptureDelegate {
    let session = AVCaptureSession()
    private let metadata = AVCaptureMetadataOutput()
    private let photoOut = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "scanner")
    private var waiting: [(Data?) -> Void] = []
    var onCode: ((String) -> Void)?
    @Published var ready = false
    @Published var problem = ""

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
        session.beginConfiguration()
        session.sessionPreset = .photo
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(photoOut) { session.addOutput(photoOut) }
        if session.canAddOutput(metadata) { session.addOutput(metadata) }
        metadata.setMetadataObjectsDelegate(self, queue: .main)
        let want: [AVMetadataObject.ObjectType] = [.code128, .ean13, .ean8, .upce, .code39]
        metadata.metadataObjectTypes = want.filter { metadata.availableMetadataObjectTypes.contains($0) }
        session.commitConfiguration()
        if cam.isFocusModeSupported(.continuousAutoFocus), (try? cam.lockForConfiguration()) != nil {
            cam.focusMode = .continuousAutoFocus
            if cam.isAutoFocusRangeRestrictionSupported { cam.autoFocusRangeRestriction = .near }
            cam.unlockForConfiguration()
        }
        session.startRunning()
        DispatchQueue.main.async { self.ready = true }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        for case let o as AVMetadataMachineReadableCodeObject in objects {
            if let s = o.stringValue, !s.isEmpty { onCode?(s) }
        }
    }

    /// A still photo (JPEG with EXIF) of what the camera sees now.
    func capture() async -> Data? {
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
    let session: AVCaptureSession
    final class View: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    func makeUIView(context: Context) -> View {
        let v = View()
        v.preview.session = session
        v.preview.videoGravity = .resizeAspectFill
        return v
    }
    func updateUIView(_ uiView: View, context: Context) {}
}
