// Design Ref: §4.3 POST /api/details — 확인된 와인으로 간략 설명 + 9개 항목을 받는 서버 기능
// PLAN 작업 14: 9개 항목을 정해진 칸에 나눠 받고, 빠진 칸 없이 돌려준다.
// PLAN 작업 15: 웹 검색으로 라벨에 없는 정보를 채우고, 실제로 열어본 사이트만 출처로 남긴다.
//   출처는 누르면 이동하는 링크로 돌려준다 (OpenAI 웹 검색 이용 조건, 2026-09-17 사용자 결정)
// PLAN 작업 16: PRD "AI가 지킬 규칙"(must 2) 4~12번 원문을 지시에 넣고, 코드로 지킬 수 있는 부분은 코드가 확인한다.
// PLAN 작업 17: 간략 설명 규칙 1~3번까지 넣어 must 2 규칙을 모두 보낸다.
// PLAN 작업 21 (2026-09-18): 제조 방법 10문장, 추측성 표현 최대 3회, 유사 와인 최대 3병 추천(규칙 13)을 더했다.
// 성공 기준 4 (2026-09-18): 간략 설명이 9개 칸 내용과 맞는지 매번 검사하고, 근거 없는 내용이 있으면 확인된 칸 내용만으로 다시 쓰게 한다.
import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import { ensureSummaryGrounded } from "@/lib/ai/summary-recheck";
import { findWineMap } from "@/lib/geocode";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { DETAILS_RULES, toPromptLines } from "@/lib/ai/rules";
import {
  detailsAiParseSchema,
  detailsAiResponseFormatSchema,
  FIELD_MAX_SENTENCES,
  MAX_CRITIC_SCORES,
  MAX_RECOMMENDATIONS,
  MAX_SPECULATIVE_PHRASES,
  RECOMMENDATION_MAX_SENTENCES,
  SPECULATIVE_PHRASES,
  SUMMARY_MISSING_PHRASES,
  countSpeculativePhrases,
  keepWholeSentences,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_SENTENCES,
  VINTAGE_PATTERN,
  WINEMAKING_MAX_SENTENCES,
  type DetailsAiOutput,
} from "@/lib/ai/schemas";
import {
  DETAIL_KEYS,
  type ApiErrorResponse,
  type CriticScore,
  type DetailField,
  type DetailKey,
  type DetailsRequest,
  type DetailsResult,
  type SimilarWine,
  type SourceLink,
} from "@/types/wine";

// 웹 검색 때문에 식별보다 오래 걸린다 (보통 20~40초, 답 모양이 틀려 1회 다시 요청하면 그 2배).
// Vercel Hobby 요금제 한도(300초) 안에서 120초로 정했다 — PLAN 작업 20 (Design Ref: §4.3)
export const maxDuration = 120;

/** 라벨에서 읽은 값의 출처 표시 (Design Ref: §3.3) */
const LABEL_SOURCE = "라벨";

/** 와인 이름 최대 글자 수 — 화면(ManualInputStep)과 같은 기준 (PRD must 1 예외 처리 5번) */
const WINE_NAME_MAX_LENGTH = 100;

/**
 * 생산자·국가·지역·등급 최대 글자 수 — 라벨에서 읽은 값이라 보통 수십 자. 아주 긴 글이 AI 지시에 그대로 들어가
 * 요금이 나가지 않게 막는다 (2026-09-18 보안 점검 "입력 길이 제한")
 */
const LABEL_VALUE_MAX_LENGTH = 200;

/** 요청 본문 전체 최대 글자 수 — 정상 요청은 1천 자를 넘지 않는다. 읽기 전에 너무 큰 요청을 거절한다 */
const REQUEST_BODY_MAX_LENGTH = 4000;

const AI_ERROR_MESSAGE = "연결이 불안정합니다. 다시 시도해 주세요";
const INVALID_INPUT_MESSAGE = "와인 이름과 빈티지를 확인해 주세요";

// 9개 칸이 무엇을 담는지 — PRD must 2 목록과 같은 순서
const FIELD_GUIDE: Record<DetailKey, string> = {
  origin: "1. 생산 국가·지역",
  grapes: "2. 포도 품종 및 블렌딩 비율",
  tasteAroma: "3. 맛과 향",
  winemaking: `4. 제조 방법 — 확인되는 양조 방식을 폭넓게, ${WINEMAKING_MAX_SENTENCES}문장 이내 (아래 [제조 방법 칸에 담을 내용] 참고)`,
  drinkWindow: "5. 시음 적기",
  foodPairing: "6. 어울리는 음식",
  criticScores: "7. 평론가 평점 — 점수는 scores 배열에 critic·score·source로 담는다",
  producerInfo: "8. 생산자 정보",
  grade: "9. 등급",
};

