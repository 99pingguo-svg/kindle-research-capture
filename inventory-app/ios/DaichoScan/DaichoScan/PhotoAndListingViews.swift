import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ManualPhotoTarget: Identifiable {
    let id = UUID()
    let productId: String // Empty string if unresolved session
    let sessionId: UUID?
    let productName: String
    let thumbPath: String?
}

struct PhotoSelectionTarget: Identifiable {
    let id = UUID()
    let productId: String
    let productName: String
}

struct ListingEditTarget: Identifiable {
    let id = UUID()
    let productId: String
    let productName: String
}

/// Unified 68pt touch shutter button (Part 3 & Part 5): fixed in bottom thumb zone above home indicator.
struct TouchShutterButton: View {
    let state: ShutterState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .stroke(.white, lineWidth: 4)
                    .frame(width: 68, height: 68)
                Circle()
                    .fill(state == .idle ? .white : .gray.opacity(0.6))
                    .frame(width: 56, height: 56)
                if state != .idle {
                    ProgressView().tint(.black)
                }
            }
            .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
        .disabled(state != .idle)
        .accessibilityLabel("シャッター")
    }
}

/// Visual flash feedback on shutter press (works even in silent mode).
struct ShutterFlashOverlay: View {
    let trigger: Int
    @State private var visible = false

    var body: some View {
        Color.white
            .opacity(visible ? 0.72 : 0)
            .allowsHitTesting(false)
            .onChange(of: trigger) { _, _ in
                visible = true
                withAnimation(.easeOut(duration: 0.22)) {
                    visible = false
                }
            }
    }
}

/// Part 5: Continuous real-photo capture screen reusing the existing AVCaptureSession without tearing it down.
struct ManualCaptureSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    let target: ManualPhotoTarget

    @State private var batchId = UUID()
    @State private var capturedThumbs: [(id: UUID, image: UIImage)] = []
    @State private var errorMsg = ""

    var body: some View {
        ZStack {
            CameraPreview(scanner: model.scanner, guideSize: nil)
                .ignoresSafeArea()

            ShutterFlashOverlay(trigger: model.scanner.flashTrigger)
                .ignoresSafeArea()

            if let pt = model.scanner.focusIndicatorPoint {
                RoundedRectangle(cornerRadius: 4)
                    .stroke(.yellow, lineWidth: 2)
                    .frame(width: 64, height: 64)
                    .position(pt)
                    .allowsHitTesting(false)
            }

            VStack(spacing: 0) {
                // Fixed top banner clearly distinguishing "出品用・実物撮影" from barcode scanning.
                HStack(spacing: 10) {
                    Thumb(path: target.thumbPath).frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("出品用・実物撮影")
                            .font(.caption.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.green, in: Capsule())
                            .foregroundStyle(.white)
                        Text(target.productId.isEmpty ? "未確定商品（確定後に紐付け）" : "#\(target.productId) \(target.productName)")
                            .font(.caption.bold())
                            .foregroundStyle(.white)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button("完了") {
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.black.opacity(0.75))

                if !errorMsg.isEmpty {
                    Text(errorMsg)
                        .font(.caption.bold())
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(Color.red.opacity(0.85))
                        .foregroundStyle(.white)
                }

                Spacer()

                // Filmstrip of newly captured photos (no confirmation dialog between shots).
                if !capturedThumbs.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(capturedThumbs, id: \.id) { item in
                                Image(uiImage: item.image)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white, lineWidth: 1))
                            }
                        }
                        .padding(.horizontal, 14)
                    }
                    .padding(.vertical, 8)
                    .background(.black.opacity(0.55))
                }

                // Bottom thumb-zone fixed 68pt shutter (no library button here to avoid accidental taps).
                HStack {
                    Text("撮影済み \(capturedThumbs.count)枚")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .frame(width: 90, alignment: .leading)
                    Spacer()
                    TouchShutterButton(state: model.scanner.shutterState) {
                        Task { await shootOne() }
                    }
                    Spacer()
                    Color.clear.frame(width: 90, height: 1)
                }
                .padding(.horizontal, 18)
                .padding(.top, 10)
                .padding(.bottom, 18)
                .background(.black.opacity(0.65))
            }
        }
        .onAppear {
            model.addPauseReason(.manualCapture)
            model.scanner.setRunning(true)
        }
        .onDisappear {
            model.removePauseReason(.manualCapture)
            if !capturedThumbs.isEmpty {
                model.showNoticeBanner("\(capturedThumbs.count)枚撮影しました（未選別）", productId: target.productId.isEmpty ? nil : target.productId, productName: target.productName)
            }
        }
    }

    private func shootOne() async {
        errorMsg = ""
        await model.scanner.triggerManualShutter { rawData in
            let processed = await Task.detached(priority: .userInitiated) {
                PhotoTools.processManualPhoto(data: rawData)
            }.value
            guard let processed else {
                await MainActor.run { errorMsg = "画像の変換に失敗しました" }
                return
            }
            await MainActor.run {
                do {
                    let rec = try model.saveManualPhoto(
                        productId: target.productId,
                        sessionId: target.sessionId,
                        batchId: batchId,
                        source: "manual_camera",
                        processed: processed
                    )
                    if let ui = UIImage(data: processed.thumb) {
                        capturedThumbs.insert((id: rec.clientPhotoId, image: ui), at: 0)
                    }
                } catch {
                    errorMsg = error.localizedDescription
                }
            }
        }
    }
}

