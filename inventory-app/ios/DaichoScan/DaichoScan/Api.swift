import Foundation

/// One product as the scan screen shows it (server/scan.js `scanCard`).
struct Card: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let short: String
    let say: String
    let brand: String?
    let model: String?
    let jan: String?
    let orderDate: String?
    let arrivalDate: String
    let arrivalId: String
    let dateId: String
    let productCode: String
    let fnsku: String
    let sourceUrl: String?
    let thumb: String?
    let official: String?
    let scanScene: String?
    let scanSceneThumb: String?
    let scanSceneAt: String?
    let shotDate: String
    let presence: String?
    let decision: String?
    let conditionNote: String?
    let aiInstruction: String?
    let hasOwnPhoto: Bool
    let why: String
    let score: Double
    let noted: String?
    let lastScanAt: String?
    let scans: [ScanEvent]?
    let reasons: [String]?

    func updating(
        fnsku: String? = nil,
        presence: String?? = nil,
        decision: String?? = nil,
        conditionNote: String? = nil,
        aiInstruction: String? = nil,
        lastScanAt: String?? = nil
    ) -> Card {
        Card(
            id: id,
            name: name,
            short: short,
            say: say,
            brand: brand,
            model: model,
            jan: jan,
            orderDate: orderDate,
            arrivalDate: arrivalDate,
            arrivalId: arrivalId,
            dateId: dateId,
            productCode: productCode,
            fnsku: fnsku ?? self.fnsku,
            sourceUrl: sourceUrl,
            thumb: thumb,
            official: official,
            scanScene: scanScene,
            scanSceneThumb: scanSceneThumb,
            scanSceneAt: scanSceneAt,
            shotDate: shotDate,
            presence: presence ?? self.presence,
            decision: decision ?? self.decision,
            conditionNote: conditionNote ?? self.conditionNote,
            aiInstruction: aiInstruction ?? self.aiInstruction,
            hasOwnPhoto: hasOwnPhoto,
            why: why,
            score: score,
            noted: noted,
            lastScanAt: lastScanAt ?? self.lastScanAt,
            scans: scans,
            reasons: reasons
        )
    }
}

/// One recorded scan of a product (server/scan.js `recentScans`); undone ones stay listed.
struct ScanEvent: Codable, Hashable {
    let id: String
    let scannedAt: String
    let undone: Bool
}

struct ScanDraft: Codable, Hashable {
    let fnsku: String
    let jan: String
    let name: String
    let lines: [String]
}

struct Lookup: Decodable {
    let status: String?
    let registered: Bool?
    let fnsku: String
    let fnskuOwner: Card?
    let pick: Card?
    let candidates: [Card]
    let say: String
    let voiceSay: String?
    let draft: ScanDraft?
}

struct DuplicateCheck: Decodable {
    let fnskuOwner: Card?
    let duplicates: [Card]
    let similar: [Card]
    let hasConflict: Bool
}

struct FnskuOwnerInfo: Codable, Hashable {
    let productId: String
    let id: String
    let name: String
    let fnsku: String
}

/// Server-side photo record returned by GET /api/products/:id.
struct ServerPhoto: Codable, Identifiable, Hashable {
    struct Files: Codable, Hashable {
        let original: String?
        let work: String?
        let thumb: String?
    }
    let id: String
    let kind: String
    let source: String?
    let tag: String?
    let clientPhotoId: String?
    let clientId: String?
    let createdAt: String?
    let deletedAt: String?
    let files: Files?

    static let listableActualSources: Set<String> = ["manual_camera", "manual_library", "camera", "studio", "native"]

    var isListableActual: Bool {
        deletedAt == nil && kind == "actual" && Self.listableActualSources.contains(source ?? "camera")
    }

    var isScanScene: Bool {
        deletedAt == nil && source == "scan"
    }

    func thumbPath(productId: String) -> String? {
        guard let rel = files?.thumb ?? files?.work ?? files?.original else { return nil }
        return "/files/products/\(productId)/\(rel)"
    }

