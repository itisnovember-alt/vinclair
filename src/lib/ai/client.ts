// Design Ref: §2.4 AI 모델, §7 보안 — OpenAI 연결과 모델 이름을 두는 유일한 파일
// 이 파일은 서버에서만 쓴다. 브라우저 쪽 코드에서 가져오면 빌드가 실패한다.
import "server-only";

import OpenAI from "openai";

/**
 * 사용하는 AI 모델 — 모델을 바꿀 때는 이 한 줄만 고친다.
 * gpt-5.6-terra: 사진 입력·웹 검색을 모두 지원하는 성능·비용 균형 모델 (2026-09-17 사용자 결정)
 */
export const OPENAI_MODEL = "gpt-5.6-terra";

let client: OpenAI | null = null;

/** OpenAI 연결을 만든다. API 키는 .env(로컬) 또는 Vercel 환경 변수에서만 읽는다 */
export function getOpenAI(): OpenAI {
  if (client) return client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // 키 값은 절대 기록하지 않는다. 없다는 사실만 알린다.
    throw new Error("OPENAI_API_KEY가 설정되어 있지 않습니다");
  }

  client = new OpenAI({ apiKey });
  return client;
}