// 기본 지시 — 무엇을 어떤 모양으로 돌려줄지 알려준다.
// 분량 숫자는 답 모양 검사(schemas.ts)와 같은 값을 가져와 써서, 설명과 검사가 어긋나지 않게 한다.
const DETAILS_INSTRUCTIONS = [
  "당신은 와인 정보를 정리하는 도우미입니다. 아래 [규칙]을 반드시 지키고, 정해진 JSON 모양으로만 답하세요.",
  "",
  "[규칙]",
  // PRD 규칙 원문(rules.ts) 그대로 — 규칙 문장은 여기서 바꾸지 않는다
  toPromptLines(DETAILS_RULES),
  "",
  "[규칙의 표기를 칸에 담는 방법]",
  "화면 글자는 서버가 붙이므로, 규칙이 말한 표기를 text에 직접 쓰지 말고 아래 값으로 답합니다.",
  '- "정보 없음" → status "not_found", text·reason은 null. text에 "정보 없음"이라고 쓰지 않습니다',
  '- "해당 없음" + 이유 → status "not_applicable", reason에 짧은 이유(예: "미국은 등급 제도가 없음"), text는 null',
  "- 출처 사이트 이름 → sources에 그 정보를 확인한 페이지의 전체 주소. 서버가 사이트 이름 링크로 바꿔 보여줍니다",
  '- "(2015년 빈티지 기준)" → vintageBasis에 "2015". text에는 기준 연도 문구를 쓰지 않습니다. 요청한 빈티지의 정보면 null',
  "- 평론가 평점 → criticScores 칸의 scores에 critic(평론가 또는 매체 이름)·score(점수)·source(확인한 페이지 주소), text는 null",
  '- 시음 적기 → drinkWindow 칸의 text에 "2025~2032년"처럼 시작 연도~끝 연도를 반드시 넣습니다',
  `- 추측성 표현(규칙 9) → 다음 말은 되도록 쓰지 않고, 쓰더라도 text·reason·summary·추천 이유를 모두 합쳐 ${MAX_SPECULATIVE_PHRASES}회를 넘기지 않습니다: ${SPECULATIVE_PHRASES.join(", ")}`,
  "- 등급: Grand Cru, Premier Grand Cru Classé, DOCG처럼 품질 등급만 등급으로 씁니다. 원산지 명칭(AOC·AOP·AVA·GI·DO·IGT 등)만 있는 와인은 not_applicable로 두고 이유를 적습니다 (예: \"AOC는 원산지 명칭이며 품질 등급이 아님\"). 등급이 있을 수 있는데 확인하지 못했으면 not_found",
  '- 한글과 원어 함께 쓰기(규칙 12): 포도 품종·지역·와이너리 이름은 text와 summary 어디서든 "카베르네 소비뇽(Cabernet Sauvignon)", "포이약(Pauillac)"처럼 한글 뒤 괄호 안에 원어를 씁니다. 원어만 단독으로 쓰지 않습니다. 같은 이름이 한 글에 다시 나오면 두 번째부터는 한글만 써도 됩니다',
  '- 포도 품종: 단일 품종 와인이면 블렌딩 비율은 원래 없으므로 "확인되지 않았습니다"라고 쓰지 말고 "단일 품종"이라고 씁니다',
  "- 확인한 페이지가 없는 칸은 found로 두지 말고 not_found로 둡니다",
  "",
  "[와인을 확인할 수 없을 때]",
  'status는 "WINE_NOT_FOUND", wine과 summary는 null, fields의 모든 칸은 status "not_found"로 둡니다.',
  "",
  "[와인을 확인했을 때]",
  'status는 "FOUND"로 하고 다음을 채웁니다.',
  "- wine: 확정한 와인명(name), 생산자(producer), 빈티지(vintage). 모르면 producer·vintage는 null",
  `- summary: 와인을 처음 접하는 사람을 위한 한국어 간략 설명 (${SUMMARY_MAX_SENTENCES}문장 이내, 띄어쓰기 포함 ${SUMMARY_MAX_CHARS}자 이내)`,
  "",
  "[간략 설명(summary)을 쓰는 방법 — 규칙 1~3]",
  "- 9개 칸을 먼저 채운 뒤, found이고 출처가 있는 칸의 내용만 가져와 씁니다. 칸에 없는 내용을 새로 넣지 않습니다",
  "- 생산지는 origin, 품종은 grapes, 맛과 향은 tasteAroma 칸에서 가져옵니다. 그 칸이 not_found·not_applicable이면 그 요소는 언급하지 않습니다",
  "- 칸의 내용과 다른 숫자·품종·지역·맛 표현을 쓰지 않습니다",
  `- 다음처럼 찾지 못했다는 말을 쓰지 않습니다: ${SUMMARY_MISSING_PHRASES.join(", ")}`,
  "- 전문 용어(예: 탄닌, 산도, 바디, 블렌드·블렌딩, 리저브 와인, 오크 숙성, 미네랄리티, 아펠라시옹)를 쓰면 바로 뒤 괄호 안에 쉬운 풀이를 붙입니다. 예: 탄닌(떫은맛), 블렌드(여러 품종을 섞음). 품종·지역·생산자 이름은 전문 용어로 보지 않습니다",
  "- 괄호 안 풀이와 원어 병기도 글자 수에 포함되므로 130자 안팎을 목표로 짧게 씁니다 (150자를 넘으면 다시 써야 해서 시간이 두 배로 걸립니다). 같은 이름의 원어는 한 번만 병기합니다",
  "- location: 생산지 지도용 위치. origin 칸이 found일 때만 채우고 아니면 null. country는 영어 국가명(예: \"France\"), region은 지도에서 찾을 수 있는 가장 좁은 생산 지역을 영어 또는 현지 원어로(예: \"Pauillac, Bordeaux\"), label은 화면에 보일 한국어 표기(예: \"프랑스 · 보르도(Bordeaux) 포이약(Pauillac)\")",
  "- fields: 아래 9개 칸을 모두 채웁니다.",
  ...DETAIL_KEYS.map((key) => `  - ${key}: ${FIELD_GUIDE[key]}`),
  "",
  "[각 칸을 채우는 방법]",
  '- status: 내용이 있으면 "found", 정보가 없으면 "not_found", 원래 존재하지 않는 정보면 "not_applicable"',
  `- text: found일 때 한국어 설명 (${FIELD_MAX_SENTENCES}문장 이내, winemaking 칸만 ${WINEMAKING_MAX_SENTENCES}문장 이내), 아니면 null`,
  "- reason: not_applicable일 때 이유, 아니면 null",
  "- sources: 이 칸의 내용을 실제로 확인한 웹 검색 결과 페이지의 전체 주소 목록 (예: \"https://www.krug.com/…\"). 없으면 빈 배열",
  "- vintageBasis: 다른 빈티지의 정보를 썼을 때 그 연도(숫자 4자리), 아니면 null",
  `- scores: criticScores 칸에서만 쓰고(최대 ${MAX_CRITIC_SCORES}개), 다른 칸은 빈 배열. source에는 점수를 확인한 페이지의 전체 주소를 적습니다`,
  "",
  // PRD must 2 목록 4번 (2026-09-18 변경) — 오크 숙성뿐 아니라 양조 방식 전반을 담는다
  "[제조 방법(winemaking) 칸에 담을 내용]",
  "아래에서 웹 검색으로 확인된 것만 골라 적습니다. 확인되지 않은 항목은 언급하지 않습니다.",
  "- 오크통 숙성: 오크 종류(프렌치·아메리칸), 새 오크 비율, 숙성 기간",
  "- 포도 처리: 포도송이를 줄기째 넣는 전송이 발효인지, 줄기를 제거(제경)하는지와 그 비율",
  "- 발효 용기: 스테인리스 탱크, 오크통, 콘크리트(에그 포함), 암포라 등",
  "- 침용(껍질을 함께 담가 두기) 기간, 효모(자연 효모·배양 효모), 말로락틱 발효 여부",
  "- 여과·정제를 하지 않았다면 그 사실",
  "- 스파클링 와인이면 2차 발효 방식, 효모와 함께 둔 병 숙성 기간, 도자주(마지막에 더하는 당분)",
  "- 전문 용어에는 괄호로 쉬운 풀이를 붙입니다. 예: 전송이 발효(포도송이를 줄기째 넣어 발효), 말로락틱 발효(사과산을 부드러운 젖산으로 바꾸는 발효)",
  "- 한 항목만 확인돼도 found로 두고, 하나도 확인되지 않으면 not_found로 둡니다",
  "- 이 칸을 채우기 전에 생산자 누리집의 양조 설명(vinification, winemaking, élevage, technical sheet, 양조)을 웹 검색으로 따로 찾아봅니다",
  "- 포도 품종과 블렌딩 비율은 2번 칸의 내용이므로 이 칸에 다시 쓰지 않습니다. 이 칸은 '어떻게 만들었는지'만 씁니다",
  "- 위 목록 순서대로 확인된 것을 담되, 포도 처리(줄기 사용 여부)와 발효 용기·오크 숙성은 특히 빠뜨리지 않고 찾습니다",
  "- 스파클링 와인은 병 속 2차 발효 여부, 효모와 함께 둔 숙성 기간, 도자주를 우선해서 찾습니다",
  "",
  // PRD must 2 규칙 13 (2026-09-18 추가)
  "[유사 와인 추천(recommendations) — 규칙 13]",
  `- 이 와인과 생산 지역·포도 품종이 비슷한 다른 와인을 ${MAX_RECOMMENDATIONS}병까지 recommendations에 담습니다. 같은 와인의 다른 빈티지나 같은 와인을 두 번 추천하지 않고, 되도록 서로 다른 생산자의 와인을 고릅니다`,
  `- ${MAX_RECOMMENDATIONS}병은 최대치이며 꼭 채울 필요는 없습니다. 지역·품종이 정말 비슷한 와인만 1~${MAX_RECOMMENDATIONS}병 고르고, 후보마다 웹 검색으로 실제로 판매·소개되는 와인인지 확인합니다. 확인한 와인만 담고, 각 sources에 확인한 페이지의 전체 주소를 적습니다. 확인한 와인이 없으면 빈 배열`,
  "- name·producer는 원어 그대로, producer를 모르면 null",
  `- reason: 왜 비슷한지 한국어 ${RECOMMENDATION_MAX_SENTENCES}문장 이내 (예: 같은 지역·같은 품종 구성). 지역·품종 이름은 한글(원어)로 씁니다`,
  "",
  "[웹 검색]",
  "라벨에 없는 정보는 웹 검색으로 확인합니다. 검색 결과에서 직접 확인한 페이지 주소만 sources에 적고, 검색하지 않은 페이지를 적지 않습니다.",
  "",
  "[라벨에서 읽은 값]",
  `요청에 country·region·grade 값이 있으면 라벨에서 읽은 값이므로 origin·grade 칸에 그대로 쓰고 sources를 ["${LABEL_SOURCE}"]로 둡니다.`,
].join("\n");

