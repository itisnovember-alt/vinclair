// Design Ref: §4.2 POST /api/identify — 라벨 사진을 받아 와인을 식별하는 서버 기능
// PLAN 작업 8: 라벨에서 와인명·생산자·빈티지·국가·지역·등급을 읽어 IdentifyResult로 돌려준다.
// PLAN 작업 9: PRD "AI가 지킬 규칙"(must 1) 원문을 지시문에 넣는다.
import { zodTextFormat } from "openai/helpers/zod";

import { getOpenAI, OPENAI_MODEL } from "@/lib/ai/client";
import { IDENTIFY_RULES, toPromptLines } from "@/lib/ai/rules";
import { identifyAiSchema, type IdentifyAiOutput } from "@/lib/ai/schemas";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { detectImageType, isAllowedUpload, UPLOAD_RULE_MESSAGE } from "@/lib/upload-rules";
import type { ApiErrorResponse, IdentifyResult } from "@/types/wine";

// 식별 단계는 화면에서 60초 제한을 두므로 서버도 60초로 맞춘다 (Design Ref: §4.2)
export const maxDuration = 60;

const AI_ERROR_MESSAGE = "연결이 불안정합니다. 다시 시도해 주세요";

// AI 지시문 — PRD 규칙 원문(rules.ts)에서 AI에게 보낼 규칙만 가져온다. 규칙 문장은 여기서 바꾸지 않는다.
// 규칙 6(15초)은 측정용이라 toPromptLines가 뺀다. (Design Ref: §12)
const IDENTIFY_INSTRUCTIONS = [
  "당신은 와인 라벨 사진에서 글자를 읽는 도우미입니다.",
  "아래 [규칙]을 반드시 지키고, 정해진 JSON 모양으로만 답하세요.",
  "",
  "[규칙]",
  toPromptLines(IDENTIFY_RULES),
  "",
  "[규칙의 반환 문구를 status로 답하는 방법]",
  "규칙에서 문구를 반환하라고 한 경우, 문구 대신 아래 status 값으로 답하고 wine은 null로 둡니다.",
  '- "라벨을 다시 촬영해 주세요" → "UNREADABLE"',
  '- "와인 라벨 사진을 올려주세요" → "NO_LABEL"',
  '- "Vinclair는 와인만 지원합니다" → "NOT_WINE"',
  '- "한 병만 나오게 다시 찍어주세요" → "MULTIPLE_BOTTLES"',
  "사진 전체를 보고 판단하는 규칙 3·4·5를 먼저 확인한 뒤, 규칙 2를 확인합니다.",
  "",
  '[어느 규칙에도 해당하지 않을 때] status는 "OK"로 하고 wine에 다음을 채웁니다.',
  "- name: 와인명 (라벨에 적힌 원어 그대로)",
  "- producer: 생산자 (라벨에 적힌 원어 그대로)",
  '- vintage: 빈티지 연도 숫자 4자리. 라벨에 빈티지 표기가 없으면 "NV"',
  "- country: 생산 국가 (한국어). 라벨에서 읽을 수 없으면 null",
  "- region: 생산 지역 (한국어 표기 뒤 괄호 안에 원어). 라벨에서 읽을 수 없으면 null",
  "- grade: 등급 (한국어 표기 뒤 괄호 안에 원어). 라벨에서 읽을 수 없으면 null",
  "",
  // PLAN 작업 19 — 테스트 사진 15장에서 틀린 경우를 바탕으로 판단 기준을 더했다 (2026-09-17 사용자 결정)
  "[판단 기준]",
  "- producer: 와인을 만든 샤토·도멘·와이너리·샴페인 하우스(브랜드) 이름입니다. 라벨에 적힌 소유 회사·운영 회사 표기(예: \"Domaine Clarence Dillon\", \"Propriétaire\", \"S.A.\", \"Baronne Philippine de Rothschild S.A.\")는 producer로 쓰지 않습니다. 샤토 이름이 곧 생산자이면 와인명과 같은 이름을 producer로 씁니다",
  "- producer는 사진에 실제로 보이는 글자에서만 읽습니다. 병 모양·라벨 디자인만 보고 다른 생산자를 떠올려 적지 않습니다. 라벨의 가장 큰 브랜드 글자(예: KRUG)가 생산자 이름이면 그 이름을 씁니다",
  "- name: 생산자 이름이 와인명 앞에 붙어 불리는 와인이면 생산자 이름을 포함해 적습니다 (예: \"Krug Grande Cuvée\", \"Cloudy Bay Sauvignon Blanc\")",
  "- vintageEvidence: 먼저 라벨·목 라벨·캡슐에서 연도 숫자 자리를 찾아 판단합니다. 연도 4자리를 확실히 읽었으면 \"readable\", 연도가 인쇄된 자리가 보이는데 흐리거나 반사·가림 때문에 숫자 하나라도 확실하지 않으면 \"unreadable\"(이때 vintage에는 보이는 대로 적고, 추측해서 채우지 않습니다), 연도 표기 자체가 없으면 \"none\"과 vintage \"NV\"",
  "- name: 라벨에 적힌 퀴베 이름·포도밭 이름(예: Gap's Crown Vineyard)·아펠라시옹(예: Châteauneuf-du-Pape)처럼 같은 생산자의 다른 와인과 구별되는 이름은 빠짐없이 포함합니다",
  "- 병 개수: 라벨이 잘 보이는 병이 한 개이고 다른 병은 가장자리에 일부만 보이면 한 병으로 보고 식별합니다. 라벨이 보이는 병이 두 개 이상일 때만 MULTIPLE_BOTTLES입니다",
].join("\n");

