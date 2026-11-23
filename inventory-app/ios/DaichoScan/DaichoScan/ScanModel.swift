import AVFoundation
import Network
import SwiftUI
import PhotosUI

/// Auto-scan behavior mode (Part 2 / T-012): persisted in UserDefaults.
enum ScanMode: String, CaseIterable {
    case continuous = "continuous"
    case single = "single"

    var label: String {
        switch self {
        case .continuous: return "連続"
        case .single: return "1件ずつ"
        }
    }
}

/// Reasons why live auto-scan is paused (Part 2 / T-012).
/// Transitions add the next reason before removing the old one so there is zero gap (no timer hacks).
enum AutoScanPauseReason: Hashable {
    case memoSheet
    case registerSheet
    case detailSheet
    case listingEditSheet
    case fnskuBranchSheet
    case searchSheet
    case manualCapture
    case manualLibraryPicker
    case photoSelectionSheet
    case attentionSheet
    case manualPause

    var isEditingFlow: Bool {
        self != .manualPause
    }
}

/// Part 4 (T-013) strict 1-record-1-FNSKU confirmation guard state.
enum FnskuGuardState: Equatable {
    case ownedByOther(owner: Card)
    case differentFnsku(scanned: String, registered: String)
    case assignNewFnsku(scanned: String)
    case exactMatch(fnsku: String)
    case unverifiedNoFnsku
}

/// One reading: a label seen by the camera or a photo from the library (backed by a persisted ScanSession).
struct Entry: Identifiable {
    enum State {
        case looking
        case registered(Card)
        case matched(Card, registeredNew: Bool)
        case choose([Card], owner: Card?)
        case unregistered(ScanDraft)
        case offlineUnresolved(String)
        case failed(String)
    }
    let id: UUID
    let code: String
    let fromLibrary: Bool
    let at: Date
    var state: State = .looking
    var fnsku = ""
    var fnskuOwner: Card?
    var draft: ScanDraft?
    var alternatives: [Card] = []
    var photo: PhotoData?
    var conditionNoteDraft = ""
    var aiInstructionDraft = ""
    var fullEditConditionNote: String?
    var fullEditAiInstruction: String?
    var saved = ""
    var canUndo = false

    init(
        id: UUID = UUID(),
        code: String,
        fromLibrary: Bool,
        at: Date,
        state: State = .looking,
        fnsku: String = "",
        conditionNoteDraft: String = "",
        aiInstructionDraft: String = ""
    ) {
        self.id = id
        self.code = code
        self.fromLibrary = fromLibrary
        self.at = at
        self.state = state
        self.fnsku = fnsku
        self.conditionNoteDraft = conditionNoteDraft
        self.aiInstructionDraft = aiInstructionDraft
    }

    var currentCard: Card? {
        switch state {
        case .registered(let c), .matched(let c, _):
            return c
        default:
            return nil
        }
    }

    var hasAnyMemoContent: Bool {
        if !conditionNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if !aiInstructionDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if let v = fullEditConditionNote, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if let v = fullEditAiInstruction, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
        if let c = currentCard {
            if !(c.conditionNote ?? "").isEmpty || !(c.aiInstruction ?? "").isEmpty { return true }
        }
        return false
    }
}

struct HistoryItem: Identifiable {
    let id: UUID
    let productId: String
    let productName: String
    let fnsku: String
    let createdAt: Date
    let status: String
    let card: Card?
}

struct DetailTarget: Identifiable {
    let id = UUID()
    let card: Card
    let localPhoto: PhotoData?
    let sessionId: UUID?
}

struct RegisterTarget: Identifiable {
    let id: UUID
    let draft: ScanDraft
}

struct MemoTarget: Identifiable {
    enum Mode {
        case entryDraft(entryId: UUID, card: Card?)
        case productDirect(card: Card, sessionId: UUID?)
    }
    let id = UUID()
    let mode: Mode
}

struct UndoToast: Identifiable {
    let id = UUID()
    let sessionId: UUID
    let productId: String
    let productName: String
    let previousDecision: String
}

struct NoticeBanner: Identifiable {
    let id = UUID()
    let message: String
    let productId: String?
    let productName: String
}

@MainActor
final class ScanModel: ObservableObject {
    @Published var entries: [Entry] = []
    @Published var history: [HistoryItem] = []
    @Published var muted = false
    @Published var busyLibrary = 0
    @Published var pendingSyncCount = 0
    @Published var attentionCount = 0
    @Published var hasListingConflicts = false
    @Published var isSyncing = false
    @Published var isUploadingPhotos = false
    @Published var isOnline = true
    @Published var syncErrorMessage = ""

    // Part 2 (T-012): Mode & Pause controls
    @Published var scanMode: ScanMode {
        didSet {
            UserDefaults.standard.set(scanMode.rawValue, forKey: Self.scanModeKey)
        }
    }
    @Published var pauseReasons: Set<AutoScanPauseReason> = []
    @Published var oneShotArmed = false

    // Sheets & Modals
    @Published var detailTarget: DetailTarget?
    @Published var registerTarget: RegisterTarget?
    @Published var memoTarget: MemoTarget?
    @Published var fnskuBranchTarget: FnskuBranchTarget?
    @Published var searchTarget: SearchTarget?
    @Published var manualCaptureTarget: ManualPhotoTarget?
    @Published var manualPickerTarget: ManualPhotoTarget?
    @Published var manualPhotoChoiceTarget: ManualPhotoTarget?
    @Published var photoSelectionTarget: PhotoSelectionTarget?
    @Published var listingEditTarget: ListingEditTarget?
    @Published var showAttentionSheet = false
    @Published var undoToast: UndoToast?
    @Published var noticeBanner: NoticeBanner?

    // Part 7 (T-014): Local SearchProjection catalog
    @Published var catalogItems: [SearchProjection] = []
    @Published var isRefreshingCatalog = false

    let scanner = Scanner()
    let localStore = LocalStore()