/// Part 5: PHPickerViewController wrapper (max 10 images, copies temp files inside completion handler, 1-by-1 conversion).
struct ManualLibraryPicker: UIViewControllerRepresentable {
    let onPicked: ([URL], Int) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked, onCancel: onCancel) }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 10
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPicked: ([URL], Int) -> Void
        let onCancel: () -> Void

        init(onPicked: @escaping ([URL], Int) -> Void, onCancel: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onCancel = onCancel
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !results.isEmpty else {
                onCancel()
                return
            }
            // Copy each temp file inside loadFileRepresentation's completion handler BEFORE the OS cleans it up.
            let workDir = FileManager.default.temporaryDirectory.appendingPathComponent("daicho-pick-\(UUID().uuidString)", isDirectory: true)
            try? FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)

            let group = DispatchGroup()
            let lock = NSLock()
            var copiedURLs: [URL] = []
            var failCount = 0

            for (idx, result) in results.enumerated() {
                let provider = result.itemProvider
                guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else {
                    lock.lock(); failCount += 1; lock.unlock()
                    continue
                }
                group.enter()
                provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { tempURL, _ in
                    defer { group.leave() }
                    guard let tempURL else {
                        lock.lock(); failCount += 1; lock.unlock()
                        return
                    }
                    let ext = tempURL.pathExtension.isEmpty ? "img" : tempURL.pathExtension
                    let dst = workDir.appendingPathComponent("\(idx)-\(UUID().uuidString).\(ext)")
                    do {
                        try FileManager.default.copyItem(at: tempURL, to: dst)
                        lock.lock(); copiedURLs.append(dst); lock.unlock()
                    } catch {
                        lock.lock(); failCount += 1; lock.unlock()
                    }
                }
            }

            group.notify(queue: .main) {
                self.onPicked(copiedURLs, failCount)
            }
        }
    }
}

