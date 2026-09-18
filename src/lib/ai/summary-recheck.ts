// 성공 기준 4 (2026-09-18) — 간략 설명이 9개 칸 내용과 맞는지 매번 검사하고, 근거 없는 내용을 고친다 (CHECK 4-1).
// PRD must 2 규칙 3: 상세 정보에서 "정보 없음"인 항목은 간략 설명에도 지어내 쓰지 않는다.
// 서버(/api/details)에서만 쓴다.
import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import {
  countSpeculativePhrases,
  findSummaryProblems,
  MAX_SPECULATIVE_PHRASES,
  SPECULATIVE_PHRASES,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_SENTENCES,
  SUMMARY_MISSING_PHRASES,
} from "@/lib/ai/schemas";
import type { DetailField, DetailKey } from "@/types/wine";

/**
 * 검사·고치기 호출의 추론 수준 — 결과 화면이 늦어지지 않게 가장 빠른 "none"을 쓴다.
 * 근거가 맞는지는 AI가 아니라 코드가 구절 대조로 판단하므로 정확도 손해가 작다. ("minimal"은 이 모델에서 지원하지 않음)
 */
const CHECK_EFFORT = "none" as const;

/** 다시 쓸 때 목표 글자 수 — 150자 기준에 여유를 둔다 */
const SUMMARY_TARGET_CHARS = 120;

/** AI에게 알려줄 칸 이름 */
const FIELD_NAMES: Record<DetailKey, string> = {
  origin: "생산 국가·지역",
  grapes: "포도 품종 및 블렌딩 비율",
  tasteAroma: "맛과 향",
  winemaking: "제조 방법",
  drinkWindow: "시음 적기",
  foodPairing: "어울리는 음식",
  criticScores: "평론가 평점",
  producerInfo: "생산자 정보",
  grade: "등급",
};

const summarySchema = z.object({ summary: z.string() });
const summaryFormat = zodTextFormat(summarySchema, "rechecked_summary");

// 확인된 칸 내용만으로 다시 쓰게 하는 지시 — 웹 검색은 하지 않는다
const REWRITE_INSTRUCTIONS = [
  "와인 간략 설명을 [확인된 내용]만으로 새로 씁니다. 정해진 JSON 모양으로만 답하세요.",
  "- 문장의 모든 사실(와인 색·종류, 숫자, 품종, 지역, 맛 표현 포함)이 [확인된 내용]에 그대로 있어야 합니다. 없는 사실은 짐작해서 붙이지 않습니다",
  "- [빠진 항목]은 근거를 찾지 못한 항목입니다. 그 항목에 해당하는 내용은 쓰지 않고, 찾지 못했다는 말도 쓰지 않습니다",
  `- ${SUMMARY_TARGET_CHARS}자 안팎(띄어쓰기 포함, 절대 ${SUMMARY_MAX_CHARS}자 이하), ${SUMMARY_MAX_SENTENCES}문장 이내, 와인을 처음 접하는 사람을 위한 한국어`,
  "- 생산지·품종·맛과 향 중 [확인된 내용]에 있는 요소를 담습니다",
  "- 포도 품종·지역은 한글(원어) 형태로 쓰고, 전문 용어 뒤에는 괄호로 쉬운 풀이를 붙입니다 (예: 탄닌(떫은맛))",
  `- 다음 말을 쓰지 않습니다: ${[...SPECULATIVE_PHRASES, ...SUMMARY_MISSING_PHRASES].join(", ")}`,
].join("\n");

/** 확인된 칸 내용 목록 — "- 칸 이름: 내용" 줄들 */
function confirmedLines(fields: DetailField[]): string[] {
  return fields
    .filter((field) => field.status === "found")
    .map((field) => {
      const scores = field.scores.map((score) => `${score.critic} ${score.score}`).join(", ");
      return `- ${FIELD_NAMES[field.key]}: ${field.text ?? scores}`;
    });
}

/**
 * AI에게 보낼 글 — 확인된 칸 내용과 빠진 항목.
 * 원래 간략 설명은 보내지 않는다 — 보내면 버려진 내용(예: 와인 색)이 다시 섞여 들어올 수 있다.
 */
