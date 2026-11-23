import SwiftUI
import PhotosUI

@main
struct DaichoScanApp: App {
    @StateObject private var model = ScanModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
                .onChange(of: phase) { _, p in
                    model.scanner.setRunning(p == .active)
                    if p == .active {
                        Task {
                            await model.flushSyncQueue()
                            await model.flushManualPhotoUploads()
                            await model.refreshCatalog()
                        }
                    }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var model: ScanModel
    @State private var picks: [PhotosPickerItem] = []
    @State private var confirmDiscardAll = false

    private let guideSize = CGSize(width: 260, height: 104)

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                // Top navigation/control bar: [連続 | 1件ずつ] + SyncStatus + Pause + Mute + 検索
                HStack(spacing: 8) {
                    Picker("モード", selection: $model.scanMode) {
                        ForEach(ScanMode.allCases, id: \.self) { m in
                            Text(m.label).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 132)

                    Spacer(minLength: 4)

                    SyncStatusBadge()

                    Button {
                        model.toggleManualPause()
                    } label: {
                        Image(systemName: model.isManuallyPaused ? "play.circle.fill" : "pause.circle")
                            .foregroundStyle(model.isManuallyPaused ? .orange : .primary)
                    }
                    .accessibilityLabel(model.isManuallyPaused ? "自動読取を再開" : "自動読取を一時停止")

                    Button {
                        model.muted.toggle()
                        if model.muted { model.stopSpeakingImmediately() }
                    } label: {
                        Image(systemName: model.muted ? "speaker.slash" : "speaker.wave.2")
                    }

                    Button {
                        model.openSearch(purpose: .openDetail)
                    } label: {
                        Label("検索", systemImage: "magnifyingglass")
                            .font(.caption.bold())
                    }
                    .buttonStyle(.bordered)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                // Live camera preview with tap-to-focus, guide rectOfInterest, and visual flash overlay
                ZStack {
                    CameraPreview(scanner: model.scanner, guideSize: guideSize)
                        .frame(height: 210)
                        .clipped()

                    ShutterFlashOverlay(trigger: model.scanner.flashTrigger)
                        .frame(height: 210)

                    RoundedRectangle(cornerRadius: 8)
                        .stroke(model.isEditingFlowActive || model.isManuallyPaused || model.isStoppedBySingleMode ? Color.yellow.opacity(0.65) : Color.white.opacity(0.85), lineWidth: 2)
                        .frame(width: guideSize.width, height: guideSize.height)
                        .allowsHitTesting(false)

                    if let pt = model.scanner.focusIndicatorPoint {
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(.yellow, lineWidth: 2)
                            .frame(width: 54, height: 54)
                            .position(pt)
                            .allowsHitTesting(false)
                    }

                    VStack {
                        HStack {
                            Text(model.autoScanStatusLabel)
                                .font(.caption2.bold())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(.black.opacity(0.6), in: Capsule())
                                .foregroundStyle(.white)
                            Spacer()
                        }
                        .padding(8)

                        Spacer()

                        if !model.scanner.problem.isEmpty {
                            Text(model.scanner.problem)
                                .font(.caption)
                                .padding(6)
                                .background(.red.opacity(0.85))
                                .foregroundStyle(.white)
                        } else {
                            Text("ラベルのバーコードを枠に入れてください（タップでピント）")
                                .font(.caption2)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(.black.opacity(0.55), in: Capsule())
                                .foregroundStyle(.white)
                                .padding(.bottom, 6)
                        }
                    }
                    .frame(height: 210)
                    .allowsHitTesting(false)
                }

                // Part 2 escape button: visible ONLY when stopped by single-mode or manual pause
                if model.showNextOneShotButton {
                    Button {
                        model.armOneShotNextScan()
                    } label: {
                        Label("次の1件を読む", systemImage: "barcode.viewfinder")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
                }

                // Subtle listing conflict alert strip (Part 6)
                if model.hasListingConflicts {
                    Button {
                        model.showAttentionSheet = true
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text("出品文の同期を保留しました（要確認）")
                                .font(.caption.bold())
                            Spacer()
                            Text("確認").font(.caption2.bold()).foregroundStyle(.orange)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.orange.opacity(0.14))
                    }
                    .buttonStyle(.plain)
                }

                // Utility row
                HStack(spacing: 10) {
                    PhotosPicker(selection: $picks, maxSelectionCount: 50, matching: .images, photoLibrary: .shared()) {
                        Label(model.busyLibrary > 0 ? "読み込み中 \(model.busyLibrary)" : "ラベル写真から", systemImage: "photo.on.rectangle")
                            .font(.caption)
                    }
                    .onChange(of: picks) { _, items in
                        guard !items.isEmpty else { return }
                        Task { await model.importLibrary(items); picks = [] }
                    }

                    Spacer()

                    Button {
                        model.openSearch(purpose: .addPhoto)
                    } label: {
                        Label("実物写真を追加", systemImage: "camera.badge.ellipsis")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)

                    if !model.todayEntries.isEmpty {
                        Button("破棄") {
                            confirmDiscardAll = true
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                // Queue & History list
                List {
                    if !model.todayEntries.isEmpty {
                        Section("確認待ち（\(model.todayEntries.count)件）") {
                            ForEach(model.todayEntries) { e in EntryRow(entry: e) }
                        }
                    }
                    if !model.olderEntries.isEmpty {
                        Section("古い確認待ち（\(model.olderEntries.count)件）") {
                            ForEach(model.olderEntries) { e in EntryRow(entry: e) }
                        }
                    }
                    if !model.history.isEmpty {
                        Section("確認済み履歴") {
                            ForEach(model.history) { item in
                                HistoryRow(item: item)
                            }
                        }
                    }
                    // Bottom clearance for fixed 68pt shutter button
                    Color.clear
                        .frame(height: 92)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .refreshable {
                    await model.flushSyncQueue()
                    await model.flushManualPhotoUploads()
                    await model.refreshCatalog()
                }
            }

            // Floating toasts & fixed 68pt bottom touch shutter (Part 3)
            VStack(spacing: 8) {
                if let banner = model.noticeBanner {
                    Button {
                        if let pid = banner.productId {
                            if banner.message.contains("出品文") {
                                model.openListingEditor(productId: pid, productName: banner.productName)
                            } else {
                                model.openPhotoSelection(productId: pid, productName: banner.productName)
                            }
                        }
                        model.noticeBanner = nil
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            Text(banner.message)
                                .font(.caption.bold())
                                .foregroundStyle(.white)
                            Spacer()
                            if banner.productId != nil {
                                Text("開く")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(.white.opacity(0.22), in: Capsule())
                                    .foregroundStyle(.white)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.black.opacity(0.84), in: RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal, 16)
                    }
                    .buttonStyle(.plain)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                if let toast = model.undoToast {
                    HStack(spacing: 12) {
                        Text("売らないに設定しました")
                            .font(.subheadline.bold())
                            .foregroundStyle(.white)
                        Spacer()
                        Button("元に戻す") {
                            model.undoNoSellToast()
                        }
                        .font(.subheadline.bold())
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.white, in: Capsule())
                        .foregroundStyle(.black)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.88), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }

                // Fixed 68pt shutter button in bottom thumb zone (identical position to ManualCaptureSheet)
                TouchShutterButton(state: model.scanner.shutterState) {
                    Task { await model.triggerScanShutter() }
                }
                .padding(.bottom, 12)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.undoToast?.id)
        .animation(.easeInOut(duration: 0.2), value: model.noticeBanner?.id)
        .onAppear {
            model.scanner.start()
            Task {
                await model.flushSyncQueue()
                await model.flushManualPhotoUploads()
                await model.refreshCatalog()
            }
        }
        .alert("確認待ちをすべて破棄しますか？", isPresented: $confirmDiscardAll) {
            Button("破棄する", role: .destructive) {
                model.discardAllTodayEntries()
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("今日の未確定スキャンと下書き・未送信の仮写真が端末から削除されます（同期済みデータは消えません）。")
        }
        .confirmationDialog(
            "実物写真を追加",
            isPresented: Binding(
                get: { model.manualPhotoChoiceTarget != nil },
                set: { if !$0 { model.manualPhotoChoiceTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let target = model.manualPhotoChoiceTarget {
                Button("カメラで撮る") {
                    model.manualPhotoChoiceTarget = nil
                    model.openManualCapture(target)
                }
                Button("ライブラリから選ぶ") {
                    model.manualPhotoChoiceTarget = nil
                    model.openManualLibraryPicker(target)
                }
            }
            Button("キャンセル", role: .cancel) {
                model.manualPhotoChoiceTarget = nil
            }
        }
        .sheet(item: $model.detailTarget, onDismiss: { model.runPendingTransition() }) { t in
            ProductDetailSheet(card: t.card, localPhoto: t.localPhoto, sessionId: t.sessionId)
                .environmentObject(model)
        }
        .sheet(item: $model.registerTarget, onDismiss: { model.runPendingTransition() }) { t in
            RegisterSheet(entryId: t.id, draft: t.draft)
                .environmentObject(model)
        }
        .sheet(item: $model.memoTarget, onDismiss: { model.runPendingTransition() }) { t in
            MemoEditorSheet(target: t)
                .environmentObject(model)
        }
        .sheet(item: $model.fnskuBranchTarget, onDismiss: { model.runPendingTransition() }) { t in
            FnskuBranchSheet(target: t)
                .environmentObject(model)
        }
        .sheet(item: $model.searchTarget, onDismiss: { model.runPendingTransition() }) { t in
            ProductSearchSheet(target: t)
                .environmentObject(model)
        }
        .fullScreenCover(item: $model.manualCaptureTarget, onDismiss: { model.runPendingTransition() }) { t in
            ManualCaptureSheet(target: t)
                .environmentObject(model)
        }
        .sheet(item: $model.manualPickerTarget, onDismiss: {
            model.removePauseReason(.manualLibraryPicker)
            model.runPendingTransition()
        }) { t in
            ManualLibraryPicker(
                onPicked: { urls, failCount in
                    model.manualPickerTarget = nil
                    Task { await model.importManualLibraryFiles(target: t, urls: urls, initialFailCount: failCount) }
                },
                onCancel: {
                    model.manualPickerTarget = nil
                }
            )
            .onAppear { model.addPauseReason(.manualLibraryPicker) }
        }
        .sheet(item: $model.photoSelectionTarget, onDismiss: { model.runPendingTransition() }) { t in
            PhotoSelectionSheet(target: t)
                .environmentObject(model)
        }
        .sheet(item: $model.listingEditTarget, onDismiss: { model.runPendingTransition() }) { t in
            ListingEditSheet(target: t)
                .environmentObject(model)
        }
        .sheet(isPresented: $model.showAttentionSheet) {
            AttentionQueueSheet()
                .environmentObject(model)
        }
    }
}

private struct SyncStatusBadge: View {
    @EnvironmentObject var model: ScanModel

    var body: some View {
        Button {
            if model.attentionCount > 0 || model.hasListingConflicts {
                model.showAttentionSheet = true
            } else {
                Task {
                    await model.flushSyncQueue()
                    await model.flushManualPhotoUploads()
                }
            }
        } label: {
            HStack(spacing: 4) {
                if model.isSyncing || model.isUploadingPhotos {
                    ProgressView().scaleEffect(0.7)
                } else {
                    Image(systemName: iconName)
                        .foregroundStyle(iconColor)
                }
                if model.attentionCount > 0 {
                    Text("要確認 \(model.attentionCount)件")
                        .font(.caption2.bold())
                        .foregroundStyle(.red)
                } else if model.pendingSyncCount > 0 {
                    Text("同期待ち \(model.pendingSyncCount)件")
                        .font(.caption2.bold())
                        .foregroundStyle(model.isOnline ? .orange : .secondary)
                }
            }
            .padding(.horizontal, (model.pendingSyncCount > 0 || model.attentionCount > 0) ? 7 : 4)
            .padding(.vertical, 3)
            .background(badgeBg, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private var badgeBg: Color {
        if model.attentionCount > 0 { return Color.red.opacity(0.14) }
        if model.pendingSyncCount > 0 { return Color.orange.opacity(0.14) }
        return Color.clear
    }

    private var iconName: String {
        if !model.isOnline { return "wifi.slash" }
        if model.attentionCount > 0 || model.hasListingConflicts { return "exclamationmark.icloud" }
        if model.pendingSyncCount > 0 { return "icloud.and.arrow.up" }
        return "checkmark.icloud"
    }

    private var iconColor: Color {
        if !model.isOnline { return .orange }
        if model.attentionCount > 0 { return .red }
        if model.hasListingConflicts { return .orange }
        if model.pendingSyncCount > 0 { return .orange }
        return .secondary
    }
}

/// Sheet for reviewing needsAttention sync operations, failed manual uploads, and conflicted listing drafts.
struct AttentionQueueSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                let conflictedDrafts = model.localStore.catalog.compactMap { item -> (SearchProjection, ListingDraft)? in
                    guard let d = model.localStore.fetchListingDraft(productId: item.productId),
                          d.titleSyncState == "conflict" || d.descSyncState == "conflict" else { return nil }
                    return (item, d)
                }
                if !conflictedDrafts.isEmpty {
                    Section("出品文の競合（要確認）") {
                        ForEach(conflictedDrafts, id: \.0.productId) { item, _ in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("#\(item.productId) \(item.name)").font(.subheadline.bold()).lineLimit(1)
                                    Text("Web側で文章が更新されています").font(.caption).foregroundStyle(.orange)
                                }
                                Spacer()
                                Button("開いて解決") {
                                    dismiss()
                                    model.openListingEditor(productId: item.productId, productName: item.name)
                                }
                                .buttonStyle(.borderedProminent)
                                .font(.caption)
                            }
                        }
                    }
                }

                let attnOps = model.localStore.attentionOperations()
                if !attnOps.isEmpty {
                    Section("同期保留・要確認（自動上書きはしません）") {
                        ForEach(attnOps, id: \.opId) { op in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("#\(op.productId) • \(op.kind)").font(.caption.monospaced().bold())
                                    Spacer()
                                    Text(op.createdAt.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption2).foregroundStyle(.secondary)
                                }
                                Text(op.lastError).font(.caption).foregroundStyle(.red)
                                HStack(spacing: 8) {
                                    Button("再試行") {
                                        op.status = "pending"
                                        model.localStore.save()
                                        model.refreshPersistedViews()
                                        Task { await model.flushSyncQueue() }
                                    }
                                    .buttonStyle(.bordered)
                                    .font(.caption2)

                                    Button("この操作を取り消す", role: .destructive) {
                                        model.deleteAttentionOperation(op)
                                    }
                                    .buttonStyle(.bordered)
                                    .font(.caption2)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }

                let attnPhotos = model.localStore.allLocalPhotos().filter { $0.uploadState == "needsAttention" }
                if !attnPhotos.isEmpty {
                    Section("写真アップロード要対応") {
                        ForEach(attnPhotos, id: \.clientPhotoId) { ph in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("#\(ph.productId) (\(ph.source))").font(.caption.monospaced().bold())
                                Text(ph.lastError).font(.caption).foregroundStyle(.red)
                                Button("再送信") {
                                    ph.uploadState = "pending"
                                    model.localStore.save()
                                    model.refreshPersistedViews()
                                    Task { await model.flushManualPhotoUploads() }
                                }
                                .buttonStyle(.bordered)
                                .font(.caption2)
                            }
                        }
                    }
                }

                if conflictedDrafts.isEmpty && attnOps.isEmpty && attnPhotos.isEmpty {
                    ContentUnavailableView("要確認の項目はありません", systemImage: "checkmark.circle")
                }
            }
            .navigationTitle("要確認・同期保留")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
            .onAppear { model.addPauseReason(.attentionSheet) }
            .onDisappear { model.removePauseReason(.attentionSheet) }
        }
    }
}

struct EntryRow: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.openURL) private var openURL
    let entry: Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(entry.fromLibrary ? "🖼 \(ScanModel.day.string(from: entry.at)) 撮影" : "📷 \(entry.at.formatted(date: .omitted, time: .shortened))")
                if !entry.fnsku.isEmpty {
                    FnskuCodeText(fnsku: entry.fnsku)
                } else {
                    Text(entry.code).font(.caption.monospaced())
                }
                if entry.photo != nil {
                    Text("写真：端末内のみ")
                        .font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.gray.opacity(0.16), in: Capsule())
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    model.allowSameCodeOnce(entry.code)
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("同じコードを再読")

                Button {
                    model.discardEntry(entry.id)
                } label: {
                    Text("破棄").font(.caption2.bold()).foregroundStyle(.red)
                }
                .buttonStyle(.borderless)
            }
            .font(.caption).foregroundStyle(.secondary)

            switch entry.state {
            case .looking:
                ProgressView("台帳を探しています…")
                DraftMemoButton(entry: entry)

            case .registered(let c):
                StatusBanner(title: "登録済みの商品です", systemImage: "checkmark.seal.fill", color: .blue, trailing: "#\(c.id)")
                CardView(card: c, big: true).onTapGesture { model.speak(c.say) }
                DraftPreviewStrip(entry: entry)
                MatchedActions(entry: entry, card: c)

            case .matched(let c, let registeredNew):
                StatusBanner(
                    title: registeredNew ? "新規登録＋FNSKU紐付け" : "照合済み（確認待ち）",
                    systemImage: registeredNew ? "sparkles" : "checkmark.circle.fill",
                    color: .green,
                    trailing: "#\(c.id)"
                )
                CardView(card: c, big: true).onTapGesture { model.speak(c.say) }
                DraftPreviewStrip(entry: entry)
                MatchedActions(entry: entry, card: c)

            case .choose(let cs, let owner):
                if let owner {
                    OwnerWarningBox(owner: owner) {
                        model.switchEntryToOwner(entryId: entry.id, owner: owner)
                    }
                }
                DraftPreviewStrip(entry: entry)
                HStack(spacing: 8) {
                    DraftMemoButton(entry: entry)
                    ManualPhotoAddButton(
                        productId: "",
                        sessionId: entry.id,
                        productName: entry.fnsku.isEmpty ? entry.code : entry.fnsku,
                        thumbPath: nil
                    )
                }
                Text(cs.count > 1 ? "候補が複数あります（タップして選択）" : "近い候補があります（確認して選択）")
                    .font(.subheadline.bold())
                    .foregroundStyle(.orange)
                VStack(spacing: 8) {
                    ForEach(cs) { c in
                        CandidateRow(
                            card: c,
                            scannedFnsku: entry.fnsku,
                            onSelect: { model.choose(entry.id, c) },
                            onDetail: { model.openDetail(c, localPhoto: entry.photo, sessionId: entry.id) },
                            onOpenPage: { if let s = c.sourceUrl, let u = URL(string: s) { openURL(u) } }
                        )
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        model.openSearch(purpose: .matchScan(entryId: entry.id, scannedFnsku: entry.fnsku))
                    } label: {
                        Label("手動で検索する", systemImage: "magnifyingglass")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)

                    Button {
                        model.openRegister(entry)
                    } label: {
                        Label("新規登録する", systemImage: "plus.circle.fill")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.indigo)
                }

            case .unregistered(let draft):
                StatusBanner(title: "未登録の商品です（候補なし）", systemImage: "plus.square.fill", color: .orange, trailing: draft.fnsku)
                HStack(alignment: .top, spacing: 10) {
                    if let photo = entry.photo, let ui = UIImage(data: photo.thumb) {
                        Image(uiImage: ui)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 72, height: 72)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(draft.name.isEmpty ? "ラベルから商品名を取得できませんでした" : draft.name)
                            .font(.subheadline.bold())
                            .lineLimit(3)
                        if !draft.jan.isEmpty {
                            Text("JAN \(draft.jan)").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        if !draft.lines.isEmpty {
                            Text("読取文字: \(draft.lines.prefix(3).joined(separator: " / "))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                DraftPreviewStrip(entry: entry)
                HStack(spacing: 8) {
                    DraftMemoButton(entry: entry)
                    ManualPhotoAddButton(
                        productId: "",
                        sessionId: entry.id,
                        productName: draft.name.isEmpty ? draft.fnsku : draft.name,
                        thumbPath: nil
                    )
                }
                HStack(spacing: 8) {
                    Button {
                        model.openSearch(purpose: .matchScan(entryId: entry.id, scannedFnsku: entry.fnsku))
                    } label: {
                        Label("手動で検索する", systemImage: "magnifyingglass")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)

                    Button {
                        model.openRegister(entry)
                    } label: {
                        Label("新規登録する", systemImage: "plus.circle.fill")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.indigo)
                }

            case .offlineUnresolved(let code):
                StatusBanner(title: "オフライン保留中（復帰後に照合）", systemImage: "wifi.slash", color: .orange, trailing: code)
                DraftPreviewStrip(entry: entry)
                HStack(spacing: 8) {
                    DraftMemoButton(entry: entry)
                    Button {
                        model.openSearch(purpose: .matchScan(entryId: entry.id, scannedFnsku: entry.fnsku))
                    } label: {
                        Label("手動で検索", systemImage: "magnifyingglass")
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)
                    Button {
                        model.retryLookup(entry.id)
                    } label: {
                        Label("再照合", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)
                }

            case .failed(let s):
                Text(s).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ManualPhotoAddButton: View {
    @EnvironmentObject var model: ScanModel
    let productId: String
    let sessionId: UUID?
    let productName: String
    let thumbPath: String?

    var body: some View {
        let count = model.manualPhotoCount(forProductId: productId, sessionId: sessionId)
        Button {
            model.openManualPhotoChoice(productId: productId, sessionId: sessionId, productName: productName, thumbPath: thumbPath)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "camera.fill")
                Text("実物写真を追加")
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.bold())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.green.opacity(0.22), in: Capsule())
                }
            }
        }
        .buttonStyle(.bordered)
        .font(.caption)
    }
}

private struct MatchedActions: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.openURL) private var openURL
    let entry: Entry
    let card: Card

    var body: some View {
        let guardState = model.fnskuGuardState(entry: entry, card: card)
        VStack(alignment: .leading, spacing: 8) {
            // Part 4 (T-013) strict 1-record-1-FNSKU confirmation guard
            switch guardState {
            case .ownedByOther(let owner):
                VStack(alignment: .leading, spacing: 6) {
                    Label("この FNSKU は別商品に登録済みのため確定できません", systemImage: "xmark.octagon.fill")
                        .font(.caption.bold())
                        .foregroundStyle(.red)
                    Text("登録先: #\(owner.id) \(owner.name)")
                        .font(.caption)
                        .lineLimit(2)
                    Button {
                        model.switchEntryToOwner(entryId: entry.id, owner: owner)
                    } label: {
                        Label("正しい商品を開く（#\(owner.id)）", systemImage: "arrow.right.circle.fill")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                }
                .padding(10)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))

            case .differentFnsku(let scanned, let registered):
                VStack(alignment: .leading, spacing: 6) {
                    Label("FNSKU が一致しません（通常確定できません）", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption.bold())
                        .foregroundStyle(.orange)
                    HStack {
                        Text("スキャン:").font(.caption2).foregroundStyle(.secondary)
                        FnskuCodeText(fnsku: scanned)
                        Text("≠").foregroundStyle(.orange)
                        Text("登録済:").font(.caption2).foregroundStyle(.secondary)
                        FnskuCodeText(fnsku: registered)
                    }
                    Button {
                        model.openFnskuBranch(entryId: entry.id, card: card, scannedFnsku: scanned)
                    } label: {
                        Label("FNSKU不一致の対応を選ぶ", systemImage: "arrow.triangle.branch")
                            .font(.subheadline.bold())
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                }
                .padding(10)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))

            case .assignNewFnsku(let scanned):
                HStack(spacing: 6) {
                    Image(systemName: "info.circle.fill").foregroundStyle(.blue)
                    Text("この商品に FNSKU \(scanned) を新規登録します")
                        .font(.caption.bold())
                        .foregroundStyle(.blue)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))

                Button {
                    model.confirmAndNext(entry.id)
                } label: {
                    Label("FNSKUを登録して在庫確認", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)

            case .exactMatch:
                Button {
                    model.confirmAndNext(entry.id)
                } label: {
                    Label("在庫確認して次へ", systemImage: "checkmark.circle.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)

            case .unverifiedNoFnsku:
                HStack(spacing: 6) {
                    Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
                    Text("FNSKU未照合の確認（バーコードなし）")
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))

                Button {
                    model.confirmAndNext(entry.id)
                } label: {
                    Label("FNSKU未照合で在庫確認", systemImage: "checkmark.circle")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
            }

            if case .ownedByOther = guardState {
                // Blocked: hide no-sell/confirm secondary actions
            } else if case .differentFnsku = guardState {
                // Blocked: must resolve mismatch first
            } else {
                HStack(spacing: 8) {
                    Button {
                        model.openMemoEditor(for: entry)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "square.and.pencil")
                            Text("メモ / AI指示")
                            if entry.hasAnyMemoContent {
                                Text("済")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(Color.blue.opacity(0.2), in: Capsule())
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)

                    Button {
                        model.markNoSellAndNext(entry.id)
                    } label: {
                        Text("売らない（在庫あり）")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                    .font(.caption)
                }
            }

            // Part 5 & Part 6 actions (productId is confirmed here!)
            HStack(spacing: 8) {
                ManualPhotoAddButton(
                    productId: card.id,
                    sessionId: entry.id,
                    productName: card.name,
                    thumbPath: card.official ?? card.thumb
                )

                Button {
                    model.openListingEditor(productId: card.id, productName: card.name)
                } label: {
                    Label("出品文を編集", systemImage: "doc.text")
                }
                .buttonStyle(.bordered)
                .font(.caption)
            }

            HStack(spacing: 8) {
                Button {
                    model.openDetail(card, localPhoto: entry.photo, sessionId: entry.id)
                } label: {
                    Label("詳細", systemImage: "info.circle")
                }
                .buttonStyle(.bordered)
                .font(.caption)

                if let urlStr = card.sourceUrl, let url = URL(string: urlStr) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("商品ページ ↗", systemImage: "safari")
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)
                }

                Button {
                    model.openSearch(purpose: .matchScan(entryId: entry.id, scannedFnsku: entry.fnsku))
                } label: {
                    Label("別商品を探す", systemImage: "magnifyingglass")
                }
                .buttonStyle(.bordered)
                .font(.caption)

                Spacer()
            }
        }
    }
}

private struct DraftMemoButton: View {
    @EnvironmentObject var model: ScanModel
    let entry: Entry

    var body: some View {
        Button {
            model.openMemoEditor(for: entry)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "square.and.pencil")
                Text("メモ / AI指示（下書き）")
                if entry.hasAnyMemoContent {
                    Text("入力済")
                        .font(.caption2.bold())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.blue.opacity(0.2), in: Capsule())
                }
            }
        }
        .buttonStyle(.bordered)
        .font(.caption)
    }
}

