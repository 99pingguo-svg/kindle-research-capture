// 相場の候補を「同じ／似た」と数える基準（judge-tasks.js と judge-decide.js で共有）。
// 2026-10-29、Claude が判定済みのメルカリ 51商品・約600候補で確かめた値。
export const SAME_DIST = 10; // 公式画像とほぼ同じ写真（dHash 距離）→ 同じ商品
export const SAME_DIST_WITH_AI = 12; // ローカルAIも「同じ」と言えばここまで同じ商品
export const SIMILAR_PRICE_CAP = 1.2; // 似た商品は Amazon 価格のこの倍率まで
export const SIMILAR_MAX_DIST = 30; // 似た商品として見る写真の遠さの上限