    func workPath(productId: String) -> String? {
        guard let rel = files?.work ?? files?.original ?? files?.thumb else { return nil }
        return "/files/products/\(productId)/\(rel)"
    }
}

/// Detailed product record returned by GET /api/products/:id (used by Parts 4, 5, 6, 7).
struct ProductDetail: Decodable {
    struct Listing: Decodable {
        let title: String?
        let description: String?
        let titleSource: String?
        let descriptionSource: String?
    }
    let id: String
    let rev: Int
    let name: String
    let brand: String?
    let model: String?
    let jan: String?
    let fnsku: String?
    let orderDate: String?
    let arrivalDate: String?
    let dateId: String?
    let productCode: String?
    let conditionNote: String?
    let aiInstruction: String?
    let decision: String?
    let trashedAt: String?
    let stockCheckedAt: String?
    let lastScanAt: String?
    let hasJmtyOverride: Bool?
    let listing: Listing?
    let photos: [ServerPhoto]?
    let listingPhotoIds: [String]?
    let summary: CatalogSummary?

    func toCard() -> Card {
        let s = summary
        let arrival = arrivalDate ?? s?.arrivalDate ?? ""
        let order = orderDate ?? s?.orderDate ?? ""
        let cleanName = name.isEmpty ? (listing?.title ?? "") : name
        let short = String(cleanName.prefix(20))
        return Card(
            id: id,
            name: cleanName,
            short: short,
            say: short,
            brand: brand ?? s?.brand,
            model: model ?? s?.model,
            jan: jan ?? s?.jan,
            orderDate: order,
            arrivalDate: arrival,
            arrivalId: s?.arrivalId ?? "",
            dateId: dateId ?? s?.dateId ?? "",
            productCode: productCode ?? s?.productCode ?? "",
            fnsku: fnsku ?? "",
            sourceUrl: s?.sourceUrl,
            thumb: s?.thumb,
            official: s?.official,
            scanScene: s?.scanScene,
            scanSceneThumb: s?.scanSceneThumb,
            scanSceneAt: s?.scanSceneAt,
            shotDate: s?.shotDate ?? "",
            presence: s?.presence,
            decision: decision ?? s?.decision,
            conditionNote: conditionNote ?? s?.conditionNote,
            aiInstruction: aiInstruction ?? s?.aiInstruction,
            hasOwnPhoto: (s?.counts?.actual ?? 0) > 0,
            why: "",
            score: 1,
            noted: nil,
            lastScanAt: lastScanAt ?? s?.lastScanAt,
            scans: nil,
            reasons: nil
        )
    }
}

/// Summary row returned by GET /api/products (used for atomic SearchProjection catalog snapshot).
struct CatalogSummary: Codable {
    struct Counts: Codable {
        let actual: Int?
        let generated: Int?
        let listing: Int?
        let reference: Int?
    }
    struct BrowserBrief: Codable {
        let asin: String?
    }
    let id: String
    let rev: Int?
    let name: String?
    let brand: String?
    let model: String?
    let jan: String?
    let fnsku: String?
    let sourceUrl: String?
    let thumb: String?
    let official: String?
    let scanScene: String?
    let scanSceneThumb: String?
    let scanSceneAt: String?
    let shotDate: String?
    let presence: String?
    let decision: String?
    let trashedAt: String?
    let stockCheckedAt: String?
    let lastScanAt: String?
    let orderDate: String?
    let arrivalDate: String?
    let arrivalId: String?
    let dateId: String?
    let productCode: String?
    let conditionNote: String?
    let aiInstruction: String?
    let hasJmtyOverride: Bool?
    let counts: Counts?
    let browser: BrowserBrief?
}

struct PhotoUploadResponse: Decodable {
    let photo: ServerPhoto
    let duplicate: Bool
}

struct CorrectFnskuResponse: Decodable {
    let product: ProductDetail
    let idempotent: Bool?
}

