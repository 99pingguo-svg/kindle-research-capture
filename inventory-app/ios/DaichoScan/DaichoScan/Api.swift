import Foundation

/// One product as the scan screen shows it (server/scan.js `scanCard`).
struct Card: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let short: String
    let say: String
    let arrivalDate: String
    let arrivalId: String
    let dateId: String
    let productCode: String
    let fnsku: String
    let thumb: String?
    let official: String?
    let shotDate: String
    let presence: String?
    let hasOwnPhoto: Bool
    let why: String
    let score: Double
    let noted: String?
}

struct Lookup: Decodable {
    let fnsku: String
    let pick: Card?
    let candidates: [Card]
    let say: String
}

struct ApiError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The ledger on the Mac (through Tailscale). Every request carries the token and acts as the user.
enum Api {
    static func request(_ path: String, method: String = "GET", json: [String: Any]? = nil, body: Data? = nil, contentType: String? = nil) async throws -> Data {
        var req = URLRequest(url: Config.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("Bearer \(Config.token)", forHTTPHeaderField: "Authorization")
        req.setValue("user", forHTTPHeaderField: "x-actor")
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        } else if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "content-type")
        }
        let (data, res) = try await URLSession.shared.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ApiError(message: msg ?? "台帳の応答 \(code)")
        }
        return data
    }

    static func scan(codes: [String], lines: [String]) async throws -> Lookup {
        let d = try await request("/api/scan", method: "POST", json: ["codes": codes, "lines": lines])
        return try JSONDecoder().decode(Lookup.self, from: d)
    }

    /// Mark it present (ある) and keep the warehouse label number when the product has none.
    static func confirm(id: String, fnsku: String, presence: Bool) async throws -> Card {
        let d = try await request("/api/scan/confirm", method: "POST", json: ["id": id, "fnsku": fnsku, "presence": presence])
        return try JSONDecoder().decode(Card.self, from: d)
    }

    /// A real photo of the product (source "scan"): its shot time is when the item was seen.
    static func uploadPhoto(id: String, photo: PhotoData, clientId: String) async throws {
        let boundary = "daicho-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        func file(_ name: String, _ data: Data) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(name).jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
            body.append(data)
            body.append("\r\n".data(using: .utf8)!)
        }
        field("kind", "actual")
        field("source", "scan")
        field("clientId", clientId)
        field("takenAt", ISO8601DateFormatter().string(from: photo.takenAt))
        field("width", String(photo.width))
        field("height", String(photo.height))
        file("original", photo.original)
        file("work", photo.work)
        file("thumb", photo.thumb)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        _ = try await request("/api/products/\(id)/photos", method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
    }

    static func image(_ path: String) async -> Data? {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return try? await request(p.removingPercentEncoding ?? p)
    }
}