const detailsFormat = zodTextFormat(detailsAiResponseFormatSchema, "wine_details");

// 간략 설명만 기준을 넘었을 때 쓰는 짧은 다시 쓰기 지시 — 웹 검색 없이 글만 줄인다 (PLAN 작업 19: 재요청 시간 줄이기)
const SUMMARY_TARGET_CHARS = 120;
const shortenFormat = zodTextFormat(z.object({ summary: z.string() }), "short_summary");
const SHORTEN_INSTRUCTIONS = [
  "주어진 와인 간략 설명을 규칙에 맞게 짧게 다시 씁니다. 정해진 JSON 모양으로만 답하세요.",
  `- ${SUMMARY_TARGET_CHARS}자 안팎(띄어쓰기 포함, 절대 ${SUMMARY_MAX_CHARS}자 이하), ${SUMMARY_MAX_SENTENCES}문장 이내`,
  "- 원래 글에 없는 내용·숫자·표현을 새로 넣지 않습니다. 덜 중요한 향·풍미 단어부터 줄입니다",
  "- 생산지·품종·맛과 향 중 원래 글에 있던 요소는 남깁니다",
  "- 포도 품종은 한글(원어) 형태를 유지합니다. 지역 이름의 원어 괄호는 한 번만 남기거나 뺄 수 있습니다",
  "- 전문 용어 뒤 괄호 풀이(예: 탄닌(떫은맛))는 유지합니다",
  `- 다음 말을 쓰지 않습니다: ${[...SPECULATIVE_PHRASES, ...SUMMARY_MISSING_PHRASES].join(", ")}`,
].join("\n");

