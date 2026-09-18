// Design Ref: §2.3, §6.3 — AI가 돌려준 답이 약속한 모양인지 검사하는 파일 (zod)
// 여기서 정한 모양은 OpenAI에 "이 모양으로 답해줘"라고 보낼 때도 그대로 쓴다.
// 그래서 AI에게 보내는 모양에는 글자 수·개수 같은 조건을 넣지 않고,
// 그런 조건은 답을 받은 뒤 검사(superRefine)에서 따로 확인한다.
import { z } from "zod";

import type { DetailKey, FieldStatus, IdentifyFailure } from "@/types/wine";

// ─────────────────────────────────────────────
// 1. 분량 기준 (Design Ref: §6.3, PRD must 2 규칙 1·4·10)
// ─────────────────────────────────────────────

export const SUMMARY_MAX_CHARS = 150;
export const SUMMARY_MAX_SENTENCES = 3;
export const FIELD_MAX_SENTENCES = 4;
/** 4번 제조 방법 칸만 10문장까지 (PRD must 2 규칙 4, 2026-09-18 변경) */
export const WINEMAKING_MAX_SENTENCES = 10;
export const MAX_CRITIC_SCORES = 3;
/** 추측성 표현은 결과 한 건 전체에서 최대 3회까지 (PRD must 2 규칙 9, 2026-09-18 변경) */
export const MAX_SPECULATIVE_PHRASES = 3;
/** 유사 와인 추천 — 최대 병 수와 추천 이유 최대 문장 수 (PRD must 2 규칙 13) */
export const MAX_RECOMMENDATIONS = 3;
export const RECOMMENDATION_MAX_SENTENCES = 2;

/** 빈티지 형식: 숫자 4자리 또는 "NV" */
export const VINTAGE_PATTERN = /^(\d{4}|NV)$/;

/** 시음 적기 연도 범위 — "2025~2032년" 모양 (PRD must 2 규칙 11). 물결 대신 줄표를 써도 범위로 본다 */
export const DRINK_WINDOW_PATTERN = /\d{4}\s*[~～–—-]\s*\d{4}/;

/**
 * 추측성 표현 — 결과 한 건 전체에서 합쳐 3회를 넘으면 규칙 위반으로 본다 (PRD must 2 규칙 9)
 * "아마"만 쓰면 "아마로네(Amarone)" 같은 와인 이름에 걸리므로 "아마도"로 찾는다.
 */
export const SPECULATIVE_PHRASES = [
  "아마도",
  "추정",
  "짐작",
  "일 것이다",
  "일 것입니다",
  "것으로 보인다",
  "것으로 보입니다",
  "듯하다",
  "듯합니다",
  "가능성이 높",
  "일반적으로",
] as const;

/**
 * 간략 설명에 넣지 않는 "찾지 못했다"는 말 (PRD must 2 규칙 1)
 * 확인되지 않은 요소는 언급 없이 빼야 하므로, 이런 말이 보이면 규칙 위반으로 본다.
 */
export const SUMMARY_MISSING_PHRASES = [
  "찾지 못",
  "찾을 수 없",
  "확인되지 않",
  "확인할 수 없",
  "알려지지 않",
  "알 수 없",
  "정보가 없",
  "정보 없음",
  "해당 없음",
] as const;

/** 글에 추측성 표현이 몇 번 나오는지 — 같은 표현이 두 번 나오면 2회로 센다 */
export function countSpeculativePhrases(text: string | null | undefined): number {
  if (!text) return 0;
  return SPECULATIVE_PHRASES.reduce((sum, phrase) => sum + (text.split(phrase).length - 1), 0);
}

/** 글자 수 — 띄어쓰기를 포함해 세고, 앞뒤 공백은 뺀다 */
export function countChars(text: string): number {
  // 한글·이모지도 한 글자로 세기 위해 문자 단위로 나눈다
  return [...text.trim()].length;
}

