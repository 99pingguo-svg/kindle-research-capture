import Foundation
import SwiftData

/// Local persisted scan session: survives force-quit and keeps draft memos across candidate selection.
@Model
final class ScanSession {
    @Attribute(.unique) var sessionId: UUID
    var productId: String?
    var productName: String
    var fnsku: String
    var code: String
    var conditionNoteDraft: String
    var aiInstructionDraft: String
    var createdAt: Date
    /// "working" (確認待ち), "unresolved" (未解決), "pendingSync" (同期待ち), "needsAttention" (要確認), "synced" (同期済み)
    var status: String
    var cardJson: Data?
    var photoDigest: String?

    init(
        sessionId: UUID = UUID(),
        productId: String? = nil,
        productName: String = "",
        fnsku: String = "",
        code: String = "",
        conditionNoteDraft: String = "",
        aiInstructionDraft: String = "",
        createdAt: Date = Date(),
        status: String = "working",
        cardJson: Data? = nil,
        photoDigest: String? = nil
    ) {
        self.sessionId = sessionId
        self.productId = productId
        self.productName = productName
        self.fnsku = fnsku
        self.code = code
        self.conditionNoteDraft = conditionNoteDraft
        self.aiInstructionDraft = aiInstructionDraft
        self.createdAt = createdAt
        self.status = status
        self.cardJson = cardJson
        self.photoDigest = photoDigest
    }

    var decodedCard: Card? {
        guard let cardJson else { return nil }
        return try? JSONDecoder().decode(Card.self, from: cardJson)
    }
}

/// Persisted FIFO queue item for background ledger synchronization.
@Model
final class SyncOperation {
    @Attribute(.unique) var opId: UUID
    var sessionId: UUID?
    var productId: String
    /// "confirmScan" | "decision" | "patchNotes" | "uploadPhoto" | "correctFnsku" | "patchListingText" | "setPhotoAdopted"
    var kind: String
    var payloadJson: Data
    var createdAt: Date
    var attempts: Int
    var lastError: String
    /// "pending" | "needsAttention" | "failed"
    var status: String

    init(
        opId: UUID = UUID(),
        sessionId: UUID? = nil,
        productId: String,
        kind: String,
        payloadJson: Data,
        createdAt: Date = Date(),
        attempts: Int = 0,
        lastError: String = "",
        status: String = "pending"
    ) {
        self.opId = opId
        self.sessionId = sessionId
        self.productId = productId
        self.kind = kind
        self.payloadJson = payloadJson
        self.createdAt = createdAt
        self.attempts = attempts
        self.lastError = lastError
        self.status = status
    }
}

/// Independent manual real-photo record (Part 5): completely separate from ScanSession.
@Model
final class LocalPhoto {
    @Attribute(.unique) var clientPhotoId: UUID
    /// Empty string when captured for an unresolved scan session; bound once product is finalized.
    var productId: String
    var sessionId: UUID?
    var captureBatchId: UUID
    /// "manual_camera" | "manual_library"
    var source: String
    var originalFileName: String
    var thumbFileName: String
    var width: Int
    var height: Int
    var serverPhotoId: String?
    /// "pending" | "uploading" | "synced" | "needsAttention" | "failed"
    var uploadState: String
    /// Default false: only adopted photos become listing photos.
    var isAdopted: Bool
    var pendingAdoptionSync: Bool
    /// Device-only review flag (unreviewed = false, reviewed = true).
    var reviewed: Bool
    var lastError: String
    var createdAt: Date