/// Part 5: 3-axis photo selection UI (sync state / server adoption / device-only reviewed state).
struct PhotoSelectionSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    struct GridPhotoItem: Identifiable {
        let id: String
        let serverPhotoId: String?
        let localPhoto: LocalPhoto?
        let remoteThumbPath: String?
        let remoteWorkPath: String?
        let isAdopted: Bool
        let isReviewed: Bool
        let uploadState: String // "synced" | "pending" | "uploading" | "needsAttention" | "failed"
        let sourceLabel: String
        let errorText: String
    }

    let target: PhotoSelectionTarget

    @State private var detail: ProductDetail?
    @State private var loading = false
    @State private var errorMsg = ""
    @State private var zoomedItem: GridPhotoItem?
    @State private var refreshTick = 0

    private var gridItems: [GridPhotoItem] {
        _ = refreshTick
        var items: [GridPhotoItem] = []
        let adoptedSet = Set(detail?.listingPhotoIds ?? [])
        let locals = model.localStore.manualPhotos(forProductId: target.productId)
        let localByServerId = Dictionary(uniqueKeysWithValues: locals.compactMap { lp -> (String, LocalPhoto)? in
            guard let sid = lp.serverPhotoId else { return nil }
            return (sid, lp)
        })

        // 1. Unsynced / local-only manual photos first
        for lp in locals where lp.serverPhotoId == nil || !(detail?.photos ?? []).contains(where: { $0.id == lp.serverPhotoId }) {
            items.append(GridPhotoItem(
                id: "local-\(lp.clientPhotoId.uuidString)",
                serverPhotoId: lp.serverPhotoId,
                localPhoto: lp,
                remoteThumbPath: nil,
                remoteWorkPath: nil,
                isAdopted: lp.isAdopted,
                isReviewed: lp.reviewed,
                uploadState: lp.uploadState,
                sourceLabel: lp.source == "manual_library" ? "ライブラリ" : "実物撮影",
                errorText: lp.lastError
            ))
        }

        // 2. Eligible server actual photos (positive allowlist ONLY; excludes reference & source='scan')
        for sp in (detail?.photos ?? []) where sp.isListableActual {
            let lp = localByServerId[sp.id]
            items.append(GridPhotoItem(
                id: "server-\(sp.id)",
                serverPhotoId: sp.id,
                localPhoto: lp,
                remoteThumbPath: sp.thumbPath(productId: target.productId),
                remoteWorkPath: sp.workPath(productId: target.productId),
                isAdopted: lp?.pendingAdoptionSync == true ? (lp?.isAdopted ?? false) : adoptedSet.contains(sp.id),
                isReviewed: lp?.reviewed ?? true,
                uploadState: lp?.pendingAdoptionSync == true ? "pending" : "synced",
                sourceLabel: sp.source ?? "camera",
                errorText: ""
            ))
        }
        return items
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if loading {
                        ProgressView("写真一覧を読み込み中…").frame(maxWidth: .infinity)
                    }
                    if !errorMsg.isEmpty {
                        Text(errorMsg).font(.caption).foregroundStyle(.red).padding(.horizontal)
                    }
                    Text("出品用の実物写真のみ表示しています（参考画像・ラベル場面写真は対象外）。タップで拡大し「採用／不採用」を切り替えられます。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)

                    if gridItems.isEmpty && !loading {
                        ContentUnavailableView("出品用の実物写真がまだありません", systemImage: "photo.on.rectangle")
                            .padding(.top, 30)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10)], spacing: 10) {
                            ForEach(gridItems) { item in
                                Button {
                                    zoomedItem = item
                                } label: {
                                    ZStack(alignment: .topLeading) {
                                        photoThumbnail(item)
                                            .frame(height: 110)
                                            .frame(maxWidth: .infinity)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 8)
                                                    .stroke(item.isAdopted ? Color.green : (!item.isReviewed ? Color.orange : Color.clear), lineWidth: 2.5)
                                            )

                                        VStack(alignment: .leading, spacing: 3) {
                                            if item.isAdopted {
                                                badgePill("採用", color: .green)
                                            }
                                            if item.uploadState != "synced" {
                                                badgePill(item.uploadState == "needsAttention" ? "要対応" : "同期待ち", color: item.uploadState == "needsAttention" ? .red : .blue)
                                            }
                                            if !item.isReviewed {
                                                badgePill("未選別", color: .orange)
                                            }
                                        }
                                        .padding(4)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle("実物写真の選別")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
            .onAppear { model.addPauseReason(.photoSelectionSheet) }
            .onDisappear { model.removePauseReason(.photoSelectionSheet) }
            .task { await loadServerPhotos() }
            .sheet(item: $zoomedItem) { item in
                NavigationStack {
                    VStack(spacing: 14) {
                        photoFullImage(item)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color.black.opacity(0.92))

                        VStack(spacing: 8) {
                            HStack(spacing: 8) {
                                Text("状態: \(item.isAdopted ? "出品に採用中" : "不採用（出品しない）")")
                                    .font(.subheadline.bold())
                                    .foregroundStyle(item.isAdopted ? Color.green : Color.secondary)
                                Spacer()
                                Text(item.uploadState == "synced" ? "同期済み" : (item.uploadState == "needsAttention" ? "要対応" : "同期待ち"))
                                    .font(.caption)
                                    .foregroundStyle(item.uploadState == "synced" ? Color.secondary : Color.blue)
                            }
                            if !item.errorText.isEmpty {
                                Text(item.errorText).font(.caption).foregroundStyle(.red)
                            }
                            HStack(spacing: 10) {
                                Button {
                                    toggleAdoption(item: item, adopt: true)
                                    zoomedItem = nil
                                } label: {
                                    Label("採用（出品に使う）", systemImage: "checkmark.circle.fill")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.green)

                                Button {
                                    toggleAdoption(item: item, adopt: false)
                                    zoomedItem = nil
                                } label: {
                                    Label("不採用", systemImage: "xmark.circle")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                        .padding()
                    }
                    .navigationTitle("写真を確認")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("閉じる") { zoomedItem = nil }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func photoThumbnail(_ item: GridPhotoItem) -> some View {
        if let lp = item.localPhoto, let data = try? Data(contentsOf: model.localStore.manualPhotoThumbURL(lp)), let ui = UIImage(data: data) {
            Image(uiImage: ui).resizable().scaledToFill()
        } else if let path = item.remoteThumbPath {
            Thumb(path: path)
        } else {
            Color.gray.opacity(0.2)
        }
    }

    @ViewBuilder
    private func photoFullImage(_ item: GridPhotoItem) -> some View {
        if let lp = item.localPhoto,
           let data = (try? Data(contentsOf: model.localStore.manualPhotoOriginalURL(lp))) ?? (try? Data(contentsOf: model.localStore.manualPhotoThumbURL(lp))),
           let ui = UIImage(data: data) {
            Image(uiImage: ui).resizable().scaledToFit()
        } else if let path = item.remoteWorkPath {
            Thumb(path: path)
        } else {
            Image(systemName: "photo").foregroundStyle(.white)
        }
    }

    private func badgePill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.bold())
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(color.opacity(0.9), in: Capsule())
            .foregroundStyle(.white)
    }

    private func loadServerPhotos() async {
        loading = true
        defer { loading = false }
        do {
            detail = try await Api.fetchProductDetail(id: target.productId)
            errorMsg = ""
        } catch {
            errorMsg = "サーバー写真の取得に失敗しました（端末内の写真は表示中）"
        }
    }

    private func toggleAdoption(item: GridPhotoItem, adopt: Bool) {
        model.setManualPhotoAdopted(
            productId: target.productId,
            localPhoto: item.localPhoto,
            serverPhotoId: item.serverPhotoId,
            adopted: adopt
        )
        refreshTick += 1
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            await loadServerPhotos()
        }
    }
}

/// Part 6 (T-011): Listing title & description editor bottom sheet (medium/large detents, UTF-16 counters, expectedRev conflict handling).
struct ListingEditSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    let target: ListingEditTarget

    @State private var titleText = ""
    @State private var descText = ""
    @State private var hasJmtyOverride = false
    @State private var titleStatus = "同期済み"
    @State private var descStatus = "同期済み"
    @State private var conflictRev: Int?
    @State private var conflictTitle: String?
    @State private var conflictDesc: String?
    @State private var loadingServer = false
    @State private var debounceTask: Task<Void, Never>?
    @State private var didCommit = false

    private let titleLimit = 40
    private let descLimit = 1000

    private var titleCount: Int { titleText.utf16.count }
    private var descCount: Int { descText.utf16.count }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let cRev = conflictRev {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Web側で文章が更新されています（最新 rev \(cRev)）", systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline.bold())
                                .foregroundStyle(.orange)
                            if let ct = conflictTitle {
                                Text("Web側タイトル: \(ct)").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            HStack(spacing: 8) {
                                Button("自分の下書きで上書き") {
                                    model.resolveListingConflictOverwrite(productId: target.productId, newBaseRev: cRev, title: titleText, desc: descText)
                                    conflictRev = nil
                                    refreshDraftUI()
                                }
                                .buttonStyle(.borderedProminent)
                                .font(.caption)

                                Button("サーバーの最新を採用") {
                                    model.resolveListingConflictUseServer(productId: target.productId)
                                    conflictRev = nil
                                    refreshDraftUI()
                                }
                                .buttonStyle(.bordered)
                                .font(.caption)
                            }
                        }
                        .padding(10)
                        .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
                    }

                    if hasJmtyOverride {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "info.circle.fill").foregroundStyle(.blue)
                            Text("ジモティー用の個別文章が設定されています（ここでの編集はメルカリ等の共通文に反映されます。ジモティー用はWeb台帳で編集）")
                                .font(.caption)
                        }
                        .padding(10)
                        .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                    }

                    // Title field
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("タイトル").font(.subheadline.bold())
                            statusPill(titleStatus)
                            Spacer()
                            Text("\(titleCount) / \(titleLimit)")
                                .font(.caption.monospaced().bold())
                                .foregroundStyle(titleCount > titleLimit ? .red : .secondary)
                        }
                        TextEditor(text: $titleText)
                            .frame(minHeight: 72)
                            .padding(6)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(titleCount > titleLimit ? Color.red : Color.gray.opacity(0.25)))
                            .onChange(of: titleText) { _, _ in scheduleDraftSave() }
                        if titleCount > titleLimit {
                            Text("40文字を超過しています（端末に下書き保持し、送信は保留されます）")
                                .font(.caption2).foregroundStyle(.red)
                        }
                    }

                    // Description field
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("説明文").font(.subheadline.bold())
                            statusPill(descStatus)
                            Spacer()
                            Text("\(descCount) / \(descLimit)")
                                .font(.caption.monospaced().bold())
                                .foregroundStyle(descCount > descLimit ? .red : .secondary)
                        }
                        TextEditor(text: $descText)
                            .frame(minHeight: 220)
                            .padding(6)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(descCount > descLimit ? Color.red : Color.gray.opacity(0.25)))
                            .onChange(of: descText) { _, _ in scheduleDraftSave() }
                        if descCount > descLimit {
                            Text("1000文字を超過しています（端末に下書き保持し、送信は保留されます）")
                                .font(.caption2).foregroundStyle(.red)
                        }
                    }

                    if loadingServer {
                        HStack(spacing: 6) {
                            ProgressView().scaleEffect(0.8)
                            Text("最新の出品文を取得中…").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("出品文を編集 #\(target.productId)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") {
                        commitAndDismiss()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存して閉じる") {
                        commitAndDismiss()
                    }
                    .bold()
                }
            }
            .onAppear {
                model.addPauseReason(.listingEditSheet)
                refreshDraftUI()
                Task { await fetchLatestFromServer() }
            }
            .onDisappear {
                debounceTask?.cancel()
                if !didCommit {
                    model.updateListingDraftLocal(productId: target.productId, title: titleText, description: descText)
                    model.enqueueListingDraftSync(productId: target.productId)
                }
                model.removePauseReason(.listingEditSheet)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func statusPill(_ s: String) -> some View {
        let color: Color = {
            switch s {
            case "超過（未送信）": return .red
            case "競合（要確認）": return .orange
            case "同期中": return .blue
            case "下書き": return .indigo
            default: return .green
            }
        }()
        return Text(s)
            .font(.caption2.bold())
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private func labelForState(_ raw: String, count: Int, limit: Int) -> String {
        if count > limit { return "超過（未送信）" }
        switch raw {
        case "conflict": return "競合（要確認）"
        case "syncing": return "同期中"
        case "draft": return "下書き"
        case "overflow": return "超過（未送信）"
        default: return "同期済み"
        }
    }

    private func refreshDraftUI() {
        if let d = model.localStore.fetchListingDraft(productId: target.productId) {
            titleText = d.titleLocalValue
            descText = d.descLocalValue
            hasJmtyOverride = d.hasJmtyOverride
            conflictRev = d.serverConflictRev
            conflictTitle = d.serverConflictTitle
            conflictDesc = d.serverConflictDesc
            titleStatus = labelForState(d.titleSyncState, count: d.titleLocalValue.utf16.count, limit: titleLimit)
            descStatus = labelForState(d.descSyncState, count: d.descLocalValue.utf16.count, limit: descLimit)
        }
    }

    private func fetchLatestFromServer() async {
        loadingServer = true
        defer { loadingServer = false }
        if let updated = await model.refreshListingDraftFromServer(productId: target.productId) {
            hasJmtyOverride = updated.hasJmtyOverride
            if !updated.titleDirty { titleText = updated.titleLocalValue }
            if !updated.descDirty { descText = updated.descLocalValue }
            conflictRev = updated.serverConflictRev
            conflictTitle = updated.serverConflictTitle
            conflictDesc = updated.serverConflictDesc
            titleStatus = labelForState(updated.titleSyncState, count: titleText.utf16.count, limit: titleLimit)
            descStatus = labelForState(updated.descSyncState, count: descText.utf16.count, limit: descLimit)
        }
    }

    private func scheduleDraftSave() {
        debounceTask?.cancel()
        debounceTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            model.updateListingDraftLocal(productId: target.productId, title: titleText, description: descText)
            refreshDraftUI()
        }
    }

    private func commitAndDismiss() {
        didCommit = true
        debounceTask?.cancel()
        model.updateListingDraftLocal(productId: target.productId, title: titleText, description: descText)
        model.enqueueListingDraftSync(productId: target.productId)
        dismiss()
    }
}