export function buildRecheckInput(fields: DetailField[], removedKeys: DetailKey[]): string {
  return [
    "[확인된 내용]",
    ...confirmedLines(fields),
    "",
    "[빠진 항목]",
    ...removedKeys.map((key) => `- ${FIELD_NAMES[key]}`),
  ].join("\n");
}

// ─────────────────────────────────────────────
// 간략 설명이 칸 내용과 맞는지 검사 (2026-09-18 CHECK 4-1 — 항상 검사)
// 재측정에서 간략 설명에 "아몬드 향"이 들어갔는데, 맛과 향 칸에는 없고 어울리는 음식 칸의
// "아몬드 밀크" 요리에만 있던 일이 있었다. 그래서 칸이 "정보 없음"으로 바뀌지 않았어도 매번 검사한다.
// ─────────────────────────────────────────────

// AI는 사실마다 "어느 칸의 어떤 구절이 근거인지"만 적고, 근거가 맞는지는 코드가 판단한다.
// (AI에게 "근거 있음/없음"만 물으면 대충 "있음"이라고 답하는 일이 있었다 — 아몬드 사례를 놓침)

const FACT_KINDS = ["종류·색", "지역", "품종", "맛·향", "숫자·연도", "제조", "등급·평가", "기타"] as const;
const FIELD_CHOICES: [string, ...string[]] = ["없음", ...Object.values(FIELD_NAMES)];

/** 이 종류의 사실은 반드시 이 칸에 근거가 있어야 한다 — 예: 맛·향은 "맛과 향" 칸 (음식 재료 이름은 근거가 아님) */
const REQUIRED_FIELD: Partial<Record<(typeof FACT_KINDS)[number], DetailKey>> = {
  "맛·향": "tasteAroma",
  품종: "grapes",
};

const verifySchema = z.object({
  facts: z.array(
    z.object({
      text: z.string(), // 간략 설명에 적힌 표현 그대로
      kind: z.enum(FACT_KINDS),
      field: z.enum(FIELD_CHOICES), // 근거가 있는 칸 이름, 없으면 "없음"
      evidence: z.string(), // 그 칸에서 그대로 복사한 짧은 구절
    }),
  ),
});
const verifyFormat = zodTextFormat(verifySchema, "summary_facts");

const VERIFY_INSTRUCTIONS = [
  "와인 [간략 설명]을 사실 단위로 나누고, 각 사실의 근거를 [확인된 내용]에서 찾습니다. 정해진 JSON 모양으로만 답하세요.",
  "- 사실이란 와인 종류·색, 지역, 품종, 숫자·연도, 맛·향을 나타내는 단어(향 하나하나를 따로), 생산 방식, 등급·평가입니다",
  "- text: 간략 설명에 적힌 표현 그대로 (예: \"아몬드 향\", \"피노 누아(Pinot Noir) 중심\")",
  "- kind: 사실의 종류",
  "- field: 근거가 있는 칸 이름. 어느 칸에도 없으면 \"없음\"",
  "- evidence: 그 칸의 글에서 그대로 복사한 짧은 구절(글자를 바꾸지 않음). field가 \"없음\"이면 빈 글",
  "- 맛·향은 '맛과 향' 칸에서, 품종은 '포도 품종 및 블렌딩 비율' 칸에서 근거를 찾습니다. 다른 칸의 음식 재료 이름 같은 것을 근거로 대지 않습니다",
  "- 전문 용어 뒤 괄호 안의 쉬운 풀이(예: 탄닌(떫은맛))와 '와인입니다' 같은 문장 연결 말은 사실로 넣지 않습니다",
].join("\n");

/** 글자 비교용 — 띄어쓰기·괄호 안 원어 차이를 무시한다 */
function compact(value: string): string {
  return value.replace(/\([^)]*\)/g, "").replace(/\s+/g, "").toLowerCase();
}