/** 간략 설명을 기준 안으로 줄여 다시 받는다. 실패하면 null */
async function shortenSummary(summary: string): Promise<string | null> {
  try {
    const response = await getOpenAI().responses.create({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      max_output_tokens: 1500,
      instructions: SHORTEN_INSTRUCTIONS,
      text: { format: shortenFormat },
      input: [{ role: "user", content: [{ type: "input_text", text: summary }] }],
    });
    const parsed = z.object({ summary: z.string() }).safeParse(JSON.parse(response.output_text));
    return parsed.success ? parsed.data.summary.trim() : null;
  } catch {
    return null;
  }
}

function errorResponse(status: number, body: ApiErrorResponse) {
  return Response.json(body, { status });
}

/** 요청 본문을 검사해 DetailsRequest로 만든다. 조건에 맞지 않으면 null (Design Ref: §4.3 입력 제한) */
function parseRequest(body: unknown): DetailsRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  const optionalText = (value: unknown): string | null | undefined => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return undefined; // 형식 오류
    const trimmed = value.trim();
    if (trimmed.length > LABEL_VALUE_MAX_LENGTH) return undefined; // 너무 긴 값은 형식 오류로 본다
    return trimmed === "" ? null : trimmed;
  };

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0 || name.length > WINE_NAME_MAX_LENGTH) return null;

  const vintage = optionalText(record.vintage);
  if (vintage === undefined || (vintage !== null && !VINTAGE_PATTERN.test(vintage))) return null;

  const producer = optionalText(record.producer);
  const country = optionalText(record.country);
  const region = optionalText(record.region);
  const grade = optionalText(record.grade);
  if ([producer, country, region, grade].includes(undefined)) return null;

  return {
    name,
    vintage,
    producer: producer ?? null,
    country: country ?? null,
    region: region ?? null,
    grade: grade ?? null,
  };
}