/**
 * 문장 수 — 마침표·물음표·느낌표 뒤에 공백이 오거나 글이 끝나면 한 문장으로 센다.
 * 괄호 안의 부호, 숫자 사이 마침표(예: 13.5%)는 문장 끝으로 보지 않는다.
 */
export function countSentences(text: string): number {
  const chars = [...text.trim()];
  let count = 0;
  let depth = 0; // 괄호 안에 있는지
  let hasContent = false; // 마지막 문장 끝 이후에 글자가 있었는지

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const prev = chars[i - 1];
    const next = chars[i + 1];

    if (ch === "(") depth++;
    if (ch === ")" && depth > 0) depth--;

    const isEndMark = ch === "." || ch === "?" || ch === "!";
    if (!isEndMark) {
      if (!/\s/.test(ch)) hasContent = true;
      continue;
    }
    if (depth > 0) continue;
    if (ch === "." && /\d/.test(prev ?? "") && /\d/.test(next ?? "")) continue;

    const endsHere = next === undefined || /\s/.test(next);
    if (endsHere && hasContent) {
      count++;
      hasContent = false;
    }
  }

  // 부호 없이 끝난 마지막 문장
  if (hasContent) count++;
  return count;
}

/**
 * 글자 수를 넘는 간략 설명에서 뒤쪽 문장을 통째로 빼, 기준 안에 드는 앞부분만 남긴다.
 * 문장 중간을 자르지 않는다. 첫 문장만으로도 기준을 넘으면 null (Design Ref: §6.3)
 */
export function keepWholeSentences(text: string, maxChars: number, maxSentences: number): string | null {
  const chars = [...text.trim()];
  let depth = 0;
  let best: string | null = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "(") depth++;
    if (ch === ")" && depth > 0) depth--;
    const isEnd = (ch === "." || ch === "?" || ch === "!") && depth === 0 && (chars[i + 1] === undefined || /\s/.test(chars[i + 1]));
    if (ch === "." && /\d/.test(chars[i - 1] ?? "") && /\d/.test(chars[i + 1] ?? "")) continue;
    if (!isEnd) continue;
    const candidate = chars.slice(0, i + 1).join("").trim();
    if (countChars(candidate) > maxChars) break;
    if (countSentences(candidate) <= maxSentences) best = candidate;
  }
  return best;
}

// ─────────────────────────────────────────────
// 2. 식별 답 모양 (Design Ref: §3.1, §4.2)
// ─────────────────────────────────────────────

/** 식별 실패 종류 — types/wine.ts의 IdentifyFailure와 같아야 한다 */
export const IDENTIFY_FAILURES = [
  "UNREADABLE",
  "NO_LABEL",
  "NOT_WINE",
  "MULTIPLE_BOTTLES",
] as const satisfies readonly IdentifyFailure[];

/**
 * AI가 돌려주는 식별 답
 * - status가 "OK"이면 wine에 라벨에서 읽은 정보를 담는다
 * - 실패면 wine은 null
 */