private struct ProductFieldsResponse: Decodable {
    struct Inner: Decodable {
        let rev: Int?
        let conditionNote: String?
        let aiInstruction: String?
        let decision: String?
        let listing: ProductDetail.Listing?
    }
    let product: Inner
}

struct ApiError: LocalizedError {
    let message: String
    let statusCode: Int
    let code: String?
    let owner: FnskuOwnerInfo?
    let fnskuOwner: Card?
    let currentFnsku: String?
    let scannedFnsku: String?
    let productId: String?
    let currentRev: Int?
    let currentTitle: String?
    let currentDescription: String?
    let duplicates: [Card]?
    let similar: [Card]?
    var errorDescription: String? { message }

    var isPermanentClientError: Bool {
        (400..<500).contains(statusCode) && statusCode != 408 && statusCode != 429
    }
}

private struct ErrorEnvelope: Decodable {
    let error: String?
    let code: String?
    let owner: FnskuOwnerInfo?
    let fnskuOwner: Card?
    let currentFnsku: String?
    let scannedFnsku: String?
    let productId: String?
    let currentRev: Int?
    let currentTitle: String?
    let currentDescription: String?
    let duplicates: [Card]?
    let similar: [Card]?
}

/// Dedicated background URLSession manager for resilient photo uploads (Part 5).
final class PhotoBackgroundUploader: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {
    static let shared = PhotoBackgroundUploader()
    private lazy var bgSession: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: "jp.personal.daichoscan.photo-upload")
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    private let lock = NSLock()
    private var buffers: [Int: Data] = [:]
    private var continuations: [Int: CheckedContinuation<(Data, URLResponse), Error>] = [:]
    private var tempFiles: [Int: URL] = [:]

    func upload(request: URLRequest, bodyFileURL: URL) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { cont in
            let task = bgSession.uploadTask(with: request, fromFile: bodyFileURL)
            lock.lock()
            buffers[task.taskIdentifier] = Data()
            continuations[task.taskIdentifier] = cont
            tempFiles[task.taskIdentifier] = bodyFileURL
            lock.unlock()
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffers[dataTask.taskIdentifier, default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let data = buffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        let cont = continuations.removeValue(forKey: task.taskIdentifier)
        let tmp = tempFiles.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        if let tmp { try? FileManager.default.removeItem(at: tmp) }
        guard let cont else { return }
        if let error {
            cont.resume(throwing: error)
        } else if let res = task.response {
            cont.resume(returning: (data, res))
        } else {
            cont.resume(throwing: URLError(.badServerResponse))
        }
    }
}