/** 간략 설명에서 칸 내용에 근거가 없는 표현 목록. 검사하지 못했으면(연결 오류 등) null */
async function findUnsupportedFacts(summary: string, fields: DetailField[]): Promise<string[] | null> {
  const input = ["[간략 설명]", summary, "", "[확인된 내용]", ...confirmedLines(fields)].join("\n");
  let facts: z.infer<typeof verifySchema>["facts"];
  try {
    const response = await getOpenAI().responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: CHECK_EFFORT },
      max_output_tokens: 3000,
      instructions: VERIFY_INSTRUCTIONS,
      text: { format: verifyFormat },
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    });
    const parsed = verifySchema.safeParse(JSON.parse(response.output_text));
    if (!parsed.success) return null;
    facts = parsed.data.facts;
  } catch {
    return null;
  }

  // 칸 이름 → 그 칸의 글 (평론가 평점은 점수 목록)
  const fieldText = new Map<string, string>();
  for (const field of fields) {
    if (field.status !== "found") continue;
    const scores = field.scores.map((score) => `${score.critic} ${score.score}`).join(", ");
    fieldText.set(FIELD_NAMES[field.key], field.text ?? scores);
  }

  // 코드가 근거를 확인한다: ① 근거 칸이 있고 ② 적어 온 구절이 그 칸에 실제로 있고 ③ 맛·향·품종은 정해진 칸이어야 한다
  const unsupported: string[] = [];
  for (const fact of facts) {
    const source = fieldText.get(fact.field);
    const required = REQUIRED_FIELD[fact.kind];
    const inRightField = !required || fact.field === FIELD_NAMES[required];
    const quoted = source !== undefined && compact(fact.evidence).length > 0 && compact(source).includes(compact(fact.evidence));
    if (!quoted || !inRightField) unsupported.push(fact.text);
  }
  return unsupported;
}

/** 확인된 칸 내용만으로 간략 설명을 다시 받는다. 실패하면 null */
async function rewriteSummary(input: string): Promise<string | null> {
  try {
    const response = await getOpenAI().responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      max_output_tokens: 1500,
      instructions: REWRITE_INSTRUCTIONS,
      text: { format: summaryFormat },
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    });
    const parsed = summarySchema.safeParse(JSON.parse(response.output_text));
    return parsed.success ? parsed.data.summary.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 간략 설명을 다시 검사해 고친다.
 * 확인된 칸 내용만으로 다시 쓰게 하고(최대 2번), 규칙(분량·찾지 못했다는 말·추측성 표현 합계 3회)에 맞는 글이 나오지 않으면 빈 글을 돌려준다.
 * 빈 간략 설명은 화면에서 숨긴다 — 지어낸 내용이 남을 수 있는 글을 보여주는 것보다 낫다.
 * otherSpeculative: 간략 설명을 뺀 나머지(9개 칸·추천 이유)에 이미 있는 추측성 표현 수
 */
export async function recheckSummary(
  fields: DetailField[],
  removedKeys: DetailKey[],
  otherSpeculative: number,
): Promise<string> {
  const input = buildRecheckInput(fields, removedKeys);
  for (let attempt = 0; attempt < 2; attempt++) {
    const rewritten = await rewriteSummary(input);
    if (!rewritten) continue;
    const speculativeOk = otherSpeculative + countSpeculativePhrases(rewritten) <= MAX_SPECULATIVE_PHRASES;
    if (findSummaryProblems(rewritten).length === 0 && speculativeOk) return rewritten;
  }
  return "";
}

// 근거 없는 표현만 빼는 짧은 고치기 — 나머지 문장은 그대로 둔다 (처음부터 다시 쓰면 느리고 실패가 잦았다)
const EDIT_INSTRUCTIONS = [
  "와인 [원래 간략 설명]에서 [근거 없는 표현]만 빼거나 [확인된 내용]에 있는 표현으로 바꿉니다. 정해진 JSON 모양으로만 답하세요.",
  "- 나머지 부분은 글자 그대로 둡니다. 새 사실을 더하지 않습니다",
  "- 표현을 뺀 뒤 문장이 어색하면 조사·연결 말만 고칩니다",
  `- ${SUMMARY_MAX_SENTENCES}문장 이내, ${SUMMARY_MAX_CHARS}자 이하`,
].join("\n");