export const identifyAiSchema = z
  .object({
    status: z.enum(["OK", ...IDENTIFY_FAILURES]),
    wine: z
      .object({
        name: z.string(),
        producer: z.string(),
        vintage: z.string(), // "2019" 또는 "NV"
        // 빈티지 연도가 라벨에 어떻게 보이는지 — 코드가 이 값으로 NV·재촬영을 결정한다 (PLAN 작업 19, 2026-09-17 사용자 결정)
        //   readable: 연도가 인쇄되어 있고 읽힘 / unreadable: 인쇄되어 있지만 흐리거나 가려져 읽을 수 없음 / none: 연도 표기가 없음
        vintageEvidence: z.enum(["readable", "unreadable", "none"]),
        country: z.string().nullable(),
        region: z.string().nullable(),
        grade: z.string().nullable(),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "OK") {
      if (value.wine === null) {
        ctx.addIssue({ code: "custom", message: "식별 성공인데 와인 정보가 없음", path: ["wine"] });
        return;
      }
      if (!value.wine.name.trim() || !value.wine.producer.trim()) {
        ctx.addIssue({ code: "custom", message: "와인명 또는 생산자가 비어 있음", path: ["wine"] });
      }
      // 연도가 흐려 읽을 수 없는 경우는 코드가 재촬영 안내로 바꾸므로 형식 검사를 하지 않는다
      if (value.wine.vintageEvidence !== "unreadable" && !VINTAGE_PATTERN.test(value.wine.vintage)) {
        ctx.addIssue({ code: "custom", message: "빈티지가 숫자 4자리 또는 NV가 아님", path: ["wine", "vintage"] });
      }
    } else if (value.wine !== null) {
      ctx.addIssue({ code: "custom", message: "식별 실패인데 와인 정보가 있음", path: ["wine"] });
    }
  });

export type IdentifyAiOutput = z.infer<typeof identifyAiSchema>;

// ─────────────────────────────────────────────
// 3. 상세 정보 답 모양 (Design Ref: §3.2, §4.3, §6.3)
// ─────────────────────────────────────────────

/** 항목 상태 — types/wine.ts의 FieldStatus와 같아야 한다 */
export const FIELD_STATUSES = [
  "found",
  "not_found",
  "not_applicable",
] as const satisfies readonly FieldStatus[];

const criticScoreAiSchema = z.object({
  critic: z.string(), // 평가 주체 (평론가 또는 매체)
  score: z.string(), // 예: "95점", "4.1/5"
  source: z.string(), // 점수를 확인한 페이지의 전체 주소 (서버가 실제 검색 결과와 대조해 링크로 바꾼다)
});

/** 상세 정보 한 칸 (칸 이름 key는 아래 fields 객체의 이름으로 정해진다) — maxSentences: 이 칸의 최대 문장 수 */
function makeDetailFieldAiSchema(maxSentences: number) {
  return z
  .object({
    status: z.enum(FIELD_STATUSES),
    text: z.string().nullable(), // found일 때 내용
    reason: z.string().nullable(), // not_applicable일 때 이유
    sources: z.array(z.string()), // 확인한 페이지의 전체 주소, 라벨 값이면 ["라벨"] (서버가 링크로 바꾼다)
    vintageBasis: z.string().nullable(), // 다른 빈티지 정보를 썼을 때 그 연도
    scores: z.array(criticScoreAiSchema), // 7번 평론가 평점 칸에서만 사용
  })
  .superRefine((field, ctx) => {
    if (field.text !== null && countSentences(field.text) > maxSentences) {
      ctx.addIssue({ code: "custom", message: `항목 내용이 ${maxSentences}문장을 넘음`, path: ["text"] });
    }
    if (field.scores.length > MAX_CRITIC_SCORES) {
      ctx.addIssue({ code: "custom", message: `평론가 평점이 ${MAX_CRITIC_SCORES}개를 넘음`, path: ["scores"] });
    }
    // 기준 빈티지 형식(숫자 4자리)은 여기서 거절하지 않고 route.ts가 정리한다 — "NV"·"2015년" 같은 값 하나 때문에
    // 답 전체를 버리고 웹 검색을 처음부터 다시 하면 시간이 두 배가 된다 (2026-09-18 재측정: 크루그 81초)
    // PRD must 2 규칙 6 — "해당 없음"에는 이유를 짧게 덧붙인다
    if (field.status === "not_applicable" && !field.reason?.trim()) {
      ctx.addIssue({ code: "custom", message: "해당 없음인데 이유가 없음", path: ["reason"] });
    }
    // PRD must 2 규칙 9 (추측성 표현 최대 3회)는 결과 전체를 합쳐 세야 하므로 아래 checkSpeculative에서 검사한다
  });
}

export const detailFieldAiSchema = makeDetailFieldAiSchema(FIELD_MAX_SENTENCES);
const winemakingFieldAiSchema = makeDetailFieldAiSchema(WINEMAKING_MAX_SENTENCES);

/** 9개 칸을 이름별로 담는 모양 — 이름이 하나라도 빠지면 타입 검사에서 오류가 난다 */
const detailFieldsShape = {
  origin: detailFieldAiSchema,
  grapes: detailFieldAiSchema,
  tasteAroma: detailFieldAiSchema,
  winemaking: winemakingFieldAiSchema,
  drinkWindow: detailFieldAiSchema,
  foodPairing: detailFieldAiSchema,
  criticScores: detailFieldAiSchema,
  producerInfo: detailFieldAiSchema,
  grade: detailFieldAiSchema,
} satisfies Record<DetailKey, typeof detailFieldAiSchema>;

const confirmedWineAiSchema = z.object({
  name: z.string(),
  producer: z.string().nullable(),
  vintage: z.string().nullable(), // "2019" / "NV" / null
});

/**
 * 간략 설명 한 글이 규칙에 맞는지 — 어긋난 점 목록 (맞으면 빈 배열)
 * 분량(Design Ref: §6.3), 찾지 못했다는 표현(규칙 1). 추측성 표현(규칙 9)은 결과 전체로 따로 센다.
 * 답 모양 검사와, 칸이 "정보 없음"으로 바뀐 뒤 간략 설명을 다시 쓸 때(route.ts) 함께 쓴다.
 */
export function findSummaryProblems(summary: string): string[] {
  const problems: string[] = [];
  if (!summary.trim()) problems.push("간략 설명이 비어 있음");
  if (countChars(summary) > SUMMARY_MAX_CHARS) problems.push(`간략 설명이 ${SUMMARY_MAX_CHARS}자를 넘음`);
  if (countSentences(summary) > SUMMARY_MAX_SENTENCES) problems.push(`간략 설명이 ${SUMMARY_MAX_SENTENCES}문장을 넘음`);
  // PRD must 2 규칙 1 — 확인되지 않은 요소는 "찾지 못했습니다" 같은 말 없이 뺀다
  const missing = SUMMARY_MISSING_PHRASES.filter((phrase) => summary.includes(phrase));
  if (missing.length > 0) problems.push(`간략 설명에 찾지 못했다는 표현 사용 (${missing.join(", ")})`);
  return problems;
}

/** 간략 설명 검사 — 답 모양 검사용 (비어 있는지는 checkDetailsStatus가 본다) */
function checkSummary(summary: string | null, ctx: z.RefinementCtx) {
  if (summary === null || !summary.trim()) return;
  for (const message of findSummaryProblems(summary)) {
    ctx.addIssue({ code: "custom", message, path: ["summary"] });
  }
}

/** 추측성 표현 검사 — 간략 설명·9개 칸·추천 이유를 모두 합쳐 3회까지 (PRD must 2 규칙 9, 2026-09-18 변경) */
function checkSpeculative(
  value: {
    summary: string | null;
    fields: Partial<Record<DetailKey, z.infer<typeof detailFieldAiSchema>>>;
    recommendations: { reason: string }[];
  },
  ctx: z.RefinementCtx,
) {
  let total = countSpeculativePhrases(value.summary);
  for (const recommendation of value.recommendations) total += countSpeculativePhrases(recommendation.reason);
  for (const field of Object.values(value.fields)) {
    total += countSpeculativePhrases(field?.text) + countSpeculativePhrases(field?.reason);
  }
  if (total > MAX_SPECULATIVE_PHRASES) {
    ctx.addIssue({ code: "custom", message: `추측성 표현이 ${MAX_SPECULATIVE_PHRASES}회를 넘음 (${total}회)`, path: ["speculative"] });
  }
}

/** 시음 적기가 연도 범위로 적혔는지 검사 (PRD must 2 규칙 11) */
function checkDrinkWindow(fields: { drinkWindow?: z.infer<typeof detailFieldAiSchema> }, ctx: z.RefinementCtx) {
  const field = fields.drinkWindow;
  if (field?.status === "found" && !DRINK_WINDOW_PATTERN.test(field.text ?? "")) {
    ctx.addIssue({ code: "custom", message: "시음 적기가 연도 범위가 아님", path: ["fields", "drinkWindow", "text"] });
  }
}

/** 와인을 찾았는지와 필수 값이 맞게 들어왔는지 검사 */
function checkDetailsStatus(
  value: { status: "FOUND" | "WINE_NOT_FOUND"; wine: unknown; summary: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.status === "FOUND") {
    if (value.wine === null) {
      ctx.addIssue({ code: "custom", message: "와인을 찾았는데 확정 와인 정보가 없음", path: ["wine"] });
    }
    if (value.summary === null || !value.summary.trim()) {
      ctx.addIssue({ code: "custom", message: "와인을 찾았는데 간략 설명이 없음", path: ["summary"] });
    }
  }
}

/** 생산지 지도용 위치 이름 — 지도 검색에 쓰므로 영어 또는 현지 원어로 받는다 (PRD must 2 ③) */
const locationAiSchema = z.object({
  country: z.string().nullable(), // 예: "France"
  region: z.string().nullable(), // 예: "Pauillac, Bordeaux"
  label: z.string().nullable(), // 화면 표기 — 예: "프랑스 · 보르도(Bordeaux) 포이약(Pauillac)"
});

/** 유사 와인 추천 한 병 — 웹 검색으로 실제로 있는 와인인지 확인한 것만 (PRD must 2 규칙 13, 2026-09-18 추가) */
const recommendationAiSchema = z.object({
  name: z.string(), // 와인 이름 (원어)
  producer: z.string().nullable(), // 생산자 (원어)
  reason: z.string(), // 추천 이유 — 한국어 2문장 이내
  sources: z.array(z.string()), // 이 와인이 있다는 것을 확인한 페이지의 전체 주소
}).superRefine((value, ctx) => {
  if (countSentences(value.reason) > RECOMMENDATION_MAX_SENTENCES) {
    ctx.addIssue({ code: "custom", message: `추천 이유가 ${RECOMMENDATION_MAX_SENTENCES}문장을 넘음`, path: ["reason"] });
  }
});

/** 유사 와인 추천 병 수 검사 (PRD must 2 규칙 13) */
function checkRecommendationCount(recommendations: unknown[], ctx: z.RefinementCtx) {
  if (recommendations.length > MAX_RECOMMENDATIONS) {
    ctx.addIssue({ code: "custom", message: `유사 와인 추천이 ${MAX_RECOMMENDATIONS}병을 넘음`, path: ["recommendations"] });
  }
}

const detailsBaseShape = {
  status: z.enum(["FOUND", "WINE_NOT_FOUND"]),
  wine: confirmedWineAiSchema.nullable(),
  summary: z.string().nullable(),
  location: locationAiSchema.nullable(),
  recommendations: z.array(recommendationAiSchema), // 최대 3병, 확인된 와인이 없으면 빈 배열
};

/**
 * OpenAI에 보내는 답 모양 — 9개 칸을 모두 필수로 요구한다.
 * (OpenAI의 "정해진 모양으로 답 받기"는 모든 칸을 필수로 적어야 한다)
 */
export const detailsAiResponseFormatSchema = z
  .object({ ...detailsBaseShape, fields: z.object(detailFieldsShape) })
  .superRefine((value, ctx) => {
    checkDetailsStatus(value, ctx);
    checkSummary(value.summary, ctx);
    checkDrinkWindow(value.fields, ctx);
    checkSpeculative(value, ctx);
    checkRecommendationCount(value.recommendations, ctx);
  });

/**
 * 받은 답을 검사할 때 쓰는 모양 — 9개 칸 중 빠진 칸은 오류로 보지 않는다.
 * 빠진 칸은 서버가 "not_found"(정보 없음)로 채운다. (Design Ref: §6.3)
 */
export const detailsAiParseSchema = z
  .object({ ...detailsBaseShape, fields: z.object(detailFieldsShape).partial() })
  .superRefine((value, ctx) => {
    checkDetailsStatus(value, ctx);
    checkSummary(value.summary, ctx);
    checkDrinkWindow(value.fields, ctx);
    checkSpeculative(value, ctx);
    checkRecommendationCount(value.recommendations, ctx);
  });

export type DetailsAiOutput = z.infer<typeof detailsAiParseSchema>;