/// The ledger on the Mac (through Tailscale). Every request carries the token and acts as the user.
enum Api {
    static func makeRequest(_ path: String, method: String = "GET", contentType: String? = nil) -> URLRequest {
        var req = URLRequest(url: Config.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("Bearer \(Config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("user", forHTTPHeaderField: "x-actor")
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
        return req
    }

    private static func parseError(data: Data, code: Int) -> ApiError {
        let env = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        return ApiError(
            message: env?.error ?? "台帳の応答 \(code)",
            statusCode: code,
            code: env?.code,
            owner: env?.owner,
            fnskuOwner: env?.fnskuOwner,
            currentFnsku: env?.currentFnsku,
            scannedFnsku: env?.scannedFnsku,
            productId: env?.productId,
            currentRev: env?.currentRev,
            currentTitle: env?.currentTitle,
            currentDescription: env?.currentDescription,
            duplicates: env?.duplicates,
            similar: env?.similar
        )
    }

    static func request(_ path: String, method: String = "GET", json: [String: Any]? = nil, body: Data? = nil, contentType: String? = nil) async throws -> Data {
        var req = makeRequest(path, method: method, contentType: contentType)
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        } else if let body {
            req.httpBody = body
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw parseError(data: data, code: code)
        }
        return data
    }

    static func scan(codes: [String], lines: [String]) async throws -> Lookup {
        let d = try await request("/api/scan", method: "POST", json: ["codes": codes, "lines": lines])
        return try JSONDecoder().decode(Lookup.self, from: d)
    }

    static func fetchCatalog() async throws -> [CatalogSummary] {
        let d = try await request("/api/products", method: "GET")
        return try JSONDecoder().decode([CatalogSummary].self, from: d)
    }

    static func fetchProductDetail(id: String) async throws -> ProductDetail {
        let d = try await request("/api/products/\(id)", method: "GET")
        return try JSONDecoder().decode(ProductDetail.self, from: d)
    }

    /// Mark it present (ある) and keep the warehouse label number when the product has none (with operationId idempotency).
    static func confirm(id: String, fnsku: String, presence: Bool, scannedAt: Date? = nil, operationId: String? = nil) async throws -> Card {
        var json: [String: Any] = ["id": id, "fnsku": fnsku, "presence": presence]
        if let scannedAt { json["scannedAt"] = ISO8601DateFormatter().string(from: scannedAt) }
        if let operationId, !operationId.isEmpty { json["operationId"] = operationId }
        let d = try await request("/api/scan/confirm", method: "POST", json: json)
        return try JSONDecoder().decode(Card.self, from: d)
    }

    /// Dedicated FNSKU correction API (T-013): logs old/new/reason/operationId in history without altering scanEvents.
    static func correctFnsku(id: String, newFnsku: String, reason: String, operationId: String) async throws -> CorrectFnskuResponse {
        let payload: [String: Any] = [
            "newFnsku": newFnsku,
            "reason": reason,
            "operationId": operationId,
        ]
        let d = try await request("/api/products/\(id)/fnsku/correct", method: "POST", json: payload)
        return try JSONDecoder().decode(CorrectFnskuResponse.self, from: d)
    }

    static func setDecision(id: String, decision: String) async throws {
        _ = try await request("/api/products/\(id)/decision", method: "POST", json: ["decision": decision])
    }

    @discardableResult
    static func patchProduct(
        id: String,
        set: [String: String]? = nil,
        append: [String: String]? = nil,
        expectedRev: Int? = nil
    ) async throws -> (rev: Int?, conditionNote: String, aiInstruction: String, title: String?, description: String?) {
        var payload: [String: Any] = [:]
        if let set, !set.isEmpty { payload["set"] = set }
        if let append, !append.isEmpty { payload["append"] = append }
        if let expectedRev { payload["expectedRev"] = expectedRev }
        let d = try await request("/api/products/\(id)", method: "PATCH", json: payload)
        let decoded = try? JSONDecoder().decode(ProductFieldsResponse.self, from: d)
        return (
            decoded?.product.rev,
            decoded?.product.conditionNote ?? "",
            decoded?.product.aiInstruction ?? "",
            decoded?.product.listing?.title,
            decoded?.product.listing?.description
        )
    }

    static func setPhotoAdopted(id: String, photoId: String, adopted: Bool) async throws -> ProductDetail {
        let d = try await request("/api/products/\(id)/photos/\(photoId)", method: "PATCH", json: ["adopted": adopted])
        return try JSONDecoder().decode(ProductDetail.self, from: d)
    }

    static func deletePhoto(id: String, photoId: String) async throws -> ProductDetail {
        let d = try await request("/api/products/\(id)/photos/\(photoId)", method: "DELETE")
        return try JSONDecoder().decode(ProductDetail.self, from: d)
    }

    /// Check for duplicate FNSKU / existing similar products before creating a new product.
    static func checkDuplicates(fnsku: String, name: String, brand: String, model: String, jan: String, url: String, lines: [String]) async throws -> DuplicateCheck {
        let payload: [String: Any] = [
            "fnsku": fnsku,
            "name": name,
            "brand": brand,
            "model": model,
            "jan": jan,
            "url": url,
            "lines": lines,
        ]
        let d = try await request("/api/scan/check-duplicates", method: "POST", json: payload)
        return try JSONDecoder().decode(DuplicateCheck.self, from: d)
    }

    /// Register a new product from scan draft, bind its FNSKU, and confirm the scan.
    static func registerFromScan(
        fnsku: String,
        name: String,
        brand: String,
        model: String,
        jan: String,
        url: String,
        conditionNote: String,
        aiInstruction: String,
        notes: String,
        lines: [String],
        presence: Bool,
        scannedAt: Date,
        allowDuplicate: Bool
    ) async throws -> Card {
        let payload: [String: Any] = [
            "fnsku": fnsku,
            "name": name,
            "brand": brand,
            "model": model,
            "jan": jan,
            "url": url,
            "conditionNote": conditionNote,
            "aiInstruction": aiInstruction,
            "notes": notes,
            "lines": lines,
            "presence": presence,
            "scannedAt": ISO8601DateFormatter().string(from: scannedAt),
            "allowDuplicate": allowDuplicate,
        ]
        let d = try await request("/api/scan/register", method: "POST", json: payload)
        return try JSONDecoder().decode(Card.self, from: d)
    }

    /// Take back the product's latest scan (a mistaken read): the ledger puts the earlier values back.
    static func undoScan(id: String) async throws -> Card {
        let d = try await request("/api/scan/undo", method: "POST", json: ["productId": id])
        return try JSONDecoder().decode(Card.self, from: d)
    }

    /// Scan-scene image (source "scan", kind "reference"): stored once per product and replaced on new scans.
    static func uploadPhoto(id: String, photo: PhotoData, clientId: String) async throws {
        let boundary = "daicho-\(UUID().uuidString)"
        let body = buildMultipart(
            boundary: boundary,
            fields: [
                ("kind", "reference"),
                ("source", "scan"),
                ("tag", "スキャン場面"),
                ("clientId", clientId),
                ("takenAt", ISO8601DateFormatter().string(from: photo.takenAt)),
                ("width", String(photo.width)),
                ("height", String(photo.height)),
            ],
            files: [("original", photo.original), ("work", photo.work), ("thumb", photo.thumb)]
        )
        _ = try await request("/api/products/\(id)/photos", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
    }

    /// Manual listing candidate photo (Part 5): kind="actual", source="manual_camera"|"manual_library",
    /// clientPhotoId idempotent, uploaded via background URLSession.
    static func uploadManualPhoto(
        id: String,
        jpegData: Data,
        thumbData: Data,
        source: String,
        clientPhotoId: String,
        width: Int,
        height: Int,
        takenAt: Date
    ) async throws -> PhotoUploadResponse {
        let boundary = "daicho-manual-\(UUID().uuidString)"
        let body = buildMultipart(
            boundary: boundary,
            fields: [
                ("kind", "actual"),
                ("source", source),
                ("clientPhotoId", clientPhotoId),
                ("autoSelect", "false"),
                ("takenAt", ISO8601DateFormatter().string(from: takenAt)),
                ("width", String(width)),
                ("height", String(height)),
            ],
            files: [("original", jpegData), ("work", jpegData), ("thumb", thumbData)]
        )
        let tmpFile = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString).bin")
        try body.write(to: tmpFile, options: .atomic)
        let req = makeRequest("/api/products/\(id)/photos", method: "POST", contentType: "multipart/form-data; boundary=\(boundary)")
        let (data, res) = try await PhotoBackgroundUploader.shared.upload(request: req, bodyFileURL: tmpFile)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            throw parseError(data: data, code: code)
        }
        return try JSONDecoder().decode(PhotoUploadResponse.self, from: data)
    }

    private static func buildMultipart(boundary: String, fields: [(String, String)], files: [(String, Data)]) -> Data {
        var body = Data()
        for (name, value) in fields {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        for (name, data) in files {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(name).jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            body.append(data)
            body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return body
    }

    static func image(_ path: String) async -> Data? {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return try? await request(p.removingPercentEncoding ?? p)
    }
}