    init(
        clientPhotoId: UUID = UUID(),
        productId: String = "",
        sessionId: UUID? = nil,
        captureBatchId: UUID = UUID(),
        source: String,
        originalFileName: String,
        thumbFileName: String,
        width: Int,
        height: Int,
        serverPhotoId: String? = nil,
        uploadState: String = "pending",
        isAdopted: Bool = false,
        pendingAdoptionSync: Bool = false,
        reviewed: Bool = false,
        lastError: String = "",
        createdAt: Date = Date()
    ) {
        self.clientPhotoId = clientPhotoId
        self.productId = productId
        self.sessionId = sessionId
        self.captureBatchId = captureBatchId
        self.source = source
        self.originalFileName = originalFileName
        self.thumbFileName = thumbFileName
        self.width = width
        self.height = height
        self.serverPhotoId = serverPhotoId
        self.uploadState = uploadState
        self.isAdopted = isAdopted
        self.pendingAdoptionSync = pendingAdoptionSync
        self.reviewed = reviewed
        self.lastError = lastError
        self.createdAt = createdAt
    }
}

/// Per-product listing text draft (Part 6 / T-011): separate state per field (title / description) with generation guard.
@Model
final class ListingDraft {
    @Attribute(.unique) var productId: String
    var titleBaseValue: String
    var titleLocalValue: String
    var titleBaseRev: Int
    var titleDirty: Bool
    /// "synced" | "draft" | "syncing" | "overflow" | "conflict"
    var titleSyncState: String
    var titleGeneration: Int

    var descBaseValue: String
    var descLocalValue: String
    var descBaseRev: Int
    var descDirty: Bool
    /// "synced" | "draft" | "syncing" | "overflow" | "conflict"
    var descSyncState: String
    var descGeneration: Int

    var serverConflictRev: Int?
    var serverConflictTitle: String?
    var serverConflictDesc: String?
    var hasJmtyOverride: Bool
    var updatedAt: Date

    init(
        productId: String,
        title: String = "",
        description: String = "",
        rev: Int = 1,
        hasJmtyOverride: Bool = false
    ) {
        self.productId = productId
        self.titleBaseValue = title
        self.titleLocalValue = title
        self.titleBaseRev = rev
        self.titleDirty = false
        self.titleSyncState = "synced"
        self.titleGeneration = 0
        self.descBaseValue = description
        self.descLocalValue = description
        self.descBaseRev = rev
        self.descDirty = false
        self.descSyncState = "synced"
        self.descGeneration = 0
        self.serverConflictRev = nil
        self.serverConflictTitle = nil
        self.serverConflictDesc = nil
        self.hasJmtyOverride = hasJmtyOverride
        self.updatedAt = Date()
    }
}

struct ConfirmScanPayload: Codable {
    let fnsku: String
    let presence: Bool
    let scannedAt: Date
    let operationId: String
}

struct DecisionPayload: Codable {
    let decision: String
}

struct PatchNotesPayload: Codable {
    let setConditionNote: String?
    let setAiInstruction: String?
    let appendConditionNote: String?
    let appendAiInstruction: String?
}

struct UploadPhotoPayload: Codable {
    let fileName: String
    let clientId: String
    let takenAt: Date
    let width: Int
    let height: Int
    let digest: String
}

struct CorrectFnskuPayload: Codable {
    let newFnsku: String
    let reason: String
    let operationId: String
}

struct PatchListingTextPayload: Codable {
    let title: String?
    let description: String?
    let expectedRev: Int
    let titleGeneration: Int?
    let descGeneration: Int?
}

struct SetPhotoAdoptedPayload: Codable {
    let clientPhotoId: String
    let serverPhotoId: String?
    let adopted: Bool
}

/// Local projection for fast offline search and FNSKU lookup (Parts 4 & 7).
struct SearchProjection: Codable, Identifiable, Hashable {
    var id: String { productId }
    let productId: String
    let productCode: String
    let name: String
    let brand: String
    let fnsku: String
    let jan: String
    let asin: String
    let aliases: [String]
    let thumb: String?
    let official: String?
    let stockCheckedAt: String?
    let presence: String?
    let decision: String?
    let rev: Int
    let orderDate: String
    let arrivalDate: String
    let sourceUrl: String?
    let conditionNote: String
    let aiInstruction: String
    let strictNormName: String
    let looseNormName: String
    let strictNormBrand: String