/** 근거 없는 표현만 빼 달라고 한다. 실패하면 null */
async function editOutUnsupported(summary: string, unsupported: string[], fields: DetailField[]): Promise<string | null> {
  const input = [
    "[원래 간략 설명]",
    summary,
    "",
    "[근거 없는 표현]",
    ...unsupported.map((text) => `- ${text}`),
    "",
    "[확인된 내용]",
    ...confirmedLines(fields),
  ].join("\n");
  try {
    const response = await getOpenAI().responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: CHECK_EFFORT },
      max_output_tokens: 1000,
      instructions: EDIT_INSTRUCTIONS,
      text: { format: summaryFormat },
      input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
    });
    const parsed = summarySchema.safeParse(JSON.parse(response.output_text));
    return parsed.success ? parsed.data.summary.trim() : null;
  } catch {
    return null;
  }
}

/** 근거 없는 표현이 든 문장을 통째로 뺀다 — AI 없이 하는 마지막 전 단계 */
function dropSentencesWith(summary: string, unsupported: string[]): string {
  const targets = unsupported.map(compact).filter(Boolean);
  return summary
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !targets.some((target) => compact(sentence).includes(target)))
    .join(" ")
    .trim();
}

/** 간략 설명 검사 결과 — 로그용 (내용은 남기지 않고 무엇을 했는지만) */
export type SummaryCheckOutcome = "kept" | "edited" | "trimmed" | "rewritten" | "hidden";

/**
 * 간략 설명이 9개 칸 내용과 맞는지 매번 확인한다. (성공 기준 4 — 지어낸 정보 0건, CHECK 4-1)
 * 1) 근거가 없어 "정보 없음"으로 바뀐 칸이 있으면 → 확인된 내용만으로 다시 쓴다
 * 2) 아니면 → 간략 설명의 사실마다 근거 칸과 구절을 받아 코드가 확인한다. 모두 맞으면 그대로 둔다
 * 3) 근거 없는 표현이 있으면 → 그 표현만 뺀다 → 안 되면 그 문장을 뺀다 → 그래도 안 되면 다시 쓴다
 * 4) 모두 실패하면 간략 설명을 숨긴다 (지어낸 내용이 남을 수 있는 글을 보여주지 않는다)
 */
export async function ensureSummaryGrounded(
  summary: string,
  fields: DetailField[],
  removedKeys: DetailKey[],
  otherSpeculative: number,
): Promise<{ summary: string; outcome: SummaryCheckOutcome; unsupported: number }> {
  const rewrite = async (unsupported: number) => {
    const rewritten = await recheckSummary(fields, removedKeys, otherSpeculative);
    return { summary: rewritten, outcome: rewritten ? ("rewritten" as const) : ("hidden" as const), unsupported };
  };
  if (removedKeys.length > 0) return rewrite(-1);

  const unsupported = await findUnsupportedFacts(summary, fields);
  if (unsupported === null) return rewrite(-1); // 검사하지 못함 → 안전하게 다시 쓴다
  if (unsupported.length === 0) return { summary, outcome: "kept", unsupported: 0 };

  // 고친 글이 쓸 만한지 — 규칙(분량·찾지 못했다는 말·추측성 표현)에 맞고, 근거 없는 표현이 남지 않았는지
  const acceptable = (candidate: string | null): candidate is string =>
    !!candidate &&
    findSummaryProblems(candidate).length === 0 &&
    otherSpeculative + countSpeculativePhrases(candidate) <= MAX_SPECULATIVE_PHRASES &&
    !unsupported.some((text) => compact(text) && compact(candidate).includes(compact(text)));

  const edited = await editOutUnsupported(summary, unsupported, fields);
  if (acceptable(edited)) {
    // 고치는 김에 새 표현을 덧붙이는 일이 있어(예: "선명한 산미"), 고친 글도 한 번 더 검사한다
    const again = await findUnsupportedFacts(edited, fields);
    if (again !== null && again.length === 0) return { summary: edited, outcome: "edited", unsupported: unsupported.length };
  }

  // 문장을 통째로 빼는 것은 새 표현이 생기지 않으므로 다시 검사하지 않는다
  const trimmed = dropSentencesWith(summary, unsupported);
  if (acceptable(trimmed)) return { summary: trimmed, outcome: "trimmed", unsupported: unsupported.length };

  return rewrite(unsupported.length);
}