interface DetailsAiAnswer {
  output: DetailsAiOutput;
  /** AI가 이번 요청에서 웹 검색으로 실제로 열어본 페이지 주소 (http·https만) */
  consultedUrls: string[];
}

/** OpenAI에 한 번 요청하고, 답이 약속한 모양이면 돌려준다. 모양이 틀리면 null */
async function requestDetails(wine: DetailsRequest): Promise<DetailsAiAnswer | null> {
  const response = await getOpenAI().responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    // 추론에 쓰는 토큰까지 포함한 상한 — 9개 칸을 모두 쓰므로 식별보다 크게 잡는다
    max_output_tokens: 12000,
    instructions: DETAILS_INSTRUCTIONS,
    text: { format: detailsFormat },
    // PLAN 작업 15 — 웹 검색을 반드시 한 번 이상 하게 한다 ("auto"면 검색을 건너뛸 수 있다)
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    // AI가 실제로 열어본 사이트 주소 목록을 함께 받는다 — 출처 검증에 쓴다
    include: ["web_search_call.action.sources"],
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `다음 와인의 정보를 정리해 주세요.\n${JSON.stringify(wine)}` }],
      },
    ],
  });

  // Design Ref: §6.3 — 빠진 칸은 허용하는 검사 모양(detailsAiParseSchema)으로 확인한다
  let json: unknown;
  try {
    json = JSON.parse(response.output_text);
  } catch {
    return null;
  }
  let parsed = detailsAiParseSchema.safeParse(json);

  // Design Ref: §6.3 — 간략 설명 분량만 틀렸으면 웹 검색 전체를 다시 하지 않고 간략 설명만 고친다
  //   1) 웹 검색 없이 간략 설명만 짧게 다시 받기 → 2) 그래도 넘으면 뒤 문장을 통째로 빼기
  const onlySummaryIssues =
    !parsed.success && parsed.error.issues.every((issue) => issue.path[0] === "summary");
  const record = json as { summary?: unknown };
  if (onlySummaryIssues && typeof record.summary === "string") {
    const original = record.summary;
    const shortened = await shortenSummary(original);
    if (shortened) parsed = detailsAiParseSchema.safeParse({ ...record, summary: shortened });
    if (!parsed.success) {
      const trimmed = keepWholeSentences(original, SUMMARY_MAX_CHARS, SUMMARY_MAX_SENTENCES);
      if (trimmed) parsed = detailsAiParseSchema.safeParse({ ...record, summary: trimmed });
    }
    if (process.env.NODE_ENV !== "production") {
      console.info(`[api/details] 간략 설명 분량 초과 → 간략 설명만 고침: ${parsed.success ? "성공" : "실패"}`);
    }
  }

  if (!parsed.success) {
    // 개발 중에만 어느 검사에서 걸렸는지 남긴다 (검사 문구와 칸 이름만, 와인 내용은 남기지 않는다)
    if (process.env.NODE_ENV !== "production") {
      const reasons = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      console.warn("[api/details] 답 모양 검사 실패:", reasons.join(" / "));
    }
    return null;
  }

  return { output: parsed.data, consultedUrls: collectConsultedUrls(response) };
}