const identifyFormat = zodTextFormat(identifyAiSchema, "identify_result");

function errorResponse(status: number, body: ApiErrorResponse) {
  return Response.json(body, { status });
}

/** OpenAI에 한 번 요청하고, 답이 약속한 모양이면 돌려준다. 모양이 틀리면 null */
async function requestIdentify(imageUrl: string): Promise<IdentifyAiOutput | null> {
  const response = await getOpenAI().responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    // 추론에 쓰는 토큰까지 포함한 상한
    max_output_tokens: 2000,
    instructions: IDENTIFY_INSTRUCTIONS,
    text: { format: identifyFormat },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "이 와인 라벨을 읽어주세요." },
          // 라벨의 작은 글자를 읽기 위해 선명도를 높게 요청한다
          { type: "input_image", image_url: imageUrl, detail: "high" },
        ],
      },
    ],
  });

  // Design Ref: §6.3 — zod로 모양을 검사한다
  let json: unknown;
  try {
    json = JSON.parse(response.output_text);
  } catch {
    return null;
  }
  const parsed = identifyAiSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** AI 답을 화면과 약속한 모양(IdentifyResult)으로 바꾼다 (Design Ref: §3.1) */
function toIdentifyResult(output: IdentifyAiOutput): IdentifyResult {
  if (output.status === "OK" && output.wine) {
    const { vintageEvidence, ...wine } = output.wine;
    // PRD must 1 규칙 2 — 연도가 인쇄되어 있는데 읽을 수 없으면 추측하지 않고 재촬영 안내 (코드가 결정)
    if (vintageEvidence === "unreadable") return { ok: false, failure: "UNREADABLE" };
    // 연도 표기가 없는 와인은 NV로 진행
    if (vintageEvidence === "none") return { ok: true, wine: { ...wine, vintage: "NV" } };
    return { ok: true, wine };
  }
  // status가 OK가 아니면 실패 종류 그대로 (schemas.ts 검사에서 wine이 null임을 확인함)
  return { ok: false, failure: output.status as Exclude<IdentifyAiOutput["status"], "OK"> };
}

export async function POST(request: Request) {
  // 0. 사용 횟수 제한 — 사진을 읽기 전에 먼저 본다 (PRD 7항, 2026-09-18 추가)
  const retryAfter = checkRateLimit(request, "identify");
  if (retryAfter !== null) return rateLimitResponse(retryAfter);

  // 1. 사진 꺼내기
  let image: FormDataEntryValue | null = null;
  try {
    const form = await request.formData();
    image = form.get("image");
  } catch {
    image = null;
  }

  // 2. 업로드 조건을 서버에서 한 번 더 검사 (Design Ref: §7 — 브라우저와 서버 양쪽에서 검사)
  if (!(image instanceof File) || !isAllowedUpload(image)) {
    return errorResponse(400, { error: { code: "INVALID_FILE", message: UPLOAD_RULE_MESSAGE } });
  }

  // 3. 사진을 OpenAI가 읽을 수 있는 형태(base64 글자)로 바꾼다. 파일로 저장하지 않는다 (Design Ref: §7)
  const bytes = Buffer.from(await image.arrayBuffer());
  // 파일 내용이 진짜 JPG·PNG인지 첫 바이트로 확인한다 — 아니면 업로드 조건 위반과 같이 처리 (2026-09-18 보안 점검)
  const mimeType = detectImageType(bytes);
  if (!mimeType) {
    return errorResponse(400, { error: { code: "INVALID_FILE", message: UPLOAD_RULE_MESSAGE } });
  }
  const imageUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;

  // 4. OpenAI에 식별 요청 — 답 모양이 틀리면 1회 다시 요청 (Design Ref: §6.3)
  try {
    const output = (await requestIdentify(imageUrl)) ?? (await requestIdentify(imageUrl));
    if (!output) {
      console.error("[api/identify] AI 답 모양이 약속과 다름 (재요청 후에도 실패)");
      return errorResponse(502, { error: { code: "AI_ERROR", message: AI_ERROR_MESSAGE } });
    }
    return Response.json(toIdentifyResult(output));
  } catch (error) {
    // 사진 내용이나 키는 기록하지 않고, 오류 종류와 상태 번호만 남긴다 (Design Ref: §7)
    const status = (error as { status?: number }).status;
    console.error("[api/identify] OpenAI 호출 실패:", error instanceof Error ? error.name : "unknown", status ?? "");
    return errorResponse(502, { error: { code: "AI_ERROR", message: AI_ERROR_MESSAGE } });
  }
}