private struct DraftPreviewStrip: View {
    let entry: Entry

    var body: some View {
        let cond = entry.fullEditConditionNote ?? entry.conditionNoteDraft
        let ai = entry.fullEditAiInstruction ?? entry.aiInstructionDraft
        if !cond.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ai.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                if !cond.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("状態メモ下書き: \(cond)").font(.caption2).foregroundStyle(.blue).lineLimit(2)
                }
                if !ai.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("AI指示下書き: \(ai)").font(.caption2).foregroundStyle(.indigo).lineLimit(2)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

private struct HistoryRow: View {
    @EnvironmentObject var model: ScanModel
    let item: HistoryItem

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("#\(item.productId)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                    if !item.fnsku.isEmpty {
                        FnskuCodeText(fnsku: item.fnsku)
                    }
                    let statusColor: Color = item.status == "synced" ? .green : (item.status == "needsAttention" ? .red : .orange)
                    let statusText = item.status == "synced" ? "同期済" : (item.status == "needsAttention" ? "要確認" : "同期待ち")
                    Text(statusText)
                        .font(.caption2.bold())
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(statusColor.opacity(0.18), in: Capsule())
                        .foregroundStyle(statusColor)
                }
                Text(item.productName.isEmpty ? "商品 #\(item.productId)" : item.productName)
                    .font(.caption)
                    .lineLimit(1)
            }
            Spacer()
            if let card = item.card {
                Button {
                    model.openListingEditor(productId: card.id, productName: card.name)
                } label: {
                    Image(systemName: "doc.text")
                }
                .buttonStyle(.bordered)
                .font(.caption)

                Button {
                    model.openMemoEditor(for: card, sessionId: item.id)
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .buttonStyle(.bordered)
                .font(.caption)

                Button {
                    model.openDetail(card, sessionId: item.id)
                } label: {
                    Text("詳細")
                }
                .buttonStyle(.bordered)
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct StatusBanner: View {
    let title: String
    let systemImage: String
    let color: Color
    let trailing: String

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
                .font(.caption.bold())
                .foregroundStyle(color)
            Spacer()
            if !trailing.isEmpty {
                Text(trailing).font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct OwnerWarningBox: View {
    let owner: Card
    let onOpenOwner: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            VStack(alignment: .leading, spacing: 2) {
                Text("この FNSKU は既に登録されています").font(.caption.bold()).foregroundStyle(.red)
                Text("#\(owner.id) \(owner.name)").font(.caption).lineLimit(2)
            }
            Spacer()
            Button("正しい商品を開く") { onOpenOwner() }.buttonStyle(.borderedProminent).tint(.red).font(.caption2)
        }
        .padding(8)
        .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// Large one-handed candidate row with Part 4 FNSKU compatibility badge (green/blue/orange).
private struct CandidateRow: View {
    let card: Card
    let scannedFnsku: String
    let onSelect: () -> Void
    let onDetail: () -> Void
    let onOpenPage: () -> Void

    private var compatBadge: (text: String, color: Color)? {
        let s = scannedFnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !s.isEmpty else { return nil }
        let r = card.fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if r.isEmpty { return ("FNSKU未登録", .blue) }
        if r == s { return ("FNSKU一致", .green) }
        return ("別FNSKU済", .orange)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onSelect) {
                HStack(alignment: .top, spacing: 10) {
                    Thumb(path: card.official ?? card.thumb)
                        .frame(width: 72, height: 72)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(card.name)
                            .font(.subheadline.bold())
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                        HStack(spacing: 6) {
                            if let b = compatBadge {
                                Text(b.text)
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(b.color.opacity(0.18), in: Capsule())
                                    .foregroundStyle(b.color)
                            } else {
                                FnskuBadge(fnsku: card.fnsku)
                            }
                            PresenceBadge(presence: card.presence)
                        }
                        if !card.fnsku.isEmpty {
                            FnskuCodeText(fnsku: card.fnsku)
                        }
                        DateSummaryText(card: card)
                        if !card.why.isEmpty {
                            Text("一致理由: \(card.why)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right.circle.fill")
                        .font(.title3)
                        .foregroundStyle(compatBadge?.color == .orange ? .orange : .accentColor)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                Button(action: onDetail) {
                    Label("詳細を見る", systemImage: "info.circle")
                }
                .buttonStyle(.bordered)
                .font(.caption)

                if let urlStr = card.sourceUrl, !urlStr.isEmpty {
                    Button(action: onOpenPage) {
                        Label("商品ページ ↗", systemImage: "safari")
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)
                }
                Spacer()
                Text("#\(card.id)").font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct CardView: View {
    let card: Card
    let big: Bool

    var arrival: String {
        let p = card.arrivalDate.split(separator: "-")
        if p.count == 3 { return "\(Int(p[1]) ?? 0)月\(Int(p[2]) ?? 0)日到着" }
        if let o = card.orderDate, !o.isEmpty {
            let op = o.split(separator: "-")
            if op.count == 3 { return "\(Int(op[1]) ?? 0)月\(Int(op[2]) ?? 0)日購入" }
        }
        return "到着日なし"
    }

    var body: some View {
        let layout = big ? AnyLayout(HStackLayout(alignment: .top)) : AnyLayout(VStackLayout(alignment: .leading))
        layout {
            Thumb(path: card.official ?? card.thumb).frame(width: big ? 84 : 130, height: big ? 84 : 110)
            VStack(alignment: .leading, spacing: 4) {
                Text(arrival).font(big ? .title3.bold() : .headline)
                Text(card.name).font(big ? .body : .caption).lineLimit(big ? 3 : 4)
                HStack(spacing: 4) {
                    FnskuBadge(fnsku: card.fnsku)
                    PresenceBadge(presence: card.presence)
                    if card.decision == "no_sell" {
                        Text("売らない")
                            .font(.caption2.bold())
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color.purple.opacity(0.18), in: Capsule())
                            .foregroundStyle(.purple)
                    }
                }
                Group {
                    if let o = card.orderDate, !o.isEmpty { Text("注文日 \(o)") }
                    if !card.arrivalDate.isEmpty { Text("到着日 \(card.arrivalDate)") }
                    if !card.dateId.isEmpty { Text("日付ID \(card.dateId)") }
                    if !card.productCode.isEmpty { Text("商品ID \(card.productCode)") }
                }
                .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
    }
}

private struct FnskuBadge: View {
    let fnsku: String
    var body: some View {
        Text(fnsku.isEmpty ? "FNSKU未登録" : fnsku)
            .font(.caption2.monospaced().bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(fnsku.isEmpty ? Color.blue.opacity(0.16) : Color.blue.opacity(0.18), in: Capsule())
            .foregroundStyle(.blue)
    }
}

private struct PresenceBadge: View {
    let presence: String?
    var label: String {
        switch presence {
        case "have": return "在庫: ある"
        case "gone": return "在庫: なし"
        case "unknown": return "在庫: ？"
        default: return "在庫: 未確認"
        }
    }
    var color: Color {
        switch presence {
        case "have": return .green
        case "gone": return .red
        case "unknown": return .orange
        default: return .gray
        }
    }
    var body: some View {
        Text(label)
            .font(.caption2.bold())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct DateSummaryText: View {
    let card: Card
    var body: some View {
        let parts: [String] = [
            card.orderDate.flatMap { $0.isEmpty ? nil : "注文 \($0)" },
            card.arrivalDate.isEmpty ? nil : "到着 \(card.arrivalDate)",
        ].compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: " / ")).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// 2-field modal sheet: upper = conditionNote, lower = aiInstruction, with Append (default) & Edit modes.
struct MemoEditorSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    enum EditMode: String, CaseIterable {
        case append = "追記モード"
        case edit = "編集モード"
    }

    let target: MemoTarget

    @State private var mode: EditMode = .append
    @State private var condText = ""
    @State private var aiText = ""

    private var existingCard: Card? {
        switch target.mode {
        case .entryDraft(let entryId, let card):
            return model.entries.first(where: { $0.id == entryId })?.currentCard ?? card
        case .productDirect(let card, _):
            return model.localStore.cachedCard(id: card.id) ?? card
        }
    }

    private var activeEntry: Entry? {
        guard case .entryDraft(let entryId, _) = target.mode else { return nil }
        return model.entries.first(where: { $0.id == entryId })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("入力方法", selection: $mode) {
                        ForEach(EditMode.allCases, id: \.self) { m in
                            Text(m.rawValue).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: mode) { _, newMode in
                        loadFields(for: newMode)
                    }
                    Text(mode == .append
                        ? "普段はこちら：入力した内容が既存メモの末尾に改行して追記されます。"
                        : "全文修正：既存の文を読み込んで上書き保存します。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("状態メモ（conditionNote）") {
                    if mode == .append, let existing = existingCard?.conditionNote, !existing.isEmpty {
                        Text(existing)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    TextField(mode == .append ? "追記する状態メモ…" : "状態メモの全文…", text: $condText, axis: .vertical)
                        .lineLimit(3...6)
                }

                Section("AIへの指示（aiInstruction）") {
                    if mode == .append, let existing = existingCard?.aiInstruction, !existing.isEmpty {
                        Text(existing)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    TextField(mode == .append ? "追記するAIへの指示…" : "AIへの指示の全文…", text: $aiText, axis: .vertical)
                        .lineLimit(3...6)
                }
            }
            .navigationTitle("メモ / AI指示")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("保存") { save() }.bold()
                }
            }
            .onAppear {
                model.addPauseReason(.memoSheet)
                loadFields(for: mode)
            }
            .onDisappear {
                model.removePauseReason(.memoSheet)
            }
        }
    }

    private func loadFields(for targetMode: EditMode) {
        switch targetMode {
        case .append:
            if let e = activeEntry {
                condText = e.conditionNoteDraft
                aiText = e.aiInstructionDraft
            } else {
                condText = ""
                aiText = ""
            }
        case .edit:
            let baseCond = existingCard?.conditionNote ?? ""
            let baseAi = existingCard?.aiInstruction ?? ""
            if let e = activeEntry {
                condText = e.fullEditConditionNote ?? mergePreview(base: baseCond, draft: e.conditionNoteDraft)
                aiText = e.fullEditAiInstruction ?? mergePreview(base: baseAi, draft: e.aiInstructionDraft)
            } else {
                condText = baseCond
                aiText = baseAi
            }
        }
    }

    private func mergePreview(base: String, draft: String) -> String {
        let d = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if d.isEmpty { return base }
        return base.isEmpty ? d : "\(base)\n\(d)"
    }

    private func save() {
        switch target.mode {
        case .entryDraft(let entryId, _):
            if mode == .append {
                model.saveEntryMemos(entryId: entryId, appendCondition: condText, appendAi: aiText, setCondition: nil, setAi: nil)
            } else {
                model.saveEntryMemos(entryId: entryId, appendCondition: "", appendAi: "", setCondition: condText, setAi: aiText)
            }
        case .productDirect(let card, let sessionId):
            if mode == .append {
                model.saveDirectMemos(card: card, sessionId: sessionId, appendCondition: condText, appendAi: aiText, setCondition: nil, setAi: nil)
            } else {
                model.saveDirectMemos(card: card, sessionId: sessionId, appendCondition: "", appendAi: "", setCondition: condText, setAi: aiText)
            }
        }
        dismiss()
    }
}

/// Full product detail sheet: photos, manual real-photo add/select (Part 5), listing text edit (Part 6), memos, dates, URL.
struct ProductDetailSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let card: Card
    let localPhoto: PhotoData?
    let sessionId: UUID?

    @State private var showPhotoAddDialog = false

    private var currentCard: Card {
        model.localStore.cachedCard(id: card.id) ?? card
    }

    var body: some View {
        NavigationStack {
            List {
                Section("写真・読み取り場面") {
                    HStack(spacing: 12) {
                        VStack(spacing: 4) {
                            Thumb(path: currentCard.official ?? currentCard.thumb)
                                .frame(width: 130, height: 130)
                            Text("商品画像").font(.caption2).foregroundStyle(.secondary)
                        }
                        if let localPhoto, let ui = UIImage(data: localPhoto.thumb) {
                            VStack(spacing: 4) {
                                Image(uiImage: ui)
                                    .resizable()
                                    .scaledToFit()
                                    .frame(width: 130, height: 130)
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                Text("写真：端末内のみ").font(.caption2).foregroundStyle(.secondary)
                            }
                        } else if let scenePath = currentCard.scanScene ?? currentCard.scanSceneThumb {
                            VStack(spacing: 4) {
                                Thumb(path: scenePath)
                                    .frame(width: 130, height: 130)
                                Text("保存済みスキャン場面").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)

                    // Part 5 unified manual real-photo actions (never mutates stockCheckedAt / memos / FNSKU)
                    let manualCount = model.manualPhotoCount(forProductId: currentCard.id, sessionId: sessionId)
                    Button {
                        showPhotoAddDialog = true
                    } label: {
                        HStack {
                            Label("実物写真を追加", systemImage: "camera.fill")
                            Spacer()
                            if manualCount > 0 {
                                Text("端末内 \(manualCount)枚")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.green)
                            }
                        }
                    }

                    Button {
                        let pid = currentCard.id
                        let pname = currentCard.name
                        model.transitionFromDetail(adding: .photoSelectionSheet) {
                            model.photoSelectionTarget = PhotoSelectionTarget(productId: pid, productName: pname)
                        }
                    } label: {
                        Label("実物写真を選別（採用／不採用）", systemImage: "photo.stack")
                    }
                }

                // Part 6 (T-011) listing text edit (always available here since productId is confirmed)
                Section("出品文（メルカリ等・共通文）") {
                    Button {
                        let pid = currentCard.id
                        let pname = currentCard.name
                        model.transitionFromDetail(adding: .listingEditSheet) {
                            model.listingEditTarget = ListingEditTarget(productId: pid, productName: pname)
                        }
                    } label: {
                        Label("出品文を編集", systemImage: "doc.text.fill")
                    }
                }

                Section("商品情報") {
                    LabeledContent("台帳ID", value: "#\(currentCard.id)")
                    Text(currentCard.name).font(.body.bold())
                    if let brand = currentCard.brand, !brand.isEmpty { LabeledContent("ブランド", value: brand) }
                    if let modelStr = currentCard.model, !modelStr.isEmpty { LabeledContent("型番", value: modelStr) }
                    LabeledContent("FNSKU") {
                        FnskuCodeText(fnsku: currentCard.fnsku)
                    }
                    LabeledContent("在庫状態") {
                        PresenceBadge(presence: currentCard.presence)
                    }
                    if let dec = currentCard.decision, !dec.isEmpty {
                        LabeledContent("販売判断", value: dec)
                    }
                }

                Section("状態メモ・AI指示") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("状態メモ（conditionNote）").font(.caption).foregroundStyle(.secondary)
                        Text((currentCard.conditionNote?.isEmpty == false) ? currentCard.conditionNote! : "未記入")
                            .font(.subheadline)
                            .foregroundStyle((currentCard.conditionNote?.isEmpty == false) ? .primary : .secondary)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AIへの指示（aiInstruction）").font(.caption).foregroundStyle(.secondary)
                        Text((currentCard.aiInstruction?.isEmpty == false) ? currentCard.aiInstruction! : "未記入")
                            .font(.subheadline)
                            .foregroundStyle((currentCard.aiInstruction?.isEmpty == false) ? .primary : .secondary)
                    }
                    Button {
                        let c = currentCard
                        let sid = sessionId
                        model.transitionFromDetail(adding: .memoSheet) {
                            model.memoTarget = MemoTarget(mode: .productDirect(card: c, sessionId: sid))
                        }
                    } label: {
                        Label("メモ / AI指示を追記・編集", systemImage: "square.and.pencil")
                    }
                }

                Section("日付・ID") {
                    LabeledContent("注文日", value: (currentCard.orderDate?.isEmpty == false) ? currentCard.orderDate! : "未登録")
                    LabeledContent("到着日", value: currentCard.arrivalDate.isEmpty ? "未登録" : currentCard.arrivalDate)
                    if !currentCard.shotDate.isEmpty { LabeledContent("撮影日", value: currentCard.shotDate) }
                    if let lastScan = currentCard.lastScanAt, !lastScan.isEmpty { LabeledContent("最終スキャン", value: lastScan) }
                    if !currentCard.dateId.isEmpty { LabeledContent("日付ID", value: currentCard.dateId) }
                    if !currentCard.productCode.isEmpty { LabeledContent("商品ID", value: currentCard.productCode) }
                }

                Section("商品ページ") {
                    if let urlStr = currentCard.sourceUrl, let url = URL(string: urlStr) {
                        Text(urlStr).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        Button {
                            openURL(url)
                        } label: {
                            Label("商品ページを開く", systemImage: "safari.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Text("商品ページ URL は未登録です").foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("商品詳細 #\(currentCard.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
            .confirmationDialog("実物写真を追加", isPresented: $showPhotoAddDialog, titleVisibility: .visible) {
                let target = ManualPhotoTarget(
                    productId: currentCard.id,
                    sessionId: sessionId,
                    productName: currentCard.name,
                    thumbPath: currentCard.official ?? currentCard.thumb
                )
                Button("カメラで撮る") {
                    model.transitionFromDetail(adding: .manualCapture) {
                        model.manualCaptureTarget = target
                    }
                }
                Button("ライブラリから選ぶ") {
                    model.transitionFromDetail(adding: .manualLibraryPicker) {
                        model.manualPickerTarget = target
                    }
                }
                Button("キャンセル", role: .cancel) {}
            }
            .onAppear { model.addPauseReason(.detailSheet) }
            .onDisappear { model.removePauseReason(.detailSheet) }
        }
    }
}

/// New product registration sheet from State C, Branch Sheet, or Manual Search, with live duplicate/similar check.
struct RegisterSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let entryId: UUID
    let draft: ScanDraft

    @State private var name: String
    @State private var brand: String = ""
    @State private var modelText: String = ""
    @State private var jan: String
    @State private var urlText: String = ""
    @State private var notes: String = ""
    @State private var allowDuplicate = false
    @State private var checking = false
    @State private var submitting = false
    @State private var dupResult: DuplicateCheck?
    @State private var errorMsg = ""

    init(entryId: UUID, draft: ScanDraft) {
        self.entryId = entryId
        self.draft = draft
        _name = State(initialValue: draft.name)
        _jan = State(initialValue: draft.jan)
    }

    private var entry: Entry? { model.entries.first(where: { $0.id == entryId }) }

    var body: some View {
        NavigationStack {
            Form {
                Section("読み取り情報") {
                    HStack(spacing: 10) {
                        if let photo = entry?.photo, let ui = UIImage(data: photo.thumb) {
                            Image(uiImage: ui)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 68, height: 68)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            FnskuCodeText(fnsku: draft.fnsku)
                            if !draft.jan.isEmpty {
                                Text("バーコード JAN: \(draft.jan)").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            Text("登録と同時にこの FNSKU とラベル画像を紐付けます").font(.caption).foregroundStyle(.secondary)
                        }
                    }

                    if !draft.lines.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("ラベル読取文字（タップで商品名に反映）").font(.caption).foregroundStyle(.secondary)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(draft.lines, id: \.self) { line in
                                        Button(line) {
                                            if name.isEmpty { name = line }
                                            else if !name.contains(line) { name += " \(line)" }
                                        }
                                        .buttonStyle(.bordered)
                                        .font(.caption)
                                    }
                                }
                            }
                        }
                    }
                }

                Section("新規商品の内容") {
                    TextField("商品名（必須）", text: $name, axis: .vertical)
                        .lineLimit(2...4)
                    TextField("ブランド（任意）", text: $brand)
                    TextField("型番（任意）", text: $modelText)
                    TextField("JAN（任意）", text: $jan).keyboardType(.numberPad)
                    TextField("商品ページ URL（任意）", text: $urlText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("メモ（任意）", text: $notes, axis: .vertical)
                }

                if let entry {
                    Section("下書きメモ（引き継ぎ）") {
                        DraftPreviewStrip(entry: entry)
                        DraftMemoButton(entry: entry)
                    }
                }

                if checking {
                    Section {
                        ProgressView("既存商品との重複・類似を確認中…")
                    }
                }

                if let dup = dupResult {
                    if let owner = dup.fnskuOwner {
                        Section("登録済み FNSKU の重複防止") {
                            OwnerWarningBox(owner: owner) {
                                dismiss()
                                model.switchEntryToOwner(entryId: entryId, owner: owner)
                            }
                            Text("この FNSKU は既に登録済みのため、新規作成はできません。既存商品を開いて確認してください。")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }

                    if !dup.duplicates.isEmpty || !dup.similar.isEmpty {
                        Section("同じ商品名／ASIN・似ている既存商品") {
                            ForEach(dup.duplicates + dup.similar) { c in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(alignment: .top, spacing: 8) {
                                        Thumb(path: c.official ?? c.thumb).frame(width: 54, height: 54)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text("#\(c.id) \(c.name)").font(.subheadline.bold()).lineLimit(2)
                                            HStack(spacing: 4) {
                                                FnskuBadge(fnsku: c.fnsku)
                                                PresenceBadge(presence: c.presence)
                                            }
                                            if !c.why.isEmpty {
                                                Text(c.why).font(.caption2).foregroundStyle(.orange)
                                            }
                                            DateSummaryText(card: c)
                                        }
                                    }
                                    HStack(spacing: 8) {
                                        Button("既存商品を開く") {
                                            dismiss()
                                            model.openDetail(c, localPhoto: entry?.photo, sessionId: entryId)
                                        }
                                        .buttonStyle(.bordered)
                                        .font(.caption)

                                        if let s = c.sourceUrl, let u = URL(string: s) {
                                            Button("商品ページ ↗") { openURL(u) }
                                                .buttonStyle(.bordered)
                                                .font(.caption)
                                        }

                                        Spacer()

                                        if c.fnsku.isEmpty || c.fnsku.uppercased() == draft.fnsku.uppercased() {
                                            Button("この商品に紐付ける") {
                                                dismiss()
                                                model.choose(entryId, c)
                                            }
                                            .buttonStyle(.borderedProminent)
                                            .font(.caption)
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }

                    if !dup.duplicates.isEmpty && dup.fnskuOwner == nil {
                        Section {
                            Toggle("同じ商品名／ASIN の既存商品を確認済み（別個体として新規登録する）", isOn: $allowDuplicate)
                                .font(.caption)
                        }
                    }
                }

                if !errorMsg.isEmpty {
                    Section {
                        Text(errorMsg).foregroundStyle(.red).font(.caption)
                    }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if submitting {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text(draft.fnsku.isEmpty ? "新規登録して記録する" : "新規登録して \(draft.fnsku) を紐付ける")
                                .frame(maxWidth: .infinity)
                                .font(.headline)
                        }
                    }
                    .disabled(submitting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || dupResult?.fnskuOwner != nil || (!(dupResult?.duplicates.isEmpty ?? true) && !allowDuplicate))
                }
            }
            .navigationTitle("新規商品登録")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("キャンセル") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("重複確認") { Task { await runDupCheck() } }
                }
            }
            .task(id: "\(name)|\(brand)|\(modelText)|\(jan)|\(urlText)") {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                await runDupCheck()
            }
            .onAppear { model.addPauseReason(.registerSheet) }
            .onDisappear { model.removePauseReason(.registerSheet) }
        }
    }

    private func runDupCheck() async {
        checking = true
        defer { checking = false }
        do {
            dupResult = try await Api.checkDuplicates(
                fnsku: draft.fnsku,
                name: name,
                brand: brand,
                model: modelText,
                jan: jan,
                url: urlText,
                lines: draft.lines
            )
            errorMsg = ""
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        errorMsg = ""
        do {
            try await model.registerNew(
                entryId: entryId,
                fnskuOverride: draft.fnsku.isEmpty ? nil : draft.fnsku,
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                brand: brand.trimmingCharacters(in: .whitespacesAndNewlines),
                model: modelText.trimmingCharacters(in: .whitespacesAndNewlines),
                jan: jan.trimmingCharacters(in: .whitespacesAndNewlines),
                url: urlText.trimmingCharacters(in: .whitespacesAndNewlines),
                notes: notes.trimmingCharacters(in: .whitespacesAndNewlines),
                allowDuplicate: allowDuplicate
            )
            dismiss()
        } catch let err as ApiError {
            errorMsg = err.message
            if err.fnskuOwner != nil || err.duplicates != nil || err.similar != nil {
                dupResult = DuplicateCheck(
                    fnskuOwner: err.fnskuOwner,
                    duplicates: err.duplicates ?? [],
                    similar: err.similar ?? [],
                    hasConflict: err.fnskuOwner != nil || !(err.duplicates?.isEmpty ?? true)
                )
            }
        } catch {
            errorMsg = error.localizedDescription
        }
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