/** 주소나 사이트 이름을 비교하기 쉬운 도메인 모양으로 바꾼다 — "https://www.Wine-Searcher.com/x" → "wine-searcher.com" */
function toDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^www\./, "");
  }
}

/** http·https 주소만 링크로 쓴다 — 다른 형식(javascript: 등)은 누르면 위험하므로 버린다 */
function toSafeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 같은 페이지인지 비교할 때 쓰는 모양 — 끝의 "/"와 "#…" 차이는 무시한다 */
function samePage(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

/** 두 도메인이 같은 사이트인지 — 하위 도메인까지 같은 사이트로 본다 (예: shop.x.com ↔ x.com) */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** 이번 요청에서 AI가 웹 검색으로 실제로 열어본 페이지 주소 목록 */
function collectConsultedUrls(response: OpenAIResponse): string[] {
  const urls: string[] = [];
  for (const item of response.output) {
    if (item.type !== "web_search_call" || item.action.type !== "search") continue;
    for (const source of item.action.sources ?? []) {
      if (source.type !== "url") continue;
      const safe = toSafeUrl(source.url);
      if (safe && !urls.some((url) => samePage(url, safe))) urls.push(safe);
    }
  }
  return urls;
}

/**
 * AI가 적은 출처를 실제 검색 결과와 대조해 링크로 바꾼다.
 * - "라벨" → 링크 없는 "라벨"
 * - 열어본 페이지와 주소가 같으면 → 그 페이지로
 * - 주소는 다르지만 같은 사이트의 페이지를 열어봤으면 → 열어본 그 사이트 페이지로
 * - 열어본 적 없는 사이트면 → null (지어낸 출처로 보고 버린다)
 */
function resolveSource(raw: string, consultedUrls: string[]): SourceLink | null {
  if (raw.trim() === LABEL_SOURCE) return { name: LABEL_SOURCE, url: null };

  const domain = toDomain(raw);
  const sameSitePages = consultedUrls.filter((url) => sameSite(toDomain(url), domain));
  if (sameSitePages.length === 0) return null;

  const exact = sameSitePages.find((url) => samePage(url, raw));
  const url = exact ?? sameSitePages[0];
  return { name: toDomain(url), url };
}

/** 출처 목록을 링크로 바꾸고, 같은 사이트가 겹치면 처음 것 하나만 남긴다 (화면에 "a.com, a.com"처럼 보이지 않게) */
function resolveSources(raws: string[], consultedUrls: string[]): SourceLink[] {
  const links: SourceLink[] = [];
  for (const raw of raws) {
    const link = resolveSource(raw, consultedUrls);
    if (!link) continue;
    const duplicate = links.some((existing) => existing.name === link.name);
    if (!duplicate) links.push(link);
  }
  return links;
}

/** 와인명 끝에 빈티지가 붙어 오면 뗀다 — 화면 머리에서 빈티지를 따로 보여주므로 "… 2009 / 2009"처럼 두 번 보이지 않게 */
function withoutVintageInName<T extends { name: string; vintage: string | null }>(wine: T): T {
  // AI가 준 빈티지 값으로 정규식을 만들지 않고 "끝이 같은지"만 본다 — "(" 같은 값이 와도 오류가 나지 않게 (2026-09-18 보안 점검)
  const vintage = wine.vintage?.trim();
  const trimmedName = wine.name.trim();
  if (!vintage || !trimmedName.endsWith(vintage)) return wine;
  const before = trimmedName.slice(0, trimmedName.length - vintage.length);
  // "… 2009"처럼 빈티지 앞이 띄어쓰기일 때만 뗀다 ("Cuvée2009" 같은 붙은 글자는 그대로 둔다)
  if (!/\s$/.test(before)) return wine;
  const name = before.trim();
  return { ...wine, name: name || wine.name };
}

/** 빠진 칸을 채울 때 쓰는 "정보 없음" 칸 */
function notFoundField(key: DetailKey): DetailField {
  return { key, status: "not_found", text: null, reason: null, sources: [], vintageBasis: null, scores: [] };
}

/**
 * AI 답을 화면과 약속한 모양(DetailsResult)으로 바꾼다. (Design Ref: §3.2, §3.3, §6.3)
 * - 9개 칸을 DETAIL_KEYS 순서로 항상 모두 만든다. 빠진 칸은 "정보 없음"
 * - 출처는 "라벨" 또는 실제로 열어본 페이지만 남기고, 누르면 이동하는 링크로 바꾼다 (PLAN 작업 15)
 * - 평론가 점수도 출처가 확인된 것만 남기고, 점수가 없으면 "정보 없음"으로 바꾼다
 * - scores는 7번 칸에만 남긴다
 */
function toDetailsResult({ output, consultedUrls }: DetailsAiAnswer, request: DetailsRequest): DetailsResult {
  if (output.status === "WINE_NOT_FOUND") {
    return { ok: false, failure: "WINE_NOT_FOUND" };
  }

  // "라벨" 출처를 믿을 수 있는 칸 — 요청에 라벨에서 읽은 값이 실제로 들어온 칸만 (나머지 칸의 "라벨"은 지어낸 출처로 본다)
  const labelKeys = new Set<DetailKey>();
  if (request.country || request.region) labelKeys.add("origin");
  if (request.grade) labelKeys.add("grade");

  // Plan SC: 9개 항목 100% 표시 — AI 답과 상관없이 9칸을 코드가 보장한다
  const fields: DetailField[] = DETAIL_KEYS.map((key) => {
    const field = output.fields[key];
    if (!field || field.status === "not_found") return notFoundField(key);

    // PRD must 2 규칙 6 — 해당 없음은 이유만 남긴다
    if (field.status === "not_applicable") {
      return { ...notFoundField(key), status: "not_applicable", reason: field.reason?.trim() ?? null };
    }

    const rawSources = labelKeys.has(key) ? field.sources : field.sources.filter((raw) => raw.trim() !== LABEL_SOURCE);
    const sources = resolveSources(rawSources, consultedUrls);
    // PRD must 2 규칙 8 — 요청한 빈티지와 같은 연도면 "다른 빈티지 기준"이 아니므로 표시하지 않는다
    //   기준 빈티지는 숫자 4자리만 쓴다 — "2015년"이면 2015, "NV"처럼 연도가 없으면 표시하지 않는다
    const basisYear = field.vintageBasis?.match(/\d{4}/)?.[0] ?? null;
    const vintageBasis = basisYear === request.vintage ? null : basisYear;

    if (key === "criticScores") {
      // PRD must 2 규칙 10 — 출처가 확인된 점수만, 평가 주체가 비어 있으면 버린다
      const scores: CriticScore[] = [];
      for (const score of field.scores) {
        const source = resolveSource(score.source, consultedUrls);
        if (source && score.critic.trim() && score.score.trim()) {
          scores.push({ critic: score.critic.trim(), score: score.score.trim(), source });
        }
      }
      if (scores.length === 0) return notFoundField(key);
      return { key, status: "found", text: null, reason: null, sources, vintageBasis, scores };
    }

    // PRD must 2 규칙 5·7 — 내용이 비었거나 확인된 출처가 하나도 없으면 근거가 없는 것이므로 "정보 없음"
    const text = field.text?.trim() ?? "";
    if (!text || sources.length === 0) return notFoundField(key);
    return { key, status: "found", text, reason: null, sources, vintageBasis, scores: [] };
  });

  // PRD must 2 규칙 13 — 추천 와인은 실제로 열어본 페이지로 확인된 것만, 같은 이름은 한 번만 보여준다 (하나도 없으면 "정보 없음")
  const recommendations: SimilarWine[] = [];
  for (const raw of output.recommendations) {
    const name = raw.name.trim();
    const reason = raw.reason.trim();
    if (!name || !reason) continue;
    if (recommendations.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) continue;
    const sources = resolveSources(
      raw.sources.filter((source) => source.trim() !== LABEL_SOURCE),
      consultedUrls,
    );
    if (sources.length === 0) continue;
    recommendations.push({ name, producer: raw.producer?.trim() || null, reason, sources });
    if (recommendations.length === MAX_RECOMMENDATIONS) break;
  }

  return {
    ok: true,
    details: {
      wine: withoutVintageInName(output.wine ?? { name: request.name, producer: request.producer, vintage: request.vintage }),
      summary: output.summary ?? "",
      fields,
      map: null, // 생산지 지도는 POST에서 위치를 찾은 뒤 채운다
      recommendations,
    },
  };
}

export async function POST(request: Request) {
  // 0. 사용 횟수 제한 — AI를 부르기 전에 먼저 본다 (PRD 7항, 2026-09-18 추가)
  const retryAfter = checkRateLimit(request, "details");
  if (retryAfter !== null) return rateLimitResponse(retryAfter);

  // 1. 요청 검사 (Design Ref: §4.3 — 화면 입력칸이 막지만 서버에서도 다시 검사)
  //    본문 크기를 먼저 본다 — 몇 MB짜리 요청을 끝까지 읽지 않게 (2026-09-18 보안 점검)
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > REQUEST_BODY_MAX_LENGTH * 4) {
    return errorResponse(400, { error: { code: "INVALID_INPUT", message: INVALID_INPUT_MESSAGE } });
  }
  let body: unknown;
  try {
    const text = await request.text();
    body = text.length > REQUEST_BODY_MAX_LENGTH ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const wine = parseRequest(body);
  if (!wine) {
    return errorResponse(400, { error: { code: "INVALID_INPUT", message: INVALID_INPUT_MESSAGE } });
  }

  // 2. OpenAI에 요청 — 답 모양이 틀리면 1회 다시 요청 (Design Ref: §6.3)
  try {
    const answer = (await requestDetails(wine)) ?? (await requestDetails(wine));
    if (!answer) {
      console.error("[api/details] AI 답 모양이 약속과 다름 (재요청 후에도 실패)");
      return errorResponse(502, { error: { code: "AI_ERROR", message: AI_ERROR_MESSAGE } });
    }
    const result = toDetailsResult(answer, wine);

    // AI는 "찾음"이라고 했지만 근거(출처)가 확인되지 않아 "정보 없음"으로 바꾼 칸
    const removedKeys: DetailKey[] = result.ok
      ? result.details.fields
          .filter((field) => field.status === "not_found" && answer.output.fields[field.key]?.status === "found")
          .map((field) => field.key)
      : [];

    if (result.ok) {
      const details = result.details;
      // PRD must 2 ③ 생산지 지도 — 1번 칸이 확인된 경우에만 위치를 찾는다. 실패해도 결과는 그대로 보낸다
      const origin = details.fields.find((field) => field.key === "origin");
      const mapTask =
        origin?.status === "found" && answer.output.location ? findWineMap(answer.output.location) : Promise.resolve(null);

      // 성공 기준 4 — 간략 설명이 칸 내용과 맞는지 매번 검사하고, 근거 없는 내용이 있으면 다시 쓴다
      //   (CHECK 4-1, 2026-09-18: 항상 검사. 지도 찾기와 동시에 진행)
      const otherSpeculative =
        details.fields.reduce((sum, field) => sum + countSpeculativePhrases(field.text) + countSpeculativePhrases(field.reason), 0) +
        details.recommendations.reduce((sum, item) => sum + countSpeculativePhrases(item.reason), 0);
      const summaryTask = ensureSummaryGrounded(details.summary, details.fields, removedKeys, otherSpeculative);

      const [map, check] = await Promise.all([mapTask, summaryTask]);
      details.map = map;
      details.summary = check.summary;
      if (process.env.NODE_ENV !== "production") {
        const reason = removedKeys.length > 0 ? `정보 없음으로 바뀐 칸 ${removedKeys.join(", ")}` : `근거 없는 표현 ${check.unsupported}개`;
        const label = { kept: "그대로 둠", edited: "근거 없는 표현만 뺌", trimmed: "그 문장을 뺌", rewritten: "다시 씀", hidden: "규칙에 맞게 못 써서 숨김" }[check.outcome];
        console.info(`[api/details] 간략 설명 검사: ${reason} → ${label}`);
      }
    }

    // 개발 중에만 출처 검증 결과 개수를 남긴다 (와인 이름·내용은 남기지 않는다)
    if (process.env.NODE_ENV !== "production" && result.ok) {
      const claimed = Object.values(answer.output.fields).reduce(
        (sum, field) => sum + (field?.sources.length ?? 0) + (field?.scores.length ?? 0),
        0,
      );
      const downgraded = removedKeys.length;
      const kept = result.details.fields.reduce((sum, field) => sum + field.sources.length + field.scores.length, 0);
      console.info(
        `[api/details] 열어본 페이지 ${answer.consultedUrls.length}곳 / AI가 적은 출처·점수 ${claimed}개 중 ${claimed - kept}개 제거(겹침 포함) / 근거 없어 정보 없음으로 바꾼 칸 ${downgraded}개`,
      );
    }
    return Response.json(result);
  } catch (error) {
    // 키나 요청 내용은 기록하지 않고, 오류 종류와 상태 번호만 남긴다 (Design Ref: §7)
    const status = (error as { status?: number }).status;
    console.error("[api/details] OpenAI 호출 실패:", error instanceof Error ? error.name : "unknown", status ?? "");
    return errorResponse(502, { error: { code: "AI_ERROR", message: AI_ERROR_MESSAGE } });
  }
}