    private static let scanModeKey = "daichoscan.scanMode"
    private let voice = AVSpeechSynthesizer()
    private let pathMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "daichoscan.network")

    // Part 2 (T-012): 3-gate Job ID protection & cooldown/dedup state
    private var activeJobs: [UUID: UUID] = [:]
    private var discardedEntryIds: Set<UUID> = []
    private var lastAcceptedCode: String = ""
    private var lastAcceptedAt: Date = .distantPast
    private var cooldownUntil: Date = .distantPast
    private var sameCodeOverride: String?
    private var pendingTransition: (() -> Void)?

    private var toastTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.scanModeKey)
        self.scanMode = ScanMode(rawValue: saved ?? "") ?? .continuous
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        scanner.onCode = { [weak self] code, wasAbsent in
            Task { @MainActor in self?.handleAutoDetectedCode(code, wasAbsent: wasAbsent) }
        }
        restorePersistedState()
        refreshCatalogFromStore()
        startNetworkMonitor()
        startRetryLoop()
    }

    // MARK: - Computed Partitioning & Auto-Scan Status (Part 2)

    /// Today's unconfirmed entries ("確認待ち").
    var todayEntries: [Entry] {
        entries.filter { Calendar.current.isDateInToday($0.at) }
    }

    /// Older unconfirmed entries from previous days ("古い確認待ち", never auto-deleted).
    var olderEntries: [Entry] {
        entries.filter { !Calendar.current.isDateInToday($0.at) }
    }

    var isEditingFlowActive: Bool {
        pauseReasons.contains(where: \.isEditingFlow)
    }

    var isManuallyPaused: Bool {
        pauseReasons.contains(.manualPause)
    }

    var isStoppedBySingleMode: Bool {
        scanMode == .single && !todayEntries.isEmpty && !oneShotArmed
    }

    /// Show "次の1件を読む" escape button ONLY when stopped by single-mode or manual pause (and not inside a modal).
    var showNextOneShotButton: Bool {
        !isEditingFlowActive && (isStoppedBySingleMode || isManuallyPaused)
    }

    var autoScanStatusLabel: String {
        if isEditingFlowActive { return "編集中・自動読取停止" }
        if oneShotArmed { return "次の1件を待機中…" }
        if isManuallyPaused { return "一時停止中" }
        if isStoppedBySingleMode { return "1件ずつモード：確認待ち" }
        return "自動読取中（\(scanMode.label)）"
    }

    // MARK: - Pause Reasons & Seamless Sheet Transitions (Part 2)

    func addPauseReason(_ reason: AutoScanPauseReason) {
        let wasEmpty = pauseReasons.isEmpty
        pauseReasons.insert(reason)
        if reason.isEditingFlow {
            // Immediately stop TTS when entering any editing/modal sheet.
            stopSpeakingImmediately()
        }
        if wasEmpty && reason.isEditingFlow {
            oneShotArmed = false
        }
    }

    func removePauseReason(_ reason: AutoScanPauseReason) {
        pauseReasons.remove(reason)
        if pauseReasons.isEmpty {
            startPostActionCooldown()
        }
    }

    func toggleManualPause() {
        if pauseReasons.contains(.manualPause) {
            pauseReasons.remove(.manualPause)
            startPostActionCooldown()
        } else {
            pauseReasons.insert(.manualPause)
            oneShotArmed = false
            stopSpeakingImmediately()
        }
    }

    func armOneShotNextScan() {
        pauseReasons.remove(.manualPause)
        oneShotArmed = true
        cooldownUntil = .distantPast
    }

    func startPostActionCooldown() {
        cooldownUntil = Date().addingTimeInterval(ScanTiming.postActionCooldown)
    }

    func stopSpeakingImmediately() {
        if voice.isSpeaking || voice.isPaused {
            voice.stopSpeaking(at: .immediate)
        }
    }

    /// Execute any queued sheet transition right after the previous sheet finishes dismissing (zero timer hacks).
    func runPendingTransition() {
        guard let next = pendingTransition else { return }
        pendingTransition = nil
        next()
    }

    func transitionFromDetail(adding nextReason: AutoScanPauseReason, open: @escaping () -> Void) {
        addPauseReason(nextReason)
        if detailTarget != nil {
            pendingTransition = open
            detailTarget = nil
        } else {
            open()
        }
    }

    // MARK: - Restore & Refresh

    private func restorePersistedState() {
        for s in localStore.unresolvedSessions() {
            let state: Entry.State
            if let card = s.decodedCard {
                state = (!card.fnsku.isEmpty && card.fnsku.uppercased() == s.fnsku.uppercased())
                    ? .registered(card)
                    : .matched(card, registeredNew: false)
            } else {
                state = .offlineUnresolved(s.fnsku.isEmpty ? s.code : s.fnsku)
            }
            let entry = Entry(
                id: s.sessionId,
                code: s.code,
                fromLibrary: false,
                at: s.createdAt,
                state: state,
                fnsku: s.fnsku,
                conditionNoteDraft: s.conditionNoteDraft,
                aiInstructionDraft: s.aiInstructionDraft
            )
            entries.append(entry)
        }
        refreshPersistedViews()
    }

    func refreshPersistedViews() {
        pendingSyncCount = localStore.pendingCount()
        let attnOps = localStore.attentionOperations()
        let attnPhotos = localStore.allLocalPhotos().filter { $0.uploadState == "needsAttention" }
        attentionCount = attnOps.count + attnPhotos.count
        hasListingConflicts = localStore.hasListingConflicts()
        syncErrorMessage = attnOps.first?.lastError ?? attnPhotos.first?.lastError ?? ""
        history = localStore.recentSessions(limit: 40)
            .filter { $0.status == "pendingSync" || $0.status == "synced" || $0.status == "needsAttention" }
            .compactMap { s in
                guard let pid = s.productId else { return nil }
                let cached = localStore.cachedCard(id: pid) ?? s.decodedCard
                return HistoryItem(
                    id: s.sessionId,
                    productId: pid,
                    productName: cached?.name ?? s.productName,
                    fnsku: s.fnsku,
                    createdAt: s.createdAt,
                    status: s.status,
                    card: cached
                )
            }
    }

    private func startNetworkMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let ok = (path.status == .satisfied)
            Task { @MainActor [weak self] in
                guard let self else { return }
                let wasOffline = !self.isOnline
                self.isOnline = ok
                if ok && (wasOffline || self.pendingSyncCount > 0) {
                    await self.flushSyncQueue()
                    await self.flushManualPhotoUploads()
                    if self.catalogItems.isEmpty { await self.refreshCatalog() }
                }
            }
        }
        pathMonitor.start(queue: monitorQueue)
    }

    private func startRetryLoop() {
        retryTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, self.isOnline else { continue }
                if !self.localStore.pendingOperations().isEmpty {
                    await self.flushSyncQueue()
                }
                if !self.localStore.pendingManualPhotos().isEmpty {
                    await self.flushManualPhotoUploads()
                }
            }
        }
    }

    /// Spoken one after another, suppressed immediately while any editing/modal sheet is open.
    func speak(_ text: String) {
        guard !muted, !text.isEmpty, !isEditingFlowActive else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        u.rate = 0.55
        voice.speak(u)
    }

    // MARK: - Part 2 & 3: Camera Auto-Scan (3-Gate) & Touch Shutter

    private func canAcceptAutoScan(code: String, wasAbsent: Bool, now: Date) -> Bool {
        // Gate 1: Editing flow lock / manual pause
        if !pauseReasons.isEmpty { return false }
        // Single-item mode lock unless user tapped "次の1件を読む"
        if scanMode == .single && !todayEntries.isEmpty && !oneShotArmed { return false }
        // Post-action cooldown (0.8s)
        if now < cooldownUntil && sameCodeOverride != code { return false }
        // Explicit "同じコードを再読" override
        if sameCodeOverride == code { return true }
        // Different code vs same code timing
        let elapsed = now.timeIntervalSince(lastAcceptedAt)
        if code == lastAcceptedCode {
            return elapsed >= ScanTiming.sameCodeMinInterval && wasAbsent
        } else {
            return elapsed >= ScanTiming.differentCodeInterval
        }
    }

    private func handleAutoDetectedCode(_ code: String, wasAbsent: Bool) {
        let now = Date()
        guard canAcceptAutoScan(code: code, wasAbsent: wasAbsent, now: now) else { return }

        // Gate 1 atomic acceptance
        lastAcceptedCode = code
        lastAcceptedAt = now
        sameCodeOverride = nil
        oneShotArmed = false

        let e = Entry(code: code, fromLibrary: false, at: now, fnsku: code.uppercased().hasPrefix("X00") ? code.uppercased() : "")
        let jobId = UUID()
        activeJobs[e.id] = jobId
        entries.insert(e, at: 0)
        localStore.upsertSession(sessionId: e.id, code: code, fnsku: e.fnsku, status: "working")
        Task { await look(e.id, jobId: jobId, codes: [code], capturedData: nil) }
    }

    /// Part 2: Explicit escape to re-read the same barcode without waiting 3.0s.
    func allowSameCodeOnce(_ code: String) {
        sameCodeOverride = code
        lastAcceptedCode = ""
        lastAcceptedAt = .distantPast
        cooldownUntil = .distantPast
        scanner.clearAbsenceTracking(for: code)
        if scanMode == .single || isManuallyPaused {
            armOneShotNextScan()
        }
    }

    /// Part 3 (T-010 Stage 3): Fixed 68pt touch shutter on the main scan screen.
    func triggerScanShutter() async {
        guard !isEditingFlowActive else { return }
        await scanner.triggerManualShutter { [weak self] data in
            guard let self else { return }
            let roi = self.scanner.ocrRegionOfInterest
            let (codes, lines) = await Task.detached(priority: .userInitiated) {
                PhotoTools.read(data, barcodes: true, regionOfInterest: roi)
            }.value
            let prepared = await Task.detached(priority: .userInitiated) {
                PhotoTools.prepare(data, fallbackTime: Date())
            }.value
            await MainActor.run {
                let now = Date()
                let primaryCode = codes.first(where: { $0.uppercased().hasPrefix("X00") }) ?? codes.first ?? "手動撮影"
                let fnskuGuess = codes.first(where: { $0.uppercased().hasPrefix("X00") })?.uppercased() ?? ""
                var e = Entry(code: primaryCode, fromLibrary: false, at: now, fnsku: fnskuGuess)
                e.photo = prepared
                let jobId = UUID()
                self.activeJobs[e.id] = jobId
                self.oneShotArmed = false
                self.entries.insert(e, at: 0)
                self.localStore.upsertSession(sessionId: e.id, code: primaryCode, fnsku: fnskuGuess, status: "working")
                Task { await self.look(e.id, jobId: jobId, codes: codes, linesOverride: lines, capturedData: data) }
            }
        }
    }

    func retryLookup(_ id: UUID) {
        guard let e = entries.first(where: { $0.id == id }) else { return }
        let jobId = UUID()
        activeJobs[id] = jobId
        update(id) { $0.state = .looking }
        Task { await look(id, jobId: jobId, codes: [e.fnsku.isEmpty ? e.code : e.fnsku], capturedData: nil) }
    }

    private func isJobAlive(entryId: UUID, jobId: UUID) -> Bool {
        !discardedEntryIds.contains(entryId) && activeJobs[entryId] == jobId
    }

    private func look(_ id: UUID, jobId: UUID, codes: [String], linesOverride: [String]? = nil, capturedData: Data?) async {
        // Gate 2: pre-capture validation
        guard isJobAlive(entryId: id, jobId: jobId) else { return }

        let stillTask: Task<Data?, Never>? = capturedData == nil ? Task { await self.scanner.capture() } : nil

        do {
            var r = try await Api.scan(codes: codes, lines: linesOverride ?? [])
            guard isJobAlive(entryId: id, jobId: jobId) else { return }
            update(id) {
                $0.fnsku = r.fnsku
                $0.fnskuOwner = r.fnskuOwner
                $0.draft = r.draft
                $0.alternatives = r.candidates
            }

            let stillData: Data?
            if let capturedData {
                stillData = capturedData
            } else {
                stillData = await stillTask?.value
            }
            guard isJobAlive(entryId: id, jobId: jobId) else { return }

            if linesOverride == nil && r.pick == nil && r.registered != true, let data = stillData {
                let roi = scanner.ocrRegionOfInterest
                let lines = await Task.detached { PhotoTools.read(data, barcodes: false, regionOfInterest: roi).lines }.value
                guard isJobAlive(entryId: id, jobId: jobId) else { return }
                r = try await Api.scan(codes: codes, lines: lines)
                guard isJobAlive(entryId: id, jobId: jobId) else { return }
                update(id) {
                    $0.fnsku = r.fnsku
                    $0.fnskuOwner = r.fnskuOwner
                    $0.draft = r.draft
                    $0.alternatives = r.candidates
                }
            }

            if let data = stillData, entries.first(where: { $0.id == id })?.photo == nil {
                let photo = await Task.detached { PhotoTools.prepare(data, fallbackTime: Date()) }.value
                guard isJobAlive(entryId: id, jobId: jobId) else { return }
                update(id) { $0.photo = photo }
            }

            // Gate 3: post-lookup settle
            guard isJobAlive(entryId: id, jobId: jobId) else { return }
            settle(id, r, silent: isEditingFlowActive)
        } catch {
            let stillData: Data?
            if let capturedData {
                stillData = capturedData
            } else {
                stillData = await stillTask?.value
            }
            guard isJobAlive(entryId: id, jobId: jobId) else { return }
            if let data = stillData, entries.first(where: { $0.id == id })?.photo == nil,
               let photo = PhotoTools.prepare(data, fallbackTime: Date()) {
                update(id) { $0.photo = photo }
            }
            let code = entries.first(where: { $0.id == id })?.code ?? codes.first ?? ""
            if let cached = localStore.cachedCard(forFnsku: code) {
                localStore.upsertSession(sessionId: id, code: code, fnsku: code, productId: cached.id, status: "working", card: cached)
                update(id) {
                    $0.fnsku = cached.fnsku
                    $0.state = .registered(cached)
                }
                if !isEditingFlowActive { speak("オフライン。\(cached.say)") }
            } else {
                localStore.upsertSession(sessionId: id, code: code, fnsku: code.uppercased().hasPrefix("X00") ? code.uppercased() : "", status: "unresolved")
                update(id) { $0.state = .offlineUnresolved(code) }
                if !isEditingFlowActive { speak("オフラインで保留しました") }
            }
        }
    }

    private func settle(_ id: UUID, _ r: Lookup, silent: Bool) {
        let e = entries.first(where: { $0.id == id })
        let draft = r.draft ?? ScanDraft(fnsku: r.fnsku, jan: "", name: "", lines: [])
        let isRegistered = (r.status == "registered") || (r.registered == true)
        if let owner = r.fnskuOwner { localStore.cacheCard(owner) }
        for c in r.candidates { localStore.cacheCard(c) }

        if isRegistered {
            if let p = r.pick {
                if !silent { speak(r.voiceSay ?? "登録済みの商品です。\(p.say)") }
                localStore.upsertSession(sessionId: id, code: e?.code ?? r.fnsku, fnsku: r.fnsku, productId: p.id, status: "working", card: p)
                update(id) { $0.state = .registered(p) }
            } else {
                if !silent { speak(r.voiceSay ?? "候補が複数あります。確認してください") }
                localStore.upsertSession(sessionId: id, code: e?.code ?? r.fnsku, fnsku: r.fnsku, status: "unresolved")
                update(id) { $0.state = .choose(r.candidates, owner: r.fnskuOwner) }
            }
            return
        }

        if let p = r.pick {
            if !silent { speak(r.voiceSay ?? p.say) }
            localStore.upsertSession(sessionId: id, code: e?.code ?? r.fnsku, fnsku: r.fnsku, productId: p.id, status: "working", card: p)
            update(id) { $0.state = .matched(p, registeredNew: false) }
        } else if !r.candidates.isEmpty {
            let prompt = r.candidates.count > 1 ? "候補が複数あります。確認してください" : (r.voiceSay ?? "候補があります。確認してください")
            if !silent { speak(prompt) }
            localStore.upsertSession(sessionId: id, code: e?.code ?? r.fnsku, fnsku: r.fnsku, status: "unresolved")
            update(id) { $0.state = .choose(r.candidates, owner: r.fnskuOwner) }
        } else {
            if !silent { speak(r.voiceSay ?? "未登録の商品です。手動検索または新規登録できます") }
            localStore.upsertSession(sessionId: id, code: e?.code ?? r.fnsku, fnsku: r.fnsku, status: "unresolved")
            update(id) { $0.state = .unregistered(draft) }
            // Gate 3: NEVER auto-navigate while editing or when another modal is open.
        }
    }

    // MARK: - Part 4 (T-013): Strict 1-Record-1-FNSKU Guard & Branching

    func fnskuGuardState(entry: Entry, card: Card) -> FnskuGuardState {
        let scanned = entry.fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let registered = card.fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if scanned.isEmpty {
            return .unverifiedNoFnsku
        }
        if let owner = entry.fnskuOwner, owner.id != card.id {
            return .ownedByOther(owner: owner)
        }
        if let localOwner = localStore.cachedCard(forFnsku: scanned), localOwner.id != card.id {
            return .ownedByOther(owner: localOwner)
        }
        if !registered.isEmpty && registered != scanned {
            return .differentFnsku(scanned: scanned, registered: registered)
        }
        if registered.isEmpty {
            return .assignNewFnsku(scanned: scanned)
        }
        return .exactMatch(fnsku: scanned)
    }

    /// Selecting a candidate keeps ScanSession drafts intact and enforces Part 4 FNSKU guard.
    func choose(_ id: UUID, _ c: Card) {
        guard let e = entries.first(where: { $0.id == id }) else { return }
        let scanned = e.fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let registered = c.fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

        // Rule (a): Scanned FNSKU belongs to another product -> switch to or warn about owner.
        if !scanned.isEmpty, let owner = e.fnskuOwner ?? localStore.cachedCard(forFnsku: scanned), owner.id != c.id {
            update(id) {
                $0.fnskuOwner = owner
                $0.state = .matched(c, registeredNew: false)
            }
            return
        }

        // Rule (c): Unregistered FNSKU x product with different registered FNSKU -> open 4-choice branch sheet!
        if !scanned.isEmpty && !registered.isEmpty && registered != scanned {
            openFnskuBranch(entryId: id, card: c, scannedFnsku: scanned)
            return
        }

        let alreadyRegistered = !registered.isEmpty && registered == scanned
        speak(alreadyRegistered ? "登録済みの商品です。\(c.say)" : c.say)
        localStore.upsertSession(
            sessionId: id,
            code: e.code,
            fnsku: scanned,
            productId: c.id,
            status: "working",
            conditionNoteDraft: e.conditionNoteDraft,
            aiInstructionDraft: e.aiInstructionDraft,
            card: c
        )
        update(id) {
            $0.state = alreadyRegistered ? .registered(c) : .matched(c, registeredNew: false)
        }
    }

    func switchEntryToOwner(entryId: UUID, owner: Card) {
        guard let e = entries.first(where: { $0.id == entryId }) else { return }
        localStore.upsertSession(
            sessionId: entryId,
            code: e.code,
            fnsku: owner.fnsku.isEmpty ? e.fnsku : owner.fnsku,
            productId: owner.id,
            status: "working",
            conditionNoteDraft: e.conditionNoteDraft,
            aiInstructionDraft: e.aiInstructionDraft,
            card: owner
        )
        update(entryId) {
            $0.fnskuOwner = owner
            $0.state = .registered(owner)
        }
        speak("登録済みの商品です。\(owner.say)")
    }

    func openFnskuBranch(entryId: UUID, card: Card, scannedFnsku: String) {
        addPauseReason(.fnskuBranchSheet)
        fnskuBranchTarget = FnskuBranchTarget(entryId: entryId, card: card, scannedFnsku: scannedFnsku)
    }

    func openNewRegistrationFromBranch(entryId: UUID, fnsku: String, referenceName: String) {
        let existing = entries.first(where: { $0.id == entryId })
        let draft = ScanDraft(
            fnsku: fnsku,
            jan: existing?.draft?.jan ?? "",
            name: referenceName.isEmpty ? (existing?.draft?.name ?? "") : referenceName,
            lines: existing?.draft?.lines ?? []
        )
        addPauseReason(.registerSheet)
        let action: () -> Void = { [weak self] in
            self?.registerTarget = RegisterTarget(id: entryId, draft: draft)
        }
        if fnskuBranchTarget != nil {
            pendingTransition = action
            fnskuBranchTarget = nil
        } else {
            action()
        }
    }

    func rescanFromBranch(entryId: UUID) {
        discardEntry(entryId)
        armOneShotNextScan()
    }

    func correctProductFnsku(entryId: UUID, productId: String, newFnsku: String, reason: String) async throws {
        let opId = UUID().uuidString
        let res = try await Api.correctFnsku(id: productId, newFnsku: newFnsku, reason: reason, operationId: opId)
        let updatedCard = res.product.toCard()
        localStore.cacheCard(updatedCard)
        localStore.upsertCatalogItem(from: updatedCard, rev: res.product.rev)
        refreshCatalogFromStore()
        if let e = entries.first(where: { $0.id == entryId }) {
            localStore.upsertSession(
                sessionId: entryId,
                code: e.code,
                fnsku: newFnsku,
                productId: updatedCard.id,
                status: "working",
                conditionNoteDraft: e.conditionNoteDraft,
                aiInstructionDraft: e.aiInstructionDraft,
                card: updatedCard
            )
            update(entryId) {
                $0.fnsku = newFnsku
                $0.fnskuOwner = updatedCard
                $0.state = .registered(updatedCard)
            }
        }
        showNoticeBanner("FNSKU を \(newFnsku) に訂正しました", productId: productId, productName: updatedCard.name)
    }

    // MARK: - Stage 1 & 2 Actions: Confirm / No-Sell / Discard / Memos

    /// Save locally to SwiftData, bind any session manual photos, enqueue SyncOperations, and immediately advance.
    func confirmAndNext(_ id: UUID) {
        guard let e = entries.first(where: { $0.id == id }), let card = e.currentCard else { return }
        let guardState = fnskuGuardState(entry: e, card: card)
        switch guardState {
        case .ownedByOther:
            return
        case .differentFnsku(let scanned, _):
            openFnskuBranch(entryId: id, card: card, scannedFnsku: scanned)
            return
        case .assignNewFnsku, .exactMatch, .unverifiedNoFnsku:
            break
        }
        localStore.bindSessionManualPhotos(sessionId: e.id, toProductId: card.id)
        enqueueConfirmationOperations(entry: e, card: card, markNoSell: false)
        finishEntryToHistory(entry: e, updatedCard: optimisticCard(from: card, entry: e, decision: nil))
        startPostActionCooldown()
        Task {
            await flushSyncQueue()
            await flushManualPhotoUploads()
        }
    }

    /// Update stockCheckedAt + set decision='no_sell', advance immediately, and show 3-second undo toast.
    func markNoSellAndNext(_ id: UUID) {
        guard let e = entries.first(where: { $0.id == id }), let card = e.currentCard else { return }
        let guardState = fnskuGuardState(entry: e, card: card)
        switch guardState {
        case .ownedByOther:
            return
        case .differentFnsku(let scanned, _):
            openFnskuBranch(entryId: id, card: card, scannedFnsku: scanned)
            return
        case .assignNewFnsku, .exactMatch, .unverifiedNoFnsku:
            break
        }
        let prevDecision = card.decision ?? "undecided"
        localStore.bindSessionManualPhotos(sessionId: e.id, toProductId: card.id)
        enqueueConfirmationOperations(entry: e, card: card, markNoSell: true)
        let updated = optimisticCard(from: card, entry: e, decision: "no_sell")
        finishEntryToHistory(entry: e, updatedCard: updated)
        showUndoToast(sessionId: e.id, productId: card.id, productName: card.short, previousDecision: prevDecision)
        startPostActionCooldown()
        Task {
            await flushSyncQueue()
            await flushManualPhotoUploads()
        }
    }

    /// Part 2: Explicit Discard (distinct from Close). Deletes SwiftData ScanSession & uncommitted local session photos.
    /// NEVER deletes synced server data.
    func discardEntry(_ id: UUID) {
        activeJobs.removeValue(forKey: id)
        discardedEntryIds.insert(id)
        entries.removeAll { $0.id == id }
        localStore.deleteSession(id)
        localStore.deleteLocalManualPhotos(forSessionId: id)
        startPostActionCooldown()
        refreshPersistedViews()
    }

    func discardAllTodayEntries() {
        for e in todayEntries {
            discardEntry(e.id)
        }
    }

    func undoNoSellToast() {
        guard let t = undoToast else { return }
        toastTask?.cancel()
        undoToast = nil
        localStore.revertDecision(productId: t.productId, to: t.previousDecision, sessionId: t.sessionId)
        if let cached = localStore.cachedCard(id: t.productId) {
            let reverted = cached.updating(decision: .some(t.previousDecision))
            localStore.cacheCard(reverted)
            localStore.upsertSession(sessionId: t.sessionId, code: "", fnsku: reverted.fnsku, productId: reverted.id, status: "pendingSync", card: reverted)
        }
        refreshPersistedViews()
        speak("元に戻しました")
        Task { await flushSyncQueue() }
    }

    private func showUndoToast(sessionId: UUID, productId: String, productName: String, previousDecision: String) {
        toastTask?.cancel()
        undoToast = UndoToast(sessionId: sessionId, productId: productId, productName: productName, previousDecision: previousDecision)
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.undoToast = nil
        }
    }

    func showNoticeBanner(_ message: String, productId: String? = nil, productName: String = "") {
        noticeTask?.cancel()
        noticeBanner = NoticeBanner(message: message, productId: productId, productName: productName)
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self?.noticeBanner = nil
        }
    }

    private func enqueueConfirmationOperations(entry: Entry, card: Card, markNoSell: Bool) {
        let taken = entry.photo?.takenAt ?? entry.at
        let presence = markNoSell ? true : Calendar.current.isDateInToday(taken)
        let confirmPayload = ConfirmScanPayload(
            fnsku: entry.fnsku,
            presence: presence,
            scannedAt: taken,
            operationId: UUID().uuidString
        )
        localStore.enqueue(sessionId: entry.id, productId: card.id, kind: "confirmScan", payload: confirmPayload)

        if markNoSell {
            localStore.enqueue(sessionId: entry.id, productId: card.id, kind: "decision", payload: DecisionPayload(decision: "no_sell"))
        }

        let appendCond = entry.conditionNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let appendAi = entry.aiInstructionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let setCond = entry.fullEditConditionNote
        let setAi = entry.fullEditAiInstruction
        if setCond != nil || setAi != nil || !appendCond.isEmpty || !appendAi.isEmpty {
            let memoPayload = PatchNotesPayload(
                setConditionNote: setCond,
                setAiInstruction: setAi,
                appendConditionNote: appendCond.isEmpty ? nil : appendCond,
                appendAiInstruction: appendAi.isEmpty ? nil : appendAi
            )
            localStore.enqueue(sessionId: entry.id, productId: card.id, kind: "patchNotes", payload: memoPayload)
        }

        if let photo = entry.photo {
            let fileKey = UUID()
            if let fileName = localStore.savePhotoFile(photo, opKey: fileKey) {
                let pPayload = UploadPhotoPayload(
                    fileName: fileName,
                    clientId: "scan:\(photo.digest)",
                    takenAt: photo.takenAt,
                    width: photo.width,
                    height: photo.height,
                    digest: photo.digest
                )
                localStore.enqueue(sessionId: entry.id, productId: card.id, kind: "uploadPhoto", payload: pPayload)
            }
        }
    }

    private func optimisticCard(from card: Card, entry: Entry, decision: String?) -> Card {
        let mergedCond: String = {
            if let full = entry.fullEditConditionNote { return full }
            let add = entry.conditionNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if add.isEmpty { return card.conditionNote ?? "" }
            let cur = card.conditionNote ?? ""
            return cur.isEmpty ? add : "\(cur)\n\(add)"
        }()
        let mergedAi: String = {
            if let full = entry.fullEditAiInstruction { return full }
            let add = entry.aiInstructionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            if add.isEmpty { return card.aiInstruction ?? "" }
            let cur = card.aiInstruction ?? ""
            return cur.isEmpty ? add : "\(cur)\n\(add)"
        }()
        let nextFnsku = card.fnsku.isEmpty && entry.fnsku.uppercased().hasPrefix("X00") ? entry.fnsku.uppercased() : card.fnsku
        let taken = entry.photo?.takenAt ?? entry.at
        let nextPresence = (decision == "no_sell" || Calendar.current.isDateInToday(taken)) ? "have" : card.presence
        let scanIso = ISO8601DateFormatter().string(from: taken)
        return card.updating(
            fnsku: nextFnsku,
            presence: .some(nextPresence),
            decision: decision.map { .some($0) },
            conditionNote: mergedCond,
            aiInstruction: mergedAi,
            lastScanAt: .some(scanIso)
        )
    }

    private func finishEntryToHistory(entry: Entry, updatedCard: Card) {
        activeJobs.removeValue(forKey: entry.id)
        localStore.upsertSession(
            sessionId: entry.id,
            code: entry.code,
            fnsku: entry.fnsku,
            productId: updatedCard.id,
            status: "pendingSync",
            conditionNoteDraft: "",
            aiInstructionDraft: "",
            card: updatedCard,
            photoDigest: entry.photo?.digest
        )
        entries.removeAll { $0.id == entry.id }
        refreshPersistedViews()
        refreshCatalogFromStore()
    }

    /// Save draft memos on an active ScanSession (survives candidate selection & force-quit).
    func saveEntryMemos(entryId: UUID, appendCondition: String, appendAi: String, setCondition: String?, setAi: String?) {
        update(entryId) {
            if let setCondition {
                $0.fullEditConditionNote = setCondition
                $0.conditionNoteDraft = ""
            } else {
                $0.conditionNoteDraft = appendCondition
            }
            if let setAi {
                $0.fullEditAiInstruction = setAi
                $0.aiInstructionDraft = ""
            } else {
                $0.aiInstructionDraft = appendAi
            }
        }
        if let e = entries.first(where: { $0.id == entryId }) {
            localStore.updateDrafts(sessionId: entryId, conditionNoteDraft: e.conditionNoteDraft, aiInstructionDraft: e.aiInstructionDraft)
        }
    }

    /// Save memo edits directly from Product Detail or History via the offline-safe SyncOperation queue.
    func saveDirectMemos(card: Card, sessionId: UUID?, appendCondition: String, appendAi: String, setCondition: String?, setAi: String?) {
        let cleanAppendCond = appendCondition.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanAppendAi = appendAi.trimmingCharacters(in: .whitespacesAndNewlines)
        guard setCondition != nil || setAi != nil || !cleanAppendCond.isEmpty || !cleanAppendAi.isEmpty else { return }

        let payload = PatchNotesPayload(
            setConditionNote: setCondition,
            setAiInstruction: setAi,
            appendConditionNote: cleanAppendCond.isEmpty ? nil : cleanAppendCond,
            appendAiInstruction: cleanAppendAi.isEmpty ? nil : cleanAppendAi
        )
        localStore.enqueue(sessionId: sessionId, productId: card.id, kind: "patchNotes", payload: payload)

        let nextCond: String = {
            if let setCondition { return setCondition }
            if cleanAppendCond.isEmpty { return card.conditionNote ?? "" }
            let cur = card.conditionNote ?? ""
            return cur.isEmpty ? cleanAppendCond : "\(cur)\n\(cleanAppendCond)"
        }()
        let nextAi: String = {
            if let setAi { return setAi }
            if cleanAppendAi.isEmpty { return card.aiInstruction ?? "" }
            let cur = card.aiInstruction ?? ""
            return cur.isEmpty ? cleanAppendAi : "\(cur)\n\(cleanAppendAi)"
        }()
        let updated = card.updating(conditionNote: nextCond, aiInstruction: nextAi)
        localStore.cacheCard(updated)
        if let sessionId {
            localStore.upsertSession(sessionId: sessionId, code: "", fnsku: updated.fnsku, productId: updated.id, status: "pendingSync", card: updated)
        }
        if detailTarget?.card.id == card.id {
            detailTarget = DetailTarget(card: updated, localPhoto: detailTarget?.localPhoto, sessionId: sessionId)
        }
        refreshPersistedViews()
        Task { await flushSyncQueue() }
    }

    // MARK: - Part 5 (T-010-4 + Post-Registration Manual Real Photos)

    func manualPhotoCount(forProductId productId: String?, sessionId: UUID?) -> Int {
        var ids = Set<UUID>()
        if let pid = productId, !pid.isEmpty {
            for p in localStore.manualPhotos(forProductId: pid) { ids.insert(p.clientPhotoId) }
        }
        if let sid = sessionId {
            for p in localStore.manualPhotos(forSessionId: sid) { ids.insert(p.clientPhotoId) }
        }
        return ids.count
    }

    func openManualPhotoChoice(productId: String, sessionId: UUID?, productName: String, thumbPath: String?) {
        manualPhotoChoiceTarget = ManualPhotoTarget(productId: productId, sessionId: sessionId, productName: productName, thumbPath: thumbPath)
    }

    func openManualCapture(_ target: ManualPhotoTarget) {
        addPauseReason(.manualCapture)
        manualCaptureTarget = target
    }

    func openManualLibraryPicker(_ target: ManualPhotoTarget) {
        addPauseReason(.manualLibraryPicker)
        manualPickerTarget = target
    }

    func openPhotoSelection(productId: String, productName: String) {
        addPauseReason(.photoSelectionSheet)
        photoSelectionTarget = PhotoSelectionTarget(productId: productId, productName: productName)
    }

    /// Save a single processed manual real photo to LocalPhoto (NEVER touches ScanSession, stockCheckedAt, memos, or FNSKU).
    func saveManualPhoto(
        productId: String,
        sessionId: UUID?,
        batchId: UUID,
        source: String,
        processed: ProcessedManualPhoto
    ) throws -> LocalPhoto {
        let rec = try localStore.createManualPhoto(
            productId: productId,
            sessionId: sessionId,
            batchId: batchId,
            source: source,
            processed: processed
        )
        refreshPersistedViews()
        if !productId.isEmpty {
            Task { await flushManualPhotoUploads() }
        }
        return rec
    }

    /// Import picked library files 1-by-1 (ImageIO 2000px JPEG 0.82 metadata stripped), clean temp dir, show summary.
    func importManualLibraryFiles(target: ManualPhotoTarget, urls: [URL], initialFailCount: Int) async {
        let batchId = UUID()
        var okCount = 0
        var failCount = initialFailCount
        var storageError = ""

        for url in urls {
            let processed = await Task.detached(priority: .userInitiated) {
                PhotoTools.processManualPhoto(fileURL: url)
            }.value
            try? FileManager.default.removeItem(at: url)
            guard let processed else {
                failCount += 1
                continue
            }
            do {
                _ = try localStore.createManualPhoto(
                    productId: target.productId,
                    sessionId: target.sessionId,
                    batchId: batchId,
                    source: "manual_library",
                    processed: processed
                )
                okCount += 1
            } catch {
                failCount += 1
                storageError = error.localizedDescription
            }
        }
        if let dir = urls.first?.deletingLastPathComponent() {
            try? FileManager.default.removeItem(at: dir)
        }
        refreshPersistedViews()

        if okCount > 0 && failCount == 0 {
            showNoticeBanner("\(okCount)枚追加しました（未選別）", productId: target.productId.isEmpty ? nil : target.productId, productName: target.productName)
        } else if okCount > 0 && failCount > 0 {
            showNoticeBanner("\(okCount)枚追加・\(failCount)枚失敗（未選別）", productId: target.productId.isEmpty ? nil : target.productId, productName: target.productName)
        } else if !storageError.isEmpty {
            showNoticeBanner(storageError)
        } else if failCount > 0 {
            showNoticeBanner("写真の読み込みに失敗しました（\(failCount)枚）")
        }

        if okCount > 0 && !target.productId.isEmpty {
            await flushManualPhotoUploads()
        }
    }

    /// Toggle adoption on a manual or server actual photo.
    /// Strict ordering: if local photo isn't uploaded yet, set pendingAdoptionSync=true and only send PATCH after upload succeeds.
    func setManualPhotoAdopted(productId: String, localPhoto: LocalPhoto?, serverPhotoId: String?, adopted: Bool) {
        if let lp = localPhoto {
            lp.isAdopted = adopted
            lp.reviewed = true
            if let sid = lp.serverPhotoId ?? serverPhotoId {
                lp.pendingAdoptionSync = true
                localStore.save()
                enqueuePhotoAdoption(productId: productId, clientPhotoId: lp.clientPhotoId.uuidString, serverPhotoId: sid, adopted: adopted)
            } else {
                // Not uploaded yet: record intent locally; flushManualPhotoUploads will enqueue after upload completes.
                lp.pendingAdoptionSync = true
                localStore.save()
            }
        } else if let sid = serverPhotoId {
            enqueuePhotoAdoption(productId: productId, clientPhotoId: "", serverPhotoId: sid, adopted: adopted)
        }
        refreshPersistedViews()
        Task { await flushSyncQueue() }
    }

    private func enqueuePhotoAdoption(productId: String, clientPhotoId: String, serverPhotoId: String, adopted: Bool) {
        let payload = SetPhotoAdoptedPayload(clientPhotoId: clientPhotoId, serverPhotoId: serverPhotoId, adopted: adopted)
        localStore.enqueue(sessionId: nil, productId: productId, kind: "setPhotoAdopted", payload: payload)
    }

    /// Background manual photo uploader (keeps concurrency bounded to 1-2, deletes local original only after confirmed upload).
    func flushManualPhotoUploads() async {
        guard !isUploadingPhotos, isOnline else { return }
        let queue = localStore.pendingManualPhotos()
        guard !queue.isEmpty else { return }
        isUploadingPhotos = true
        defer {
            isUploadingPhotos = false
            refreshPersistedViews()
        }

        for ph in queue {
            guard !ph.productId.isEmpty else { continue }
            let origURL = localStore.manualPhotoOriginalURL(ph)
            let thumbURL = localStore.manualPhotoThumbURL(ph)
            guard let origData = try? Data(contentsOf: origURL),
                  let thumbData = try? Data(contentsOf: thumbURL) else {
                ph.uploadState = "needsAttention"
                ph.lastError = "アップロード元ファイルが見つかりません"
                localStore.save()
                continue
            }
            ph.uploadState = "uploading"
            localStore.save()

            do {
                let res = try await Api.uploadManualPhoto(
                    id: ph.productId,
                    jpegData: origData,
                    thumbData: thumbData,
                    source: ph.source,
                    clientPhotoId: ph.clientPhotoId.uuidString,
                    width: ph.width,
                    height: ph.height,
                    takenAt: ph.createdAt
                )
                localStore.markManualPhotoUploaded(ph, serverPhotoId: res.photo.id)
                // Strict order: send deferred adoption PATCH only after upload succeeded and serverPhotoId is known.
                if ph.pendingAdoptionSync {
                    enqueuePhotoAdoption(
                        productId: ph.productId,
                        clientPhotoId: ph.clientPhotoId.uuidString,
                        serverPhotoId: res.photo.id,
                        adopted: ph.isAdopted
                    )
                    ph.pendingAdoptionSync = false
                    localStore.save()
                    Task { await flushSyncQueue() }
                }
                refreshPersistedViews()
            } catch let err as ApiError where err.statusCode == 404 || err.statusCode == 409 || err.isPermanentClientError {
                ph.uploadState = "needsAttention"
                ph.lastError = err.message
                localStore.save()
                refreshPersistedViews()
            } catch {
                ph.uploadState = "pending"
                ph.lastError = error.localizedDescription
                localStore.save()
                break
            }
        }
    }

    // MARK: - Part 6 (T-011): Listing Title & Description Editing

    func openListingEditor(productId: String, productName: String) {
        addPauseReason(.listingEditSheet)
        listingEditTarget = ListingEditTarget(productId: productId, productName: productName)
    }

    func refreshListingDraftFromServer(productId: String) async -> ListingDraft? {
        do {
            let detail = try await Api.fetchProductDetail(id: productId)
            let serverTitle = detail.listing?.title ?? ""
            let serverDesc = detail.listing?.description ?? ""
            let draft = localStore.upsertListingDraft(
                productId: productId,
                serverTitle: serverTitle,
                serverDesc: serverDesc,
                rev: detail.rev,
                hasJmtyOverride: detail.hasJmtyOverride ?? false
            )
            let card = detail.toCard()
            localStore.cacheCard(card)
            localStore.upsertCatalogItem(from: card, rev: detail.rev)
            refreshCatalogFromStore()
            refreshPersistedViews()
            return draft
        } catch {
            return localStore.fetchListingDraft(productId: productId)
        }
    }

    func updateListingDraftLocal(productId: String, title: String, description: String) {
        let draft = localStore.fetchListingDraft(productId: productId) ?? localStore.upsertListingDraft(
            productId: productId,
            serverTitle: "",
            serverDesc: "",
            rev: localStore.catalog.first(where: { $0.productId == productId })?.rev ?? 1,
            hasJmtyOverride: false
        )
        if draft.titleLocalValue != title {
            draft.titleLocalValue = title
            draft.titleGeneration += 1
            draft.titleDirty = (title != draft.titleBaseValue)
            if title.utf16.count > 40 {
                draft.titleSyncState = "overflow"
            } else if draft.titleSyncState != "conflict" {
                draft.titleSyncState = draft.titleDirty ? "draft" : "synced"
            }
        }
        if draft.descLocalValue != description {
            draft.descLocalValue = description
            draft.descGeneration += 1
            draft.descDirty = (description != draft.descBaseValue)
            if description.utf16.count > 1000 {
                draft.descSyncState = "overflow"
            } else if draft.descSyncState != "conflict" {
                draft.descSyncState = draft.descDirty ? "draft" : "synced"
            }
        }
        draft.updatedAt = Date()
        localStore.save()
        refreshPersistedViews()
    }

    func enqueueListingDraftSync(productId: String) {
        guard let draft = localStore.fetchListingDraft(productId: productId) else { return }
        // Never overwrite an unresolved 409 conflict silently.
        let canSendTitle = draft.titleDirty && draft.titleLocalValue.utf16.count <= 40 && draft.titleSyncState != "conflict"
        let canSendDesc = draft.descDirty && draft.descLocalValue.utf16.count <= 1000 && draft.descSyncState != "conflict"
        guard canSendTitle || canSendDesc else { return }

        let expectedRev = canSendTitle ? draft.titleBaseRev : draft.descBaseRev
        let payload = PatchListingTextPayload(
            title: canSendTitle ? draft.titleLocalValue : nil,
            description: canSendDesc ? draft.descLocalValue : nil,
            expectedRev: expectedRev,
            titleGeneration: canSendTitle ? draft.titleGeneration : nil,
            descGeneration: canSendDesc ? draft.descGeneration : nil
        )
        if canSendTitle { draft.titleSyncState = "syncing" }
        if canSendDesc { draft.descSyncState = "syncing" }
        localStore.save()
        localStore.enqueue(sessionId: nil, productId: productId, kind: "patchListingText", payload: payload)
        refreshPersistedViews()
        Task { await flushSyncQueue() }
    }

    func resolveListingConflictOverwrite(productId: String, newBaseRev: Int, title: String, desc: String) {
        guard let draft = localStore.fetchListingDraft(productId: productId) else { return }
        draft.titleBaseRev = newBaseRev
        draft.descBaseRev = newBaseRev
        draft.serverConflictRev = nil
        draft.serverConflictTitle = nil
        draft.serverConflictDesc = nil
        draft.titleLocalValue = title
        draft.descLocalValue = desc
        draft.titleDirty = (title != draft.titleBaseValue)
        draft.descDirty = (desc != draft.descBaseValue)
        draft.titleGeneration += 1
        draft.descGeneration += 1
        draft.titleSyncState = title.utf16.count > 40 ? "overflow" : (draft.titleDirty ? "draft" : "synced")
        draft.descSyncState = desc.utf16.count > 1000 ? "overflow" : (draft.descDirty ? "draft" : "synced")
        localStore.save()
        enqueueListingDraftSync(productId: productId)
        refreshPersistedViews()
    }

    func resolveListingConflictUseServer(productId: String) {
        guard let draft = localStore.fetchListingDraft(productId: productId) else { return }
        let rev = draft.serverConflictRev ?? draft.titleBaseRev
        if let ct = draft.serverConflictTitle {
            draft.titleBaseValue = ct
            draft.titleLocalValue = ct
        }
        if let cd = draft.serverConflictDesc {
            draft.descBaseValue = cd
            draft.descLocalValue = cd
        }
        draft.titleBaseRev = rev
        draft.descBaseRev = rev
        draft.titleDirty = false
        draft.descDirty = false
        draft.titleSyncState = "synced"
        draft.descSyncState = "synced"
        draft.serverConflictRev = nil
        draft.serverConflictTitle = nil
        draft.serverConflictDesc = nil
        localStore.save()
        refreshPersistedViews()
    }

    // MARK: - Part 7 (T-014): Manual Product Search & Catalog Sync

    func refreshCatalogFromStore() {
        catalogItems = localStore.catalog
    }

    func refreshCatalog() async {
        guard !isRefreshingCatalog else { return }
        isRefreshingCatalog = true
        defer { isRefreshingCatalog = false }
        do {
            let summaries = try await Api.fetchCatalog()
            localStore.replaceCatalogSnapshot(summaries)
            refreshCatalogFromStore()
        } catch {
            // Keep existing local snapshot offline; never wipe search data on fetch error.
        }
    }

    func openSearch(purpose: SearchPurpose) {
        addPauseReason(.searchSheet)
        searchTarget = SearchTarget(purpose: purpose)
        if catalogItems.isEmpty {
            Task { await refreshCatalog() }
        }
    }

    func applySearchSelection(purpose: SearchPurpose, liveDetail: ProductDetail, card: Card, fromSimilarCode: Bool) {
        switch purpose {
        case .openDetail:
            addPauseReason(.detailSheet)
            let open: () -> Void = { [weak self] in
                self?.detailTarget = DetailTarget(card: card, localPhoto: nil, sessionId: nil)
            }
            if searchTarget != nil {
                pendingTransition = open
                searchTarget = nil
            } else {
                open()
            }

        case .addPhoto:
            let open: () -> Void = { [weak self] in
                self?.openManualPhotoChoice(productId: card.id, sessionId: nil, productName: card.name, thumbPath: card.official ?? card.thumb)
            }
            if searchTarget != nil {
                pendingTransition = open
                searchTarget = nil
            } else {
                open()
            }

        case .matchScan(let entryId, let scannedFnsku):
            let cleanScanned = scannedFnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            let cleanLive = (liveDetail.fnsku ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            // Strict Part 4 guard: never treat similar-code or different FNSKU as an exact match!
            if !cleanScanned.isEmpty && !cleanLive.isEmpty && cleanLive != cleanScanned {
                addPauseReason(.fnskuBranchSheet)
                let openBranch: () -> Void = { [weak self] in
                    self?.fnskuBranchTarget = FnskuBranchTarget(entryId: entryId, card: card, scannedFnsku: cleanScanned)
                }
                if searchTarget != nil {
                    pendingTransition = openBranch
                    searchTarget = nil
                } else {
                    openBranch()
                }
            } else if fromSimilarCode && !cleanScanned.isEmpty && cleanLive != cleanScanned {
                addPauseReason(.fnskuBranchSheet)
                let openBranch: () -> Void = { [weak self] in
                    self?.fnskuBranchTarget = FnskuBranchTarget(entryId: entryId, card: card, scannedFnsku: cleanScanned)
                }
                if searchTarget != nil {
                    pendingTransition = openBranch
                    searchTarget = nil
                } else {
                    openBranch()
                }
            } else {
                choose(entryId, card)
            }
        }
    }

    func openNewRegistrationFromSearch(entryId: UUID, fnsku: String, jan: String, name: String) {
        let existing = entries.first(where: { $0.id == entryId })
        let draft = ScanDraft(
            fnsku: fnsku,
            jan: jan.isEmpty ? (existing?.draft?.jan ?? "") : jan,
            name: name.isEmpty ? (existing?.draft?.name ?? "") : name,
            lines: existing?.draft?.lines ?? []
        )
        addPauseReason(.registerSheet)
        let open: () -> Void = { [weak self] in
            self?.registerTarget = RegisterTarget(id: entryId, draft: draft)
        }
        if searchTarget != nil {
            pendingTransition = open
            searchTarget = nil
        } else {
            open()
        }
    }

    // MARK: - Background Sync Queue Worker

    func flushSyncQueue() async {
        guard !isSyncing else { return }
        let ops = localStore.pendingOperations()
        guard !ops.isEmpty else {
            refreshPersistedViews()
            return
        }
        isSyncing = true
        defer {
            isSyncing = false
            refreshPersistedViews()
        }

        for op in ops {
            do {
                try await executeSyncOp(op)
                localStore.completeOperation(op)
                refreshPersistedViews()
            } catch let err as ApiError where err.statusCode == 409 && op.kind == "patchListingText" {
                handleListingConflict(op: op, err: err)
                localStore.completeOperation(op)
                refreshPersistedViews()
            } catch let err as ApiError where err.statusCode == 409 || err.statusCode == 404 || err.isPermanentClientError {
                // Part 4: Offline 409 (FNSKU_OWNED_BY_OTHER / PRODUCT_HAS_DIFFERENT_FNSKU / etc.) -> needsAttention (NO overwrite, NO infinite retry)
                localStore.markOperationNeedsAttention(op, error: err.message)
                refreshPersistedViews()
            } catch {
                localStore.markAttemptFailed(op, error: error.localizedDescription, permanent: false)
                break
            }
        }
    }

    func retryFailedSync() {
        localStore.retryFailedOperations()
        for ph in localStore.allLocalPhotos() where ph.uploadState == "failed" {
            ph.uploadState = "pending"
        }
        localStore.save()
        refreshPersistedViews()
        Task {
            await flushSyncQueue()
            await flushManualPhotoUploads()
        }
    }

    func deleteAttentionOperation(_ op: SyncOperation) {
        localStore.completeOperation(op)
        refreshPersistedViews()
    }

    private func handleListingConflict(op: SyncOperation, err: ApiError) {
        guard let draft = localStore.fetchListingDraft(productId: op.productId) else { return }
        let payload = try? JSONDecoder().decode(PatchListingTextPayload.self, from: op.payloadJson)
        draft.serverConflictRev = err.currentRev ?? (draft.titleBaseRev + 1)
        draft.serverConflictTitle = err.currentTitle
        draft.serverConflictDesc = err.currentDescription
        if payload?.title != nil { draft.titleSyncState = "conflict" }
        if payload?.description != nil { draft.descSyncState = "conflict" }
        localStore.save()
        showNoticeBanner("出品文の同期を保留しました（要確認）", productId: op.productId, productName: localStore.cachedCard(id: op.productId)?.name ?? "")
    }

    private func executeSyncOp(_ op: SyncOperation) async throws {
        switch op.kind {
        case "confirmScan":
            let p = try JSONDecoder().decode(ConfirmScanPayload.self, from: op.payloadJson)
            let card = try await Api.confirm(id: op.productId, fnsku: p.fnsku, presence: p.presence, scannedAt: p.scannedAt, operationId: p.operationId)
            localStore.cacheCard(card)
            if let sid = op.sessionId {
                localStore.upsertSession(sessionId: sid, code: "", fnsku: card.fnsku, productId: card.id, status: "pendingSync", card: card)
            }

        case "decision":
            let p = try JSONDecoder().decode(DecisionPayload.self, from: op.payloadJson)
            try await Api.setDecision(id: op.productId, decision: p.decision)
            if let cached = localStore.cachedCard(id: op.productId) {
                let updated = cached.updating(decision: .some(p.decision))
                localStore.cacheCard(updated)
                if let sid = op.sessionId {
                    localStore.upsertSession(sessionId: sid, code: "", fnsku: updated.fnsku, productId: updated.id, status: "pendingSync", card: updated)
                }
            }

        case "patchNotes":
            let p = try JSONDecoder().decode(PatchNotesPayload.self, from: op.payloadJson)
            var setDict: [String: String] = [:]
            var appendDict: [String: String] = [:]
            if let s = p.setConditionNote { setDict["conditionNote"] = s }
            if let s = p.setAiInstruction { setDict["aiInstruction"] = s }
            if let a = p.appendConditionNote, !a.isEmpty { appendDict["conditionNote"] = a }
            if let a = p.appendAiInstruction, !a.isEmpty { appendDict["aiInstruction"] = a }
            let serverNotes = try await Api.patchProduct(
                id: op.productId,
                set: setDict.isEmpty ? nil : setDict,
                append: appendDict.isEmpty ? nil : appendDict
            )
            if let cached = localStore.cachedCard(id: op.productId) {
                let updated = cached.updating(conditionNote: serverNotes.conditionNote, aiInstruction: serverNotes.aiInstruction)
                localStore.cacheCard(updated)
                if let sid = op.sessionId {
                    localStore.upsertSession(sessionId: sid, code: "", fnsku: updated.fnsku, productId: updated.id, status: "pendingSync", card: updated)
                }
            }

        case "patchListingText":
            let p = try JSONDecoder().decode(PatchListingTextPayload.self, from: op.payloadJson)
            var setDict: [String: String] = [:]
            if let t = p.title { setDict["listing.title"] = t }
            if let d = p.description { setDict["listing.description"] = d }
            guard !setDict.isEmpty else { return }
            let res = try await Api.patchProduct(id: op.productId, set: setDict, expectedRev: p.expectedRev)
            if let draft = localStore.fetchListingDraft(productId: op.productId) {
                let newRev = res.rev ?? (p.expectedRev + 1)
                // Generation guard: only clear dirty flag if user didn't edit again while request was in flight!
                if let sentTitle = p.title {
                    draft.titleBaseValue = res.title ?? sentTitle
                    draft.titleBaseRev = newRev
                    if draft.titleGeneration == p.titleGeneration {
                        draft.titleDirty = false
                        draft.titleSyncState = "synced"
                    }
                } else if !draft.titleDirty {
                    draft.titleBaseRev = newRev
                }
                if let sentDesc = p.description {
                    draft.descBaseValue = res.description ?? sentDesc
                    draft.descBaseRev = newRev
                    if draft.descGeneration == p.descGeneration {
                        draft.descDirty = false
                        draft.descSyncState = "synced"
                    }
                } else if !draft.descDirty {
                    draft.descBaseRev = newRev
                }
                localStore.save()
            }

        case "setPhotoAdopted":
            let p = try JSONDecoder().decode(SetPhotoAdoptedPayload.self, from: op.payloadJson)
            guard let sid = p.serverPhotoId, !sid.isEmpty else { return }
            _ = try await Api.setPhotoAdopted(id: op.productId, photoId: sid, adopted: p.adopted)
            if let uuid = UUID(uuidString: p.clientPhotoId),
               let lp = localStore.allLocalPhotos().first(where: { $0.clientPhotoId == uuid }) {
                lp.pendingAdoptionSync = false
                localStore.save()
            }

        case "uploadPhoto":
            let p = try JSONDecoder().decode(UploadPhotoPayload.self, from: op.payloadJson)
            if let photo = localStore.loadPhotoData(fileName: p.fileName, takenAt: p.takenAt, digest: p.digest) {
                try await Api.uploadPhoto(id: op.productId, photo: photo, clientId: p.clientId)
            }

        default:
            break
        }
    }

    // MARK: - Modals & Registration

    func openDetail(_ card: Card, localPhoto: PhotoData? = nil, sessionId: UUID? = nil) {
        addPauseReason(.detailSheet)
        let fresh = localStore.cachedCard(id: card.id) ?? card
        detailTarget = DetailTarget(card: fresh, localPhoto: localPhoto, sessionId: sessionId)
    }

    func openRegister(_ entry: Entry) {
        addPauseReason(.registerSheet)
        let draft = entry.draft ?? ScanDraft(fnsku: entry.fnsku, jan: "", name: "", lines: [])
        registerTarget = RegisterTarget(id: entry.id, draft: draft)
    }

    func openMemoEditor(for entry: Entry) {
        addPauseReason(.memoSheet)
        memoTarget = MemoTarget(mode: .entryDraft(entryId: entry.id, card: entry.currentCard))
    }

    func openMemoEditor(for card: Card, sessionId: UUID?) {
        addPauseReason(.memoSheet)
        let fresh = localStore.cachedCard(id: card.id) ?? card
        memoTarget = MemoTarget(mode: .productDirect(card: fresh, sessionId: sessionId))
    }

    /// Create a new product from state C (or branch / manual search), carrying over any ScanSession draft memos & manual photos.
    func registerNew(
        entryId: UUID,
        fnskuOverride: String? = nil,
        name: String,
        brand: String,
        model: String,
        jan: String,
        url: String,
        notes: String,
        allowDuplicate: Bool
    ) async throws {
        guard let e = entries.first(where: { $0.id == entryId }) else { return }
        let taken = e.photo?.takenAt ?? e.at
        let today = Calendar.current.isDateInToday(taken)
        let lines = e.draft?.lines ?? []
        let cond = e.fullEditConditionNote ?? e.conditionNoteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let ai = e.fullEditAiInstruction ?? e.aiInstructionDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetFnsku = (fnskuOverride ?? e.fnsku).trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let card = try await Api.registerFromScan(
            fnsku: targetFnsku,
            name: name,
            brand: brand,
            model: model,
            jan: jan,
            url: url,
            conditionNote: cond,
            aiInstruction: ai,
            notes: notes,
            lines: lines,
            presence: today,
            scannedAt: taken,
            allowDuplicate: allowDuplicate
        )
        localStore.cacheCard(card)
        localStore.bindSessionManualPhotos(sessionId: e.id, toProductId: card.id)
        if let photo = e.photo {
            let fileKey = UUID()
            if let fileName = localStore.savePhotoFile(photo, opKey: fileKey) {
                let pPayload = UploadPhotoPayload(
                    fileName: fileName,
                    clientId: "scan:\(photo.digest)",
                    takenAt: photo.takenAt,
                    width: photo.width,
                    height: photo.height,
                    digest: photo.digest
                )
                localStore.enqueue(sessionId: e.id, productId: card.id, kind: "uploadPhoto", payload: pPayload)
            }
        }
        finishEntryToHistory(entry: e, updatedCard: card)
        startPostActionCooldown()
        speak("登録しました。\(card.say)")
        Task {
            await flushSyncQueue()
            await flushManualPhotoUploads()
        }
    }

    static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    // MARK: - Scan-Label Library Import (existing scan-from-photo flow)

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
            let jobId = UUID()
            activeJobs[e.id] = jobId
            entries.insert(e, at: 0)
            localStore.upsertSession(sessionId: e.id, code: e.code, fnsku: "", status: "working")
            do {
                let r = try await Api.scan(codes: codes, lines: lines)
                if isJobAlive(entryId: e.id, jobId: jobId) {
                    update(e.id) {
                        $0.fnsku = r.fnsku
                        $0.fnskuOwner = r.fnskuOwner
                        $0.draft = r.draft
                        $0.alternatives = r.candidates
                    }
                    settle(e.id, r, silent: isEditingFlowActive)
                }
            } catch {
                if isJobAlive(entryId: e.id, jobId: jobId) {
                    localStore.upsertSession(sessionId: e.id, code: e.code, fnsku: "", status: "unresolved")
                    update(e.id) { $0.state = .offlineUnresolved(e.code) }
                }
            }
            busyLibrary -= 1
        }
        busyLibrary = 0
    }

    private func update(_ id: UUID, _ f: (inout Entry) -> Void) {
        if let i = entries.firstIndex(where: { $0.id == id }) { f(&entries[i]) }
    }
}
