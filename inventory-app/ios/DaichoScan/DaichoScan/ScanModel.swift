import AVFoundation
import SwiftUI
import PhotosUI

/// One reading: a label seen by the camera or a photo from the library.
struct Entry: Identifiable {
    enum State {
        case looking
        case picked(Card)
        case choose([Card])
        case none(String)
        case failed(String)
    }
    let id = UUID()
    let code: String
    let fromLibrary: Bool
    let at: Date
    var state: State = .looking
    var fnsku = ""
    var photo: PhotoData?
    var saved = ""
}

@MainActor
final class ScanModel: ObservableObject {
    @Published var entries: [Entry] = []
    @Published var muted = false
    @Published var busyLibrary = 0
    let scanner = Scanner()
    private let voice = AVSpeechSynthesizer()
    private var lastSeen: [String: Date] = [:]

    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        scanner.onCode = { [weak self] code in Task { @MainActor in self?.seen(code) } }
    }

    /// Spoken one after another, in the order things were read.
    func speak(_ text: String) {
        guard !muted, !text.isEmpty else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        u.rate = 0.55
        voice.speak(u)
    }

    // MARK: camera

    private func seen(_ code: String) {
        let now = Date()
        // The same label stays in view for a while: read it again only after 20 seconds.
        if let t = lastSeen[code], now.timeIntervalSince(t) < 20 { return }
        lastSeen[code] = now
        let e = Entry(code: code, fromLibrary: false, at: now)
        entries.insert(e, at: 0)
        Task { await look(e.id, codes: [code]) }
    }

    private func look(_ id: UUID, codes: [String]) async {
        async let still = scanner.capture()
        do {
            var r = try await Api.scan(codes: codes, lines: [])
            update(id) { $0.fnsku = r.fnsku }
            if r.pick == nil {
                // Not known by its number: read the name printed on the label.
                if let data = await still {
                    let lines = await Task.detached { PhotoTools.read(data, barcodes: false).lines }.value
                    r = try await Api.scan(codes: codes, lines: lines)
                    update(id) { $0.fnsku = r.fnsku }
                }
            }
            let photo = await still.flatMap { PhotoTools.prepare($0, fallbackTime: Date()) }
            update(id) { $0.photo = photo }
            settle(id, r)
        } catch {
            update(id) { $0.state = .failed(error.localizedDescription) }
            speak("台帳につながりません")
        }
    }

    private func settle(_ id: UUID, _ r: Lookup) {
        if let p = r.pick {
            speak(p.say)
            update(id) { $0.state = .picked(p) }
            Task { await record(id, p) }
        } else if !r.candidates.isEmpty {
            speak(r.say)
            update(id) { $0.state = .choose(r.candidates) }
        } else {
            speak(r.say)
            update(id) { $0.state = .none(r.say) }
        }
    }

    /// The person chose one of the candidates.
    func choose(_ id: UUID, _ c: Card) {
        speak(c.say)
        update(id) { $0.state = .picked(c) }
        Task { await record(id, c) }
    }

    func dismiss(_ id: UUID) { entries.removeAll { $0.id == id } }

    /// ある + FNSKU, then the photo (the camera sends at most one per product per day; library photos each once).
    private func record(_ id: UUID, _ c: Card) async {
        guard let e = entries.first(where: { $0.id == id }) else { return }
        let today = Calendar.current.isDateInToday(e.photo?.takenAt ?? e.at)
        do {
            let card = try await Api.confirm(id: c.id, fnsku: e.fnsku, presence: today)
            var saved = today ? "ある に記録" : "撮影日だけ記録"
            if e.fnsku.hasPrefix("X00") && card.fnsku == e.fnsku && c.fnsku.isEmpty { saved += "・管理番号を登録" }
            if let n = card.noted, !n.isEmpty { saved += "（\(n)）" }
            if let photo = e.photo {
                let key = "sent-\(c.id)-\(Self.day.string(from: photo.takenAt))"
                if e.fromLibrary || !UserDefaults.standard.bool(forKey: key) {
                    try await Api.uploadPhoto(id: c.id, photo: photo, clientId: "scan:\(photo.digest)")
                    UserDefaults.standard.set(true, forKey: key)
                    saved += "・写真 \(Self.day.string(from: photo.takenAt))"
                }
            }
            let finalSaved = saved
            update(id) { $0.state = .picked(card); $0.saved = finalSaved }
        } catch {
            update(id) { $0.saved = "記録できませんでした: \(error.localizedDescription)" }
        }
    }

    static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    // MARK: library

    /// Photos from the library, read and spoken in the order they were taken; each keeps its own shot date.
    func importLibrary(_ items: [PhotosPickerItem]) async {
        busyLibrary = items.count
        var loaded: [(Data, Date)] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                loaded.append((data, PhotoTools.shotTime(data) ?? Date()))
            }
        }
        for (data, when) in loaded.sorted(by: { $0.1 < $1.1 }) {
            let (codes, lines) = await Task.detached { PhotoTools.read(data, barcodes: true) }.value
            var e = Entry(code: codes.first ?? "写真", fromLibrary: true, at: when)
            e.photo = await Task.detached { PhotoTools.prepare(data, fallbackTime: when) }.value
            entries.insert(e, at: 0)
            do {
                let r = try await Api.scan(codes: codes, lines: lines)
                update(e.id) { $0.fnsku = r.fnsku }
                settle(e.id, r)
            } catch {
                update(e.id) { $0.state = .failed(error.localizedDescription) }
            }
            busyLibrary -= 1
        }
        busyLibrary = 0
    }

    private func update(_ id: UUID, _ f: (inout Entry) -> Void) {
        if let i = entries.firstIndex(where: { $0.id == id }) { f(&entries[i]) }
    }
}
