// PRD 7항 사용량·비용 관리 — 사용 횟수 제한 (2026-09-18 추가)
// 로그인이 없어 누구나 AI 기능을 부를 수 있으므로, 한 사용자(IP 주소)와 서버 전체의 요청 횟수를 제한한다.
// 서버(Route Handler)에서만 쓴다.
//
// 한계: 횟수는 서버 메모리에 센다. Vercel이 서버를 여러 대 띄우거나 다시 시작하면 서버마다 따로 세므로
// 정확한 상한이 아니라 "대략적인 방어선"이다. 요금의 확실한 상한은 OpenAI 관리 화면의 월 사용 한도로 건다.
import "server-only";

/** 제한 규칙 — windowMs 동안 limit번까지 */
interface LimitRule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;

/** 기능별 제한 — PRD 7항 표와 같은 값 */
export const RATE_LIMITS = {
  identify: {
    perUser: { limit: 5, windowMs: 10 * MINUTE }, // 한 사람: 10분에 사진 식별 5번 (2026-09-18 사용자 결정)
    total: { limit: 300, windowMs: 60 * MINUTE }, // 서버 전체: 1시간에 300번
  },
  details: {
    perUser: { limit: 5, windowMs: 10 * MINUTE }, // 한 사람: 10분에 상세 정보 5번 (2026-09-18 사용자 결정)
    total: { limit: 120, windowMs: 60 * MINUTE }, // 서버 전체: 1시간에 120번
  },
} as const satisfies Record<string, { perUser: LimitRule; total: LimitRule }>;

export type RateLimitedFeature = keyof typeof RATE_LIMITS;

export const RATE_LIMIT_MESSAGE = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요";

/** 창(window) 하나의 횟수 기록 */
interface Counter {
  count: number;
  resetAt: number; // 이 시각이 지나면 0부터 다시 센다
}

const counters = new Map<string, Counter>();

/** 오래된 기록을 지워 메모리가 계속 늘지 않게 한다 */
function cleanup(now: number) {
  if (counters.size < 5000) return;
  for (const [key, counter] of counters) {
    if (counter.resetAt <= now) counters.delete(key);
  }
}

/** 한 번 세고, 제한을 넘었으면 다시 시도할 수 있을 때까지 남은 초를 돌려준다. 괜찮으면 null */
function hit(key: string, rule: LimitRule, now: number): number | null {
  const counter = counters.get(key);
  if (!counter || counter.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + rule.windowMs });
    return null;
  }
  if (counter.count >= rule.limit) return Math.ceil((counter.resetAt - now) / 1000);
  counter.count += 1;
  return null;
}

/**
 * 요청한 사람의 IP 주소 — Vercel이 붙여 주는 x-forwarded-for의 첫 값.
 * 주소를 알 수 없으면 "unknown"으로 묶어 센다. (주소는 저장·기록하지 않고 메모리에서 횟수 세기에만 쓴다)
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * 사용 횟수를 확인한다. 넘었으면 다시 시도할 수 있을 때까지 남은 초, 괜찮으면 null.
 * 한 사람 제한을 먼저 보고, 통과한 요청만 서버 전체 횟수에 넣는다.
 */
export function checkRateLimit(request: Request, feature: RateLimitedFeature): number | null {
  const now = Date.now();
  cleanup(now);
  const rules = RATE_LIMITS[feature];
  const userWait = hit(`${feature}:user:${clientKey(request)}`, rules.perUser, now);
  if (userWait !== null) return userWait;
  return hit(`${feature}:total`, rules.total, now);
}

/** 제한을 넘었을 때 보내는 응답 (429 Too Many Requests) */
export function rateLimitResponse(retryAfterSec: number): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: RATE_LIMIT_MESSAGE } },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}
