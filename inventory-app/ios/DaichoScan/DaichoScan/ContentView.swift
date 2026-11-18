import SwiftUI
import PhotosUI

@main
struct DaichoScanApp: App {
    @StateObject private var model = ScanModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
                .onChange(of: phase) { _, p in model.scanner.setRunning(p == .active) }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: ScanModel
    @State private var picks: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottom) {
                CameraPreview(session: model.scanner.session)
                    .frame(height: 260)
                    .clipped()
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.7), lineWidth: 2).frame(width: 260, height: 110))
                if !model.scanner.problem.isEmpty {
                    Text(model.scanner.problem).padding(8).background(.red.opacity(0.85)).foregroundStyle(.white)
                } else {
                    Text("ラベルのバーコードを枠に入れてください").font(.caption).padding(6).background(.black.opacity(0.5)).foregroundStyle(.white).padding(6)
                }
            }
            HStack {
                PhotosPicker(selection: $picks, maxSelectionCount: 50, matching: .images, photoLibrary: .shared()) {
                    Label(model.busyLibrary > 0 ? "読み込み中 \(model.busyLibrary)" : "ライブラリから", systemImage: "photo.on.rectangle")
                }
                .onChange(of: picks) { _, items in
                    guard !items.isEmpty else { return }
                    Task { await model.importLibrary(items); picks = [] }
                }
                Spacer()
                Button { model.muted.toggle() } label: {
                    Image(systemName: model.muted ? "speaker.slash" : "speaker.wave.2")
                }
                Button("消す") { model.entries.removeAll() }.disabled(model.entries.isEmpty)
            }
            .padding(.horizontal).padding(.vertical, 8)
            List {
                ForEach(model.entries) { e in EntryRow(entry: e) }
            }
            .listStyle(.plain)
        }
        .onAppear { model.scanner.start() }
    }
}

struct EntryRow: View {
    @EnvironmentObject var model: ScanModel
    let entry: Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(entry.fromLibrary ? "🖼 \(ScanModel.day.string(from: entry.at)) 撮影" : "📷 \(entry.at.formatted(date: .omitted, time: .shortened))")
                Text(entry.fnsku.isEmpty ? entry.code : entry.fnsku).font(.caption.monospaced())
                Spacer()
                Button { model.dismiss(entry.id) } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
            }
            .font(.caption).foregroundStyle(.secondary)
            switch entry.state {
            case .looking:
                ProgressView("台帳を探しています…")
            case .picked(let c):
                CardView(card: c, big: true).onTapGesture { model.speak(c.say) }
                if !entry.saved.isEmpty { Text(entry.saved).font(.caption).foregroundStyle(.green) }
            case .choose(let cs):
                Text("どれですか？（Amazon の画像で見比べて選ぶ）").font(.subheadline.bold())
                ScrollView(.horizontal) {
                    HStack(alignment: .top) {
                        ForEach(cs) { c in
                            Button { model.choose(entry.id, c) } label: { CardView(card: c, big: false).frame(width: 150) }
                                .buttonStyle(.bordered)
                        }
                    }
                }
            case .none(let s):
                Text(s).foregroundStyle(.orange)
            case .failed(let s):
                Text(s).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

struct CardView: View {
    let card: Card
    let big: Bool

    var arrival: String {
        let p = card.arrivalDate.split(separator: "-")
        return p.count == 3 ? "\(Int(p[1]) ?? 0)月\(Int(p[2]) ?? 0)日到着" : "到着日なし"
    }

    var body: some View {
        let layout = big ? AnyLayout(HStackLayout(alignment: .top)) : AnyLayout(VStackLayout(alignment: .leading))
        layout {
            Thumb(path: card.official ?? card.thumb).frame(width: big ? 84 : 130, height: big ? 84 : 110)
            VStack(alignment: .leading, spacing: 3) {
                Text(arrival).font(big ? .title2.bold() : .headline)
                Text(card.name).font(big ? .body : .caption).lineLimit(big ? 3 : 4)
                Text(card.hasOwnPhoto ? "📷 撮影あり" : "撮影なし").font(.caption2.bold())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(card.hasOwnPhoto ? Color.green.opacity(0.2) : Color.gray.opacity(0.2), in: Capsule())
                Group {
                    if !card.arrivalId.isEmpty { Text("到着ID \(card.arrivalId)") }
                    if !card.dateId.isEmpty { Text("日付ID \(card.dateId)") }
                    if !card.productCode.isEmpty { Text("商品ID \(card.productCode)") }
                    if !card.shotDate.isEmpty { Text("撮影日 \(card.shotDate)") }
                }
                .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
    }
}

/// Ledger images need the token, so they are fetched by hand rather than with AsyncImage.
struct Thumb: View {
    let path: String?
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            Color.gray.opacity(0.15)
            if let image { Image(uiImage: image).resizable().scaledToFit() } else { Image(systemName: "shippingbox").foregroundStyle(.secondary) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: path) {
            guard let path, let d = await Api.image(path) else { return }
            image = UIImage(data: d)
        }
    }
}
