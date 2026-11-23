import SwiftUI

enum SearchPurpose: Equatable {
    case matchScan(entryId: UUID, scannedFnsku: String)
    case openDetail
    case addPhoto

    var scannedFnsku: String {
        if case .matchScan(_, let f) = self { return f }
        return ""
    }

    var title: String {
        switch self {
        case .matchScan: return "手動で商品を検索"
        case .openDetail: return "商品検索"
        case .addPhoto: return "写真を追加する商品を検索"
        }
    }
}

struct SearchTarget: Identifiable {
    let id = UUID()
    let purpose: SearchPurpose
}

struct FnskuBranchTarget: Identifiable {
    let id = UUID()
    let entryId: UUID
    let card: Card
    let scannedFnsku: String
}

struct SearchHit: Identifiable {
    var id: String { item.productId }
    let item: SearchProjection
    let score: Int
    let reason: String
}

struct SimilarCodeHit: Identifiable {
    var id: String { item.productId }
    let item: SearchProjection
    let diffNote: String
}

enum ClassifiedInput {
    case fnsku(String)
    case asin(String)
    case jan(String)
    case productId(String)
    case name(String)
}

enum SearchEngine {
    static let fnskuRegex = try! NSRegularExpression(pattern: #"^X00[0-9A-Z]{7}$"#)
    static let asinRegex = try! NSRegularExpression(pattern: #"^[A-Z0-9]{10}$"#)
    static let janRegex = try! NSRegularExpression(pattern: #"^(?:\d{8}|\d{13})$"#)
    static let prodIdRegex = try! NSRegularExpression(pattern: #"^#?(\d{4})$"#)

    /// Input classification order (T-014): FNSKU -> ASIN -> JAN -> Product ID -> Name.
    static func classifyInput(_ raw: String) -> ClassifiedInput {
        let trimmed = SearchNormalizer.strict(raw).uppercased()
        let compact = trimmed.replacingOccurrences(of: #"[\s-]"#, with: "", options: .regularExpression)
        if matches(fnskuRegex, compact) { return .fnsku(compact) }
        if matches(asinRegex, compact), compact.hasPrefix("B0") || compact.contains(where: \.isLetter) {
            return .asin(compact)
        }
        if matches(janRegex, compact) { return .jan(compact) }
        if let m = prodIdRegex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
           let r = Range(m.range(at: 1), in: trimmed) {
            return .productId(String(trimmed[r]))
        }
        return .name(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static func looksLikeAlnumCode(_ s: String) -> Bool {
        let t = SearchNormalizer.strict(s).uppercased()
        guard t.count >= 4, t.count <= 14 else { return false }
        return t.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } && t.contains(where: \.isLetter)
    }

    static func search(query: String, in catalog: [SearchProjection]) -> (hits: [SearchHit], similarCodes: [SimilarCodeHit]) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return (catalog.prefix(40).map { SearchHit(item: $0, score: 0, reason: "") }, [])
        }
        let strictQ = SearchNormalizer.strict(trimmed)
        let looseQ = SearchNormalizer.loose(trimmed)
        let upperQ = strictQ.uppercased()
        let cleanIdQ = upperQ.hasPrefix("#") ? String(upperQ.dropFirst()) : upperQ
        let terms = strictQ.split(whereSeparator: \.isWhitespace).map(String.init).filter { !$0.isEmpty }
        let looseTerms = terms.map { SearchNormalizer.loose($0) }.filter { !$0.isEmpty }

        var hits: [SearchHit] = []
        var matchedIds = Set<String>()

        for item in catalog {
            var score = 0
            var reason = ""

            // 1. Exact identifier match (highest rank)
            if !item.fnsku.isEmpty && item.fnsku == upperQ {
                score = 1000; reason = "FNSKU一致"
            } else if !item.asin.isEmpty && item.asin == upperQ {
                score = 990; reason = "ASIN一致"
            } else if !item.jan.isEmpty && item.jan == upperQ {
                score = 980; reason = "JAN一致"
            } else if item.productId == cleanIdQ || (!item.productCode.isEmpty && item.productCode.uppercased() == upperQ) {
                score = 970; reason = "商品番号一致"
            }
            // 2. Exact product name match
            else if item.strictNormName == strictQ {
                score = 800; reason = "商品名完全一致"
            }
            // 3. Prefix match (name or FNSKU/code)
            else if item.strictNormName.hasPrefix(strictQ) {
                score = 650; reason = "商品名前方一致"
            } else if !item.fnsku.isEmpty && (item.fnsku.hasPrefix(upperQ) || (upperQ.count >= 4 && item.fnsku.hasSuffix(upperQ))) {
                score = 620; reason = "FNSKU部分一致"
            } else if !item.jan.isEmpty && item.jan.contains(upperQ) && upperQ.count >= 4 {
                score = 600; reason = "JAN部分一致"
            } else if !item.asin.isEmpty && item.asin.contains(upperQ) && upperQ.count >= 4 {
                score = 600; reason = "ASIN部分一致"
            }
            // 4. Substring match on name or aliases (strict preferred over loose)
            else if item.strictNormName.contains(strictQ) {
                score = 480; reason = "商品名一致"
            } else if item.aliases.contains(where: { SearchNormalizer.strict($0).contains(strictQ) }) {
                score = 450; reason = "別名・型番一致"
            } else if !looseQ.isEmpty && item.looseNormName.contains(looseQ) {
                score = 400; reason = "商品名（緩一致）"
            }
            // 5. Multi-term AND across fields
            else if terms.count >= 2 {
                let strictHay = [item.productId, item.productCode, item.strictNormName, item.strictNormBrand, item.fnsku.lowercased(), item.jan.lowercased(), item.asin.lowercased(), item.aliases.map { SearchNormalizer.strict($0) }.joined(separator: " ")].joined(separator: " ")
                let looseHay = SearchNormalizer.loose(strictHay)
                if terms.allSatisfy({ strictHay.contains($0) }) {
                    score = 320; reason = "複数語一致"
                } else if !looseTerms.isEmpty && looseTerms.allSatisfy({ looseHay.contains($0) }) {
                    score = 280; reason = "複数語（緩一致）"
                }
            }
            // 6. Brand-only match
            if score == 0 && !item.strictNormBrand.isEmpty && item.strictNormBrand.contains(strictQ) {
                score = 150; reason = "ブランド一致"
            }

            if score > 0 {
                hits.append(SearchHit(item: item, score: score, reason: reason))
                matchedIds.insert(item.productId)
            }
        }

        hits.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            return a.item.productId < b.item.productId
        }

        // Confusable characters (O<->0, I/l<->1) ONLY for alphanumeric code queries (FNSKU / ASIN), separate section!
        var similarCodes: [SimilarCodeHit] = []
        if terms.count == 1 && looksLikeAlnumCode(trimmed) {
            let qSkel = SearchNormalizer.confusableCode(trimmed)
            if qSkel.count >= 4 {
                for item in catalog where !matchedIds.contains(item.productId) {
                    if !item.fnsku.isEmpty {
                        let fSkel = SearchNormalizer.confusableCode(item.fnsku)
                        if fSkel == qSkel || (qSkel.count >= 4 && fSkel.hasSuffix(qSkel)) || fSkel.contains(qSkel) {
                            let note = describeConfusableDiff(query: upperQ, target: item.fnsku)
                            similarCodes.append(SimilarCodeHit(item: item, diffNote: note))
                            continue
                        }
                    }
                    if !item.asin.isEmpty {
                        let aSkel = SearchNormalizer.confusableCode(item.asin)
                        if aSkel == qSkel {
                            let note = describeConfusableDiff(query: upperQ, target: item.asin)
                            similarCodes.append(SimilarCodeHit(item: item, diffNote: note))
                        }
                    }
                }
            }
        }

        return (Array(hits.prefix(80)), Array(similarCodes.prefix(20)))
    }

    private static func describeConfusableDiff(query: String, target: String) -> String {
        var diffs: [String] = []
        if (query.contains("O") && target.contains("0")) || (query.contains("0") && target.contains("O")) {
            diffs.append("O と 0 が異なります")
        }
        if (query.contains("I") || query.contains("L")) && target.contains("1") || (query.contains("1") && (target.contains("I") || target.contains("L"))) {
            diffs.append("I/l と 1 が異なります")
        }
        return diffs.isEmpty ? "似た英数コード（厳密一致ではありません）" : diffs.joined(separator: "・")
    }

    static func highlighted(_ text: String, query: String) -> AttributedString {
        var attr = AttributedString(text)
        let terms = query.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { !$0.isEmpty }
        for term in terms {
            var searchStart = text.startIndex
            while searchStart < text.endIndex,
                  let range = text.range(of: term, options: [.caseInsensitive, .widthInsensitive], range: searchStart..<text.endIndex) {
                if let lower = AttributedString.Index(range.lowerBound, within: attr),
                   let upper = AttributedString.Index(range.upperBound, within: attr) {
                    attr[lower..<upper].backgroundColor = Color.yellow.opacity(0.35)
                    attr[lower..<upper].font = .subheadline.bold()
                }
                searchStart = range.upperBound
            }
        }
        return attr
    }
}

/// Highlight the last 4 characters of an FNSKU in monospace font for rapid visual verification (T-014).
struct FnskuCodeText: View {
    let fnsku: String
    var body: some View {
        if fnsku.isEmpty {
            Text("FNSKU未登録").font(.caption2.bold()).foregroundStyle(.blue)
        } else if fnsku.count > 4 {
            let head = String(fnsku.dropLast(4))
            let tail = String(fnsku.suffix(4))
            (Text(head).foregroundColor(.secondary) + Text(tail).bold().foregroundColor(.primary))
                .font(.caption.monospaced())
        } else {
            Text(fnsku).font(.caption.monospaced().bold())
        }
    }
}

/// Part 4 (T-013): 4-choice branch sheet when scanned FNSKU differs from selected product's registered FNSKU.
struct FnskuBranchSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    let target: FnskuBranchTarget

    @State private var showCorrectionForm = false
    @State private var selectedReason = "ラベル誤登録の訂正"
    @State private var customReason = ""
    @State private var submitting = false
    @State private var errorMsg = ""

    private let reasons = ["ラベル誤登録の訂正", "入力ミスの訂正", "別商品と取り違えて登録していた", "その他"]

    var body: some View {
        NavigationStack {
            List {
                Section("番号の比較（不一致のため通常確定できません）") {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("スキャンした番号").font(.caption).foregroundStyle(.secondary)
                            FnskuCodeText(fnsku: target.scannedFnsku)
                        }
                        Spacer()
                        Image(systemName: "arrow.left.arrow.right").foregroundStyle(.orange)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("選択商品の登録番号").font(.caption).foregroundStyle(.secondary)
                            FnskuCodeText(fnsku: target.card.fnsku)
                        }
                    }
                    .padding(.vertical, 4)
                    Text("#\(target.card.id) \(target.card.name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                if !showCorrectionForm {
                    Section("対応を選んでください") {
                        Button {
                            dismiss()
                            model.openNewRegistrationFromBranch(entryId: target.entryId, fnsku: target.scannedFnsku, referenceName: target.card.name)
                        } label: {
                            Label("別の在庫個体として登録する（新規登録へ）", systemImage: "plus.rectangle.on.folder")
                        }

                        Button {
                            dismiss()
                            model.rescanFromBranch(entryId: target.entryId)
                        } label: {
                            Label("ラベルを確認して再スキャンする", systemImage: "barcode.viewfinder")
                        }

                        Button {
                            showCorrectionForm = true
                        } label: {
                            Label("登録番号の誤りを訂正する", systemImage: "pencil.line")
                                .foregroundStyle(.secondary)
                        }

                        Button(role: .cancel) {
                            dismiss()
                        } label: {
                            Label("今回は取り消す", systemImage: "xmark")
                        }
                    }
                } else {
                    Section("登録番号の訂正（確認）") {
                        Text("商品 #\(target.card.id) の登録 FNSKU を「\(target.card.fnsku)」から「\(target.scannedFnsku)」へ訂正します。過去のスキャン記録は書き換えず、訂正履歴を残します。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Picker("訂正の理由", selection: $selectedReason) {
                            ForEach(reasons, id: \.self) { r in Text(r).tag(r) }
                        }
                        if selectedReason == "その他" {
                            TextField("理由を入力（任意）", text: $customReason)
                        }
                        if !errorMsg.isEmpty {
                            Text(errorMsg).font(.caption).foregroundStyle(.red)
                        }
                        Button {
                            Task { await performCorrection() }
                        } label: {
                            if submitting {
                                ProgressView().frame(maxWidth: .infinity)
                            } else {
                                Text("この内容で FNSKU を訂正する").frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting)

                        Button("戻る") { showCorrectionForm = false }
                    }
                }
            }
            .navigationTitle("FNSKU 不一致の確認")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
            .onAppear { model.addPauseReason(.fnskuBranchSheet) }
            .onDisappear { model.removePauseReason(.fnskuBranchSheet) }
        }
    }

    private func performCorrection() async {
        submitting = true
        defer { submitting = false }
        errorMsg = ""
        let reason = selectedReason == "その他" ? customReason.trimmingCharacters(in: .whitespacesAndNewlines) : selectedReason
        do {
            try await model.correctProductFnsku(entryId: target.entryId, productId: target.card.id, newFnsku: target.scannedFnsku, reason: reason)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

/// Part 7 (T-014): Unified manual product search sheet across .matchScan / .openDetail / .addPhoto.
struct ProductSearchSheet: View {
    @EnvironmentObject var model: ScanModel
    @Environment(\.dismiss) private var dismiss

    let target: SearchTarget

    @State private var query = ""
    @State private var verifyingId: String?
    @State private var verifyError = ""
    @State private var retryItem: SearchProjection?
    @State private var showNewRegChoice = false
    @State private var fnskuChoicePair: (scanned: String, typed: String)?
    @State private var showNotFoundAction = false

    private var results: (hits: [SearchHit], similarCodes: [SimilarCodeHit]) {
        SearchEngine.search(query: query, in: model.catalogItems)
    }

    private var scannedFnsku: String { target.purpose.scannedFnsku }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !scannedFnsku.isEmpty {
                    HStack {
                        Image(systemName: "barcode")
                        Text("現在スキャンした番号：")
                        FnskuCodeText(fnsku: scannedFnsku)
                        Spacer()
                    }
                    .font(.caption.bold())
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.blue.opacity(0.1))
                }

                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("商品名・FNSKU・ASIN・JAN・#番号・ブランド", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = ""; verifyError = ""; retryItem = nil } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(10)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                if !verifyError.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text(verifyError).font(.caption).foregroundStyle(.primary)
                        Spacer()
                        if let item = retryItem {
                            Button("再試行") { Task { await selectProjection(item, fromSimilarCode: false) } }
                                .buttonStyle(.bordered)
                                .font(.caption2)
                        }
                    }
                    .padding(10)
                    .background(Color.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                }

                let res = results
                List {
                    if !res.hits.isEmpty {
                        Section("検索結果（\(res.hits.count)件）") {
                            ForEach(res.hits) { hit in
                                searchRow(hit.item, badgeNote: hit.reason, isSimilarCode: false)
                            }
                        }
                    }

                    if !res.similarCodes.isEmpty {
                        Section("似た番号の候補（\(res.similarCodes.count)件）") {
                            ForEach(res.similarCodes) { sim in
                                searchRow(sim.item, badgeNote: sim.diffNote, isSimilarCode: true)
                            }
                        }
                    }

                    if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && res.hits.isEmpty && res.similarCodes.isEmpty {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("一致する商品が見つかりませんでした").font(.subheadline.bold())
                                Text("表記揺れや別の語（ブランド名・型番・末尾4桁など）でも探せます。")
                                    .font(.caption).foregroundStyle(.secondary)
                                if case .matchScan = target.purpose {
                                    Button {
                                        startNewRegistrationFlow()
                                    } label: {
                                        Label("この情報で新規登録へ進む", systemImage: "plus.circle.fill")
                                            .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(.borderedProminent)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    } else if case .matchScan = target.purpose, showNotFoundAction {
                        Section {
                            Button {
                                startNewRegistrationFlow()
                            } label: {
                                Label("見つからない → 新規登録へ進む", systemImage: "plus.circle")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                .listStyle(.plain)
                .refreshable {
                    await model.refreshCatalog()
                }
            }
            .navigationTitle(target.purpose.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("キャンセル") { dismiss() }
                }
                if case .matchScan = target.purpose {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("見つからない") { showNotFoundAction = true }
                            .font(.caption)
                    }
                }
            }
            .onChange(of: query) { _, newQ in
                let trimmed = newQ.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.count >= 2 && results.hits.isEmpty && results.similarCodes.isEmpty {
                    model.localStore.logZeroResultSearch(query: trimmed)
                }
            }
            .onAppear { model.addPauseReason(.searchSheet) }
            .onDisappear { model.removePauseReason(.searchSheet) }
            .confirmationDialog(
                "スキャンした FNSKU と入力した FNSKU が異なります",
                isPresented: $showNewRegChoice,
                titleVisibility: .visible
            ) {
                if let pair = fnskuChoicePair {
                    Button("スキャン番号（\(pair.scanned)）を使う") {
                        proceedToNewRegistration(chosenFnsku: pair.scanned)
                    }
                    Button("手入力した番号（\(pair.typed)）を使う") {
                        proceedToNewRegistration(chosenFnsku: pair.typed)
                    }
                }
                Button("キャンセル", role: .cancel) {}
            }
        }
    }

    @ViewBuilder
    private func searchRow(_ item: SearchProjection, badgeNote: String, isSimilarCode: Bool) -> some View {
        let fnskuBadge: (text: String, color: Color)? = {
            guard !scannedFnsku.isEmpty else { return nil }
            if item.fnsku.isEmpty { return ("FNSKU未登録", .blue) }
            if !isSimilarCode && item.fnsku.uppercased() == scannedFnsku.uppercased() { return ("FNSKU一致", .green) }
            return ("別FNSKU済", .orange)
        }()

        Button {
            Task { await selectProjection(item, fromSimilarCode: isSimilarCode) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Thumb(path: item.official ?? item.thumb)
                    .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 4) {
                    Text(SearchEngine.highlighted(item.name, query: query))
                        .font(.subheadline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        FnskuCodeText(fnsku: item.fnsku)
                        if let b = fnskuBadge {
                            Text(b.text)
                                .font(.caption2.bold())
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(b.color.opacity(0.16), in: Capsule())
                                .foregroundStyle(b.color)
                        }
                    }
                    HStack(spacing: 6) {
                        Text("#\(item.productId)").font(.caption2.monospaced()).foregroundStyle(.secondary)
                        if !item.brand.isEmpty {
                            Text(item.brand).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        if item.presence == "have" || item.stockCheckedAt != nil {
                            Text("在庫確認済").font(.caption2).foregroundStyle(.green)
                        }
                        if item.decision == "no_sell" {
                            Text("売らない").font(.caption2).foregroundStyle(.purple)
                        }
                    }
                    if !badgeNote.isEmpty {
                        Text(badgeNote)
                            .font(.caption2)
                            .foregroundStyle(isSimilarCode ? .orange : .secondary)
                    }
                }
                Spacer(minLength: 4)
                if verifyingId == item.productId {
                    ProgressView()
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(verifyingId != nil)
    }

    /// Re-verify selected productId against live GET /api/products/:id before applying (T-014).
    private func selectProjection(_ item: SearchProjection, fromSimilarCode: Bool) async {
        verifyingId = item.productId
        verifyError = ""
        retryItem = nil
        defer { verifyingId = nil }

        do {
            let live = try await Api.fetchProductDetail(id: item.productId)
            if live.trashedAt != nil {
                model.localStore.removeCatalogProduct(id: item.productId)
                model.refreshCatalogFromStore()
                verifyError = "この商品は削除済みのため使用できません"
                return
            }
            let card = live.toCard()
            model.localStore.cacheCard(card)
            model.localStore.upsertCatalogItem(from: card, rev: live.rev)
            model.refreshCatalogFromStore()

            dismiss()
            model.applySearchSelection(purpose: target.purpose, liveDetail: live, card: card, fromSimilarCode: fromSimilarCode)
        } catch let err as ApiError where err.statusCode == 404 {
            model.localStore.removeCatalogProduct(id: item.productId)
            model.refreshCatalogFromStore()
            verifyError = "この商品は削除済みのため使用できません"
        } catch {
            retryItem = item
            if !model.isOnline, case .matchScan = target.purpose {
                verifyError = "オフラインのため最新情報を確認できません。復帰後に再試行してください。"
            } else {
                verifyError = "最新情報を確認できません。再試行してください（\(error.localizedDescription)）"
            }
        }
    }

    private func startNewRegistrationFlow() {
        let classified = SearchEngine.classifyInput(query)
        if case .fnsku(let typedFnsku) = classified, !scannedFnsku.isEmpty, typedFnsku.uppercased() != scannedFnsku.uppercased() {
            fnskuChoicePair = (scanned: scannedFnsku, typed: typedFnsku)
            showNewRegChoice = true
            return
        }
        let chosenFnsku: String
        if !scannedFnsku.isEmpty {
            chosenFnsku = scannedFnsku
        } else if case .fnsku(let typed) = classified {
            chosenFnsku = typed
        } else {
            chosenFnsku = ""
        }
        proceedToNewRegistration(chosenFnsku: chosenFnsku)
    }

    private func proceedToNewRegistration(chosenFnsku: String) {
        let classified = SearchEngine.classifyInput(query)
        let jan: String = { if case .jan(let j) = classified { return j }; return "" }()
        let name: String = { if case .name(let n) = classified { return n }; return "" }()
        dismiss()
        if case .matchScan(let entryId, _) = target.purpose {
            model.openNewRegistrationFromSearch(entryId: entryId, fnsku: chosenFnsku, jan: jan, name: name)
        }
    }
}
