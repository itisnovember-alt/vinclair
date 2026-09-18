// Design Ref: §3 — 화면과 서버가 주고받는 데이터의 모양(약속)
// 화면(src/app, src/components)과 서버(src/app/api)가 모두 이 파일을 함께 쓴다.
// 다른 파일에 의존하지 않는다. (Design Ref: §9 — 공통 약속)

// ─────────────────────────────────────────────
// 1. 식별 결과 (Design Ref: §3.1, /api/identify 응답)
// ─────────────────────────────────────────────

/** 식별 성공 시 라벨에서 읽은 와인 기본 정보 */
export interface IdentifiedWine {
  name: string; // 와인명 (원어)
  producer: string; // 생산자
  vintage: string; // "2019" 또는 "NV"
  country: string | null; // 라벨에서 읽지 못하면 null
  region: string | null;
  grade: string | null;
}

/** 식별 실패 종류 — PRD must 1 AI 규칙 2~5와 1:1 */
export type IdentifyFailure =
  | "UNREADABLE" // 와인명·생산자·빈티지 중 글자를 읽을 수 없음
  | "NO_LABEL" // 와인 라벨이 없음
  | "NOT_WINE" // 와인이 아닌 주류
  | "MULTIPLE_BOTTLES"; // 병이 여러 개

export type IdentifyResult =
  | { ok: true; wine: IdentifiedWine }
  | { ok: false; failure: IdentifyFailure };

// ─────────────────────────────────────────────
// 2. 상세 정보 (Design Ref: §3.2, /api/details 응답)
// ─────────────────────────────────────────────

/**
 * 9개 항목 — 순서와 이름을 코드에 고정한다. (PRD must 2 목록 순서)
 * 화면은 AI 답과 상관없이 이 순서대로 항상 9칸을 그린다. (Plan SC: 9개 항목 100% 표시)
 */
export const DETAIL_KEYS = [
  "origin", // 1. 생산 국가·지역
  "grapes", // 2. 포도 품종 및 블렌딩 비율
  "tasteAroma", // 3. 맛과 향
  "winemaking", // 4. 제조 방법 (오크 숙성·전송이 발효·발효 용기 등)
  "drinkWindow", // 5. 시음 적기 (연도 범위)
  "foodPairing", // 6. 어울리는 음식
  "criticScores", // 7. 평론가 평점
  "producerInfo", // 8. 생산자 정보
  "grade", // 9. 등급
] as const;

export type DetailKey = (typeof DETAIL_KEYS)[number];

/**
 * 항목 상태 — AI는 상태만 알려주고, 화면 글자("정보 없음"·"해당 없음")는 코드가 붙인다.
 * (Design Ref: §1.2, §3.3)
 */
export type FieldStatus =
  | "found" // 찾음
  | "not_found" // 정보 없음
  | "not_applicable"; // 해당 없음 (원래 존재하지 않는 정보)

/**
 * 출처 하나 — 화면에 사이트 이름을 보여주고, 누르면 그 페이지로 이동한다.
 * OpenAI 웹 검색 이용 조건: 출처가 잘 보이고 누르면 이동할 수 있어야 한다. (2026-09-17 사용자 결정)
 */
export interface SourceLink {
  name: string; // 화면에 보이는 이름 — 사이트 도메인(예: "krug.com") 또는 "라벨"
  url: string | null; // 이동할 페이지 주소 — 라벨이면 null
}

/** 평론가 평점 한 줄 */
export interface CriticScore {
  critic: string; // 평가 주체 (평론가 또는 매체)
  score: string; // 예: "95점", "4.1/5"
  source: SourceLink; // 점수를 확인한 페이지
}

/** 상세 정보 한 칸 */
export interface DetailField {
  key: DetailKey;
  status: FieldStatus;
  text: string | null; // status가 found일 때만 값 (4문장 이내, 4번 제조 방법은 10문장 이내)
  reason: string | null; // not_applicable일 때 이유 (예: "미국은 등급 제도가 없음")
  sources: SourceLink[]; // 출처: 웹 검색으로 확인한 페이지, 라벨에서 읽은 값이면 [{ name: "라벨", url: null }]
  vintageBasis: string | null; // 다른 빈티지 정보를 썼을 때 그 연도 (예: "2015")
  scores: CriticScore[]; // 7번 criticScores 칸에서만 사용 (최대 3개), 다른 칸은 빈 배열
}

/** 결과 화면 머리글에 쓰는 확정 와인 정보 — 직접 입력 경로에서도 서버가 채워 돌려준다 */
export interface ConfirmedWine {
  name: string;
  producer: string | null; // 확인되지 않으면 null (화면에서 줄을 숨김)
  vintage: string | null; // "2019" / "NV" / 입력하지 않았으면 null
}

/**
 * 생산지 지도 — PRD must 2 ③ (2026-09-17 추가)
 * 서버가 OpenStreetMap에서 위치를 찾아 채운다. 찾지 못하면 WineDetails.map이 null이고 지도를 그리지 않는다.
 */
export interface WineMap {
  label: string; // 지도 위에 보이는 이름 (예: "프랑스 · 보르도(Bordeaux) 포이약(Pauillac)")
  lat: number; // 표시 핀 위치 (위도)
  lon: number; // 표시 핀 위치 (경도)
  marker: boolean; // 지역 위치를 찾았으면 true — 국가 중심만 찾았으면 핀을 찍지 않는다
  bbox: [west: number, south: number, east: number, north: number]; // 지도에 보이는 범위 (국가와 지역이 함께 보이게 넓게)
}

/**
 * 유사 와인 추천 한 병 — PRD must 2 규칙 13 (2026-09-18 추가)
 * 웹 검색으로 실제로 있다는 것을 확인한 와인만 담는다. 확인된 와인이 없으면 WineDetails.recommendations가 빈 배열 ("정보 없음")
 */
export interface SimilarWine {
  name: string; // 와인 이름 (원어)
  producer: string | null; // 생산자 (원어)
  reason: string; // 추천 이유 (한국어 2문장 이내)
  sources: SourceLink[]; // 확인한 페이지 (1개 이상)
}

export interface WineDetails {
  wine: ConfirmedWine;
  summary: string; // 간략 설명: 3문장·150자 이내
  fields: DetailField[]; // 항상 9개 (빠진 칸은 서버가 not_found로 채움)
  map: WineMap | null; // 생산지 지도 — 위치를 찾지 못하면 null
  recommendations: SimilarWine[]; // 유사 와인 추천 최대 3병 — 확인된 와인이 없으면 빈 배열
}

export type DetailsResult =
  | { ok: true; details: WineDetails }
  | { ok: false; failure: "WINE_NOT_FOUND" };

// ─────────────────────────────────────────────
// 3. 요청과 오류 응답 (Design Ref: §4.3, §6.2)
// ─────────────────────────────────────────────

/** /api/details 요청 — 사진 식별 후에는 6개 값, 직접 입력 후에는 name·vintage만 채운다 */
export interface DetailsRequest {
  name: string; // 1~100자
  producer: string | null;
  vintage: string | null; // 숫자 4자리 또는 "NV" 또는 null
  country: string | null;
  region: string | null;
  grade: string | null;
}

/** 서버 오류 코드 (Design Ref: §4.2, §4.3) */
export type ApiErrorCode = "INVALID_FILE" | "INVALID_INPUT" | "AI_ERROR" | "RATE_LIMITED"; // RATE_LIMITED: 사용 횟수 제한 초과 (PRD 7항, 2026-09-18)

/** 서버 오류 응답 모양 */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}