    static func from(_ s: CatalogSummary) -> SearchProjection {
        let name = s.name ?? ""
        let brand = s.brand ?? ""
        let asin = s.browser?.asin ?? extractAsin(from: s.sourceUrl) ?? ""
        let aliases = [s.model].compactMap { $0 }.filter { !$0.isEmpty }
        return SearchProjection(
            productId: s.id,
            productCode: s.productCode ?? "",
            name: name,
            brand: brand,
            fnsku: (s.fnsku ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
            jan: s.jan ?? "",
            asin: asin.uppercased(),
            aliases: aliases,
            thumb: s.thumb,
            official: s.official,
            stockCheckedAt: s.stockCheckedAt,
            presence: s.presence,
            decision: s.decision,
            rev: s.rev ?? 1,
            orderDate: s.orderDate ?? "",
            arrivalDate: s.arrivalDate ?? "",
            sourceUrl: s.sourceUrl,
            conditionNote: s.conditionNote ?? "",
            aiInstruction: s.aiInstruction ?? "",
            strictNormName: SearchNormalizer.strict(name),
            looseNormName: SearchNormalizer.loose(name),
            strictNormBrand: SearchNormalizer.strict(brand)
        )
    }

    static func extractAsin(from url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        let pattern = #"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
              let m = re.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
              let r = Range(m.range(at: 1), in: url) else { return nil }
        return String(url[r]).uppercased()
    }

    func toCard() -> Card {
        let short = String(name.prefix(20))
        return Card(
            id: productId,
            name: name,
            short: short,
            say: short,
            brand: brand,
            model: aliases.first,
            jan: jan,
            orderDate: orderDate,
            arrivalDate: arrivalDate,
            arrivalId: "",
            dateId: "",
            productCode: productCode,
            fnsku: fnsku,
            sourceUrl: sourceUrl,
            thumb: thumb,
            official: official,
            scanScene: nil,
            scanSceneThumb: nil,
            scanSceneAt: nil,
            shotDate: "",
            presence: presence,
            decision: decision,
            conditionNote: conditionNote,
            aiInstruction: aiInstruction,
            hasOwnPhoto: false,
            why: "",
            score: 1,
            noted: nil,
            lastScanAt: stockCheckedAt,
            scans: nil,
            reasons: nil
        )
    }
}

struct CatalogSnapshotFile: Codable {
    let updatedAt: Date
    let items: [SearchProjection]
}

enum SearchNormalizer {
    /// Width/case normalized only: preserves spaces and hyphens for strict model/code matching.
    static func strict(_ s: String) -> String {
        (s as NSString)
            .applyingTransform(.fullwidthToHalfwidth, reverse: false)?
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? s.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Loose normalization: removes spaces, hyphens, slashes, and middle dots for relaxed substring matching.
    static func loose(_ s: String) -> String {
        strict(s).replacingOccurrences(of: #"[\s\-_/・,.、。()\[\]（）「」【】]+"#, with: "", options: .regularExpression)
    }

    /// Alphanumeric confusable skeleton (O<->0, I/l<->1) used ONLY for FNSKU / ASIN code queries.
    static func confusableCode(_ s: String) -> String {
        strict(s)
            .uppercased()
            .replacingOccurrences(of: #"[^0-9A-Z]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: "I", with: "1")
            .replacingOccurrences(of: "L", with: "1")
    }
}

@MainActor
final class LocalStore {
    let container: ModelContainer
    let context: ModelContext
    private let supportDir: URL
    private let photosDir: URL
    private let manualPhotosDir: URL
    private let cacheURL: URL
    private let catalogURL: URL
    private let zeroSearchLogURL: URL
    private var cardCache: [String: Card] = [:]
    private(set) var catalog: [SearchProjection] = []
    private(set) var catalogUpdatedAt: Date?

    init() {
        let fm = FileManager.default
        let appSup = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        self.supportDir = appSup.appendingPathComponent("DaichoScan", isDirectory: true)
        self.photosDir = supportDir.appendingPathComponent("scan-photos", isDirectory: true)
        self.manualPhotosDir = supportDir.appendingPathComponent("manual-photos", isDirectory: true)
        self.cacheURL = supportDir.appendingPathComponent("card-cache.json")
        self.catalogURL = supportDir.appendingPathComponent("search-catalog.json")
        self.zeroSearchLogURL = supportDir.appendingPathComponent("zero-search-log.jsonl")
        try? fm.createDirectory(at: photosDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: manualPhotosDir, withIntermediateDirectories: true)

        let schema = Schema([ScanSession.self, SyncOperation.self, LocalPhoto.self, ListingDraft.self])
        let storeURL = supportDir.appendingPathComponent("daicho-scan-v2.store")
        let cfg = ModelConfiguration(schema: schema, url: storeURL)
        do {
            self.container = try ModelContainer(for: schema, configurations: [cfg])
        } catch {
            let mem = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
            self.container = try! ModelContainer(for: schema, configurations: [mem])
        }
        self.context = container.mainContext
        loadCardCache()
        loadCatalogSnapshot()
        recoverManualPhotosOnLaunch()
    }

    // MARK: - Search & Offline Catalog Projection (Parts 4 & 7)

    private func loadCatalogSnapshot() {
        guard let data = try? Data(contentsOf: catalogURL),
              let snap = try? JSONDecoder().decode(CatalogSnapshotFile.self, from: data) else { return }
        catalog = snap.items
        catalogUpdatedAt = snap.updatedAt
    }

    /// Atomic snapshot replacement: guarantees no deleted/merged remnants remain.
    func replaceCatalogSnapshot(_ summaries: [CatalogSummary]) {
        let live = summaries.filter { $0.trashedAt == nil }.map { SearchProjection.from($0) }
        let snap = CatalogSnapshotFile(updatedAt: Date(), items: live)
        guard let data = try? JSONEncoder().encode(snap) else { return }
        try? data.write(to: catalogURL, options: .atomic)
        catalog = live
        catalogUpdatedAt = snap.updatedAt
    }

    func removeCatalogProduct(id: String) {
        catalog.removeAll { $0.productId == id }
        let snap = CatalogSnapshotFile(updatedAt: catalogUpdatedAt ?? Date(), items: catalog)
        if let data = try? JSONEncoder().encode(snap) {
            try? data.write(to: catalogURL, options: .atomic)
        }
    }

    func upsertCatalogItem(from card: Card, rev: Int = 1) {
        let existing = catalog.first { $0.productId == card.id }
        let proj = SearchProjection(
            productId: card.id,
            productCode: card.productCode,
            name: card.name,
            brand: card.brand ?? existing?.brand ?? "",
            fnsku: card.fnsku.uppercased(),
            jan: card.jan ?? existing?.jan ?? "",
            asin: SearchProjection.extractAsin(from: card.sourceUrl) ?? existing?.asin ?? "",
            aliases: existing?.aliases ?? ([card.model].compactMap { $0 }.filter { !$0.isEmpty }),
            thumb: card.thumb ?? existing?.thumb,
            official: card.official ?? existing?.official,
            stockCheckedAt: card.lastScanAt ?? existing?.stockCheckedAt,
            presence: card.presence ?? existing?.presence,
            decision: card.decision ?? existing?.decision,
            rev: max(rev, existing?.rev ?? 1),
            orderDate: card.orderDate ?? existing?.orderDate ?? "",
            arrivalDate: card.arrivalDate.isEmpty ? (existing?.arrivalDate ?? "") : card.arrivalDate,
            sourceUrl: card.sourceUrl ?? existing?.sourceUrl,
            conditionNote: card.conditionNote ?? existing?.conditionNote ?? "",
            aiInstruction: card.aiInstruction ?? existing?.aiInstruction ?? "",
            strictNormName: SearchNormalizer.strict(card.name),
            looseNormName: SearchNormalizer.loose(card.name),
            strictNormBrand: SearchNormalizer.strict(card.brand ?? existing?.brand ?? "")
        )
        if let idx = catalog.firstIndex(where: { $0.productId == card.id }) {
            catalog[idx] = proj
        } else {
            catalog.append(proj)
        }
        let snap = CatalogSnapshotFile(updatedAt: catalogUpdatedAt ?? Date(), items: catalog)
        if let data = try? JSONEncoder().encode(snap) {
            try? data.write(to: catalogURL, options: .atomic)
        }
    }

    func logZeroResultSearch(query: String) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        let line = "{\"at\":\"\(ISO8601DateFormatter().string(from: Date()))\",\"query\":\(String(data: (try? JSONEncoder().encode(q)) ?? Data("\"\"".utf8), encoding: .utf8) ?? "\"\"")}\n"
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: zeroSearchLogURL.path),
               let fh = try? FileHandle(forWritingTo: zeroSearchLogURL) {
                _ = try? fh.seekToEnd()
                try? fh.write(contentsOf: data)
                try? fh.close()
            } else {
                try? data.write(to: zeroSearchLogURL, options: .atomic)
            }
        }
    }

    // MARK: - Card Cache

    private func loadCardCache() {
        guard let data = try? Data(contentsOf: cacheURL),
              let list = try? JSONDecoder().decode([Card].self, from: data) else { return }
        cardCache = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    private func persistCardCache() {
        let list = Array(cardCache.values)
        guard let data = try? JSONEncoder().encode(list) else { return }
        try? data.write(to: cacheURL, options: .atomic)
    }

    func cacheCard(_ card: Card) {
        cardCache[card.id] = card
        persistCardCache()
        upsertCatalogItem(from: card)
    }

    func cachedCard(id: String) -> Card? {
        cardCache[id] ?? catalog.first(where: { $0.productId == id })?.toCard()
    }

    func cachedCard(forFnsku fnsku: String) -> Card? {
        let code = fnsku.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !code.isEmpty else { return nil }
        if let hit = cardCache.values.first(where: { $0.fnsku.uppercased() == code }) { return hit }
        return catalog.first(where: { $0.fnsku.uppercased() == code })?.toCard()
    }

    // MARK: - ScanSession

    @discardableResult
    func upsertSession(
        sessionId: UUID,
        code: String,
        fnsku: String,
        productId: String? = nil,
        status: String = "working",
        conditionNoteDraft: String? = nil,
        aiInstructionDraft: String? = nil,
        card: Card? = nil,
        photoDigest: String? = nil
    ) -> ScanSession {
        let s = fetchSession(sessionId) ?? {
            let created = ScanSession(sessionId: sessionId, fnsku: fnsku, code: code, status: status)
            context.insert(created)
            return created
        }()
        if !code.isEmpty { s.code = code }
        if !fnsku.isEmpty { s.fnsku = fnsku }
        if let productId { s.productId = productId }
        s.status = status
        if let conditionNoteDraft { s.conditionNoteDraft = conditionNoteDraft }
        if let aiInstructionDraft { s.aiInstructionDraft = aiInstructionDraft }
        if let photoDigest { s.photoDigest = photoDigest }
        if let card {
            s.productId = card.id
            s.productName = card.name
            s.cardJson = try? JSONEncoder().encode(card)
            cacheCard(card)
        }
        save()
        return s
    }

    func updateDrafts(sessionId: UUID, conditionNoteDraft: String, aiInstructionDraft: String) {
        guard let s = fetchSession(sessionId) else { return }
        s.conditionNoteDraft = conditionNoteDraft
        s.aiInstructionDraft = aiInstructionDraft
        save()
    }

    func markSessionSyncedIfIdle(_ sessionId: UUID) {
        guard let s = fetchSession(sessionId) else { return }
        let ops = allQueuedOperations().filter { $0.sessionId == sessionId }
        if ops.isEmpty && s.productId != nil {
            s.status = "synced"
            save()
        }
    }

    func fetchSession(_ sessionId: UUID) -> ScanSession? {
        let target = sessionId
        let desc = FetchDescriptor<ScanSession>(predicate: #Predicate { $0.sessionId == target })
        return try? context.fetch(desc).first
    }

    func recentSessions(limit: Int = 50) -> [ScanSession] {
        var desc = FetchDescriptor<ScanSession>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        desc.fetchLimit = limit
        return (try? context.fetch(desc)) ?? []
    }

    func unresolvedSessions() -> [ScanSession] {
        let desc = FetchDescriptor<ScanSession>(
            predicate: #Predicate { $0.status == "working" || $0.status == "unresolved" },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func deleteSession(_ sessionId: UUID) {
        guard let s = fetchSession(sessionId) else { return }
        context.delete(s)
        save()
    }

    // MARK: - SyncOperation Queue

    func enqueue<T: Encodable>(sessionId: UUID?, productId: String, kind: String, payload: T) {
        guard let data = try? JSONEncoder().encode(payload) else { return }
        let op = SyncOperation(sessionId: sessionId, productId: productId, kind: kind, payloadJson: data)
        context.insert(op)
        save()
    }

    func pendingOperations() -> [SyncOperation] {
        let desc = FetchDescriptor<SyncOperation>(
            predicate: #Predicate { $0.status == "pending" },
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func allQueuedOperations() -> [SyncOperation] {
        let desc = FetchDescriptor<SyncOperation>(sortBy: [SortDescriptor(\.createdAt, order: .forward)])
        return (try? context.fetch(desc)) ?? []
    }

    func attentionOperations() -> [SyncOperation] {
        let desc = FetchDescriptor<SyncOperation>(
            predicate: #Predicate { $0.status == "needsAttention" || $0.status == "failed" },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func pendingCount() -> Int {
        allQueuedOperations().count + pendingManualPhotos().count
    }

    func completeOperation(_ op: SyncOperation) {
        if op.kind == "uploadPhoto",
           let p = try? JSONDecoder().decode(UploadPhotoPayload.self, from: op.payloadJson) {
            removePhotoFile(p.fileName)
        }
        let sid = op.sessionId
        context.delete(op)
        save()
        if let sid { markSessionSyncedIfIdle(sid) }
    }

    func markOperationNeedsAttention(_ op: SyncOperation, error: String) {
        op.attempts += 1
        op.lastError = error
        op.status = "needsAttention"
        if let sid = op.sessionId, let s = fetchSession(sid) {
            s.status = "needsAttention"
        }
        save()
    }

    func markAttemptFailed(_ op: SyncOperation, error: String, permanent: Bool) {
        op.attempts += 1
        op.lastError = error
        if permanent {
            op.status = "needsAttention"
            if let sid = op.sessionId, let s = fetchSession(sid) {
                s.status = "needsAttention"
            }
        }
        save()
    }

    func retryFailedOperations() {
        for op in allQueuedOperations() where op.status == "failed" || op.status == "needsAttention" {
            op.status = "pending"
        }
        save()
    }

    func revertDecision(productId: String, to previousDecision: String, sessionId: UUID?) {
        let pendingDecisions = pendingOperations().filter { $0.productId == productId && $0.kind == "decision" }
        if !pendingDecisions.isEmpty {
            for op in pendingDecisions {
                if let data = try? JSONEncoder().encode(DecisionPayload(decision: previousDecision)) {
                    op.payloadJson = data
                }
            }
            save()
        } else {
            enqueue(sessionId: sessionId, productId: productId, kind: "decision", payload: DecisionPayload(decision: previousDecision))
        }
    }

    // MARK: - LocalPhoto (Part 5: Independent Manual Product Photos + Crash Recovery)

    /// Check available disk space before saving manual photos (explicit error instead of silent failure).
    func ensureDiskSpace(minBytes: Int64 = 25 * 1024 * 1024) throws {
        let vals = try supportDir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        if let avail = vals.volumeAvailableCapacityForImportantUsage, avail < minBytes {
            throw NSError(domain: "DaichoScan.Storage", code: 1, userInfo: [NSLocalizedDescriptionKey: "端末の空き容量が不足しているため写真を保存できません"])
        }
    }

    /// Strict order: 1) atomic save of processed JPEG + thumb to Application Support -> 2) SwiftData LocalPhoto record.
    func createManualPhoto(
        productId: String,
        sessionId: UUID?,
        batchId: UUID,
        source: String,
        processed: ProcessedManualPhoto
    ) throws -> LocalPhoto {
        try ensureDiskSpace()
        let cpid = UUID()
        let origName = "\(cpid.uuidString).orig.jpg"
        let thumbName = "\(cpid.uuidString).thumb.jpg"
        let origURL = manualPhotosDir.appendingPathComponent(origName)
        let thumbURL = manualPhotosDir.appendingPathComponent(thumbName)
        try processed.jpeg.write(to: origURL, options: .atomic)
        try processed.thumb.write(to: thumbURL, options: .atomic)
        guard FileManager.default.fileExists(atPath: origURL.path) else {
            throw NSError(domain: "DaichoScan.Storage", code: 2, userInfo: [NSLocalizedDescriptionKey: "写真の保存確認に失敗しました"])
        }
        let rec = LocalPhoto(
            clientPhotoId: cpid,
            productId: productId,
            sessionId: sessionId,
            captureBatchId: batchId,
            source: source,
            originalFileName: origName,
            thumbFileName: thumbName,
            width: processed.width,
            height: processed.height,
            uploadState: "pending",
            isAdopted: false,
            pendingAdoptionSync: false,
            reviewed: false
        )
        context.insert(rec)
        save()
        return rec
    }

    func manualPhotos(forProductId productId: String) -> [LocalPhoto] {
        let pid = productId
        let desc = FetchDescriptor<LocalPhoto>(
            predicate: #Predicate { $0.productId == pid },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func manualPhotos(forSessionId sessionId: UUID) -> [LocalPhoto] {
        let sid = sessionId
        let desc = FetchDescriptor<LocalPhoto>(
            predicate: #Predicate { $0.sessionId == sid },
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func bindSessionManualPhotos(sessionId: UUID, toProductId productId: String) {
        let list = manualPhotos(forSessionId: sessionId)
        for ph in list where ph.productId.isEmpty {
            ph.productId = productId
        }
        if !list.isEmpty { save() }
    }

    func pendingManualPhotos() -> [LocalPhoto] {
        let desc = FetchDescriptor<LocalPhoto>(
            predicate: #Predicate { ($0.uploadState == "pending" || $0.uploadState == "uploading") && !$0.productId.isEmpty },
            sortBy: [SortDescriptor(\.createdAt, order: .forward)]
        )
        return (try? context.fetch(desc)) ?? []
    }

    func allLocalPhotos() -> [LocalPhoto] {
        let desc = FetchDescriptor<LocalPhoto>(sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        return (try? context.fetch(desc)) ?? []
    }

    func manualPhotoOriginalURL(_ ph: LocalPhoto) -> URL {
        manualPhotosDir.appendingPathComponent(ph.originalFileName)
    }

    func manualPhotoThumbURL(_ ph: LocalPhoto) -> URL {
        manualPhotosDir.appendingPathComponent(ph.thumbFileName)
    }

    func markManualPhotoUploaded(_ ph: LocalPhoto, serverPhotoId: String) {
        ph.serverPhotoId = serverPhotoId
        ph.uploadState = "synced"
        ph.lastError = ""
        // Delete local original ONLY after confirmed server upload (keep thumb for fast local display).
        try? FileManager.default.removeItem(at: manualPhotoOriginalURL(ph))
        save()
    }

    func deleteLocalManualPhotos(forSessionId sessionId: UUID) {
        for ph in manualPhotos(forSessionId: sessionId) where ph.productId.isEmpty {
            try? FileManager.default.removeItem(at: manualPhotoOriginalURL(ph))
            try? FileManager.default.removeItem(at: manualPhotoThumbURL(ph))
            context.delete(ph)
        }
        save()
    }

    /// Crash recovery on launch (Part 5): reclaim orphan files & flag DB rows whose original file is missing.
    private func recoverManualPhotosOnLaunch() {
        let fm = FileManager.default
        let rows = allLocalPhotos()
        var referenced = Set<String>()
        for ph in rows {
            referenced.insert(ph.originalFileName)
            referenced.insert(ph.thumbFileName)
            if ph.uploadState == "uploading" {
                ph.uploadState = "pending"
            }
            if ph.uploadState == "pending" && !fm.fileExists(atPath: manualPhotoOriginalURL(ph).path) {
                ph.uploadState = "needsAttention"
                ph.lastError = "ローカル画像ファイルが欠損しています（要対応）"
            }
        }
        save()
        if let files = try? fm.contentsOfDirectory(atPath: manualPhotosDir.path) {
            for f in files where !referenced.contains(f) {
                try? fm.removeItem(at: manualPhotosDir.appendingPathComponent(f))
            }
        }
    }

    // MARK: - ListingDraft (Part 6 / T-011)

    func fetchListingDraft(productId: String) -> ListingDraft? {
        let pid = productId
        let desc = FetchDescriptor<ListingDraft>(predicate: #Predicate { $0.productId == pid })
        return try? context.fetch(desc).first
    }

    func upsertListingDraft(productId: String, serverTitle: String, serverDesc: String, rev: Int, hasJmtyOverride: Bool) -> ListingDraft {
        if let existing = fetchListingDraft(productId: productId) {
            if !existing.titleDirty {
                existing.titleBaseValue = serverTitle
                existing.titleLocalValue = serverTitle
                existing.titleBaseRev = rev
                if existing.titleSyncState != "conflict" { existing.titleSyncState = "synced" }
            }
            if !existing.descDirty {
                existing.descBaseValue = serverDesc
                existing.descLocalValue = serverDesc
                existing.descBaseRev = rev
                if existing.descSyncState != "conflict" { existing.descSyncState = "synced" }
            }
            existing.hasJmtyOverride = hasJmtyOverride
            existing.updatedAt = Date()
            save()
            return existing
        }
        let d = ListingDraft(productId: productId, title: serverTitle, description: serverDesc, rev: rev, hasJmtyOverride: hasJmtyOverride)
        context.insert(d)
        save()
        return d
    }

    func hasListingConflicts() -> Bool {
        let desc = FetchDescriptor<ListingDraft>(
            predicate: #Predicate { $0.titleSyncState == "conflict" || $0.descSyncState == "conflict" }
        )
        return ((try? context.fetch(desc))?.isEmpty == false)
    }

    // MARK: - Offline Scan-Scene Photo Files

    func savePhotoFile(_ photo: PhotoData, opKey: UUID) -> String? {
        let name = "\(opKey.uuidString).jpg"
        let url = photosDir.appendingPathComponent(name)
        do {
            try photo.original.write(to: url, options: .atomic)
            return name
        } catch {
            return nil
        }
    }

    func loadPhotoData(fileName: String, takenAt: Date, digest: String) -> PhotoData? {
        let url = photosDir.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return PhotoTools.prepare(data, fallbackTime: takenAt)
    }

    func removePhotoFile(_ fileName: String) {
        let url = photosDir.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: url)
    }

    func save() {
        try? context.save()
    }
}
