// PRD must 2 ⑤ 결과 화면 링크 공유 (2026-09-18 추가)
// 결과 내용을 압축해 링크 주소의 # 뒤에 담는다. # 뒤 내용은 서버로 전송되지 않으므로
// 서버·DB에 아무것도 저장하지 않고, 링크를 연 사람은 다시 검색하지 않고 같은 결과를 본다.
// 브라우저에서만 쓰는 코드다.
import { z } from "zod";

import { DETAIL_KEYS, type WineDetails } from "@/types/wine";

/** 링크 주소에서 결과를 찾는 표시 — "https://…/#r=…" */
const HASH_PREFIX = "#r=";

/** 담는 방식 표시 — z: 압축, j: 압축 없음(압축 기능이 없는 오래된 브라우저) */
type Encoding = "z" | "j";

/** 링크 # 뒤 글자 수 상한 — 정상 결과는 3천 자 안팎 (2026-09-18 보안 점검) */
const MAX_HASH_LENGTH = 30_000;

/** 압축을 푼 뒤 크기 상한 — 작게 압축했다가 풀면 엄청 커지는 링크로 브라우저가 멈추지 않게 (2026-09-18 보안 점검) */
const MAX_DECODED_BYTES = 200 * 1024;

// ─────────────────────────────────────────────
// 1. 링크 안의 결과를 믿지 않고 검사하는 모양
//    누구나 주소를 고쳐 만들 수 있으므로, 약속한 모양이 아니면 버린다.
// ─────────────────────────────────────────────

/** 링크 없는 출처로 허용하는 이름 — 라벨에서 읽은 값 */
const LABEL_SOURCE_NAME = "라벨";

const text = (max: number) => z.string().max(max);

/**
 * 출처 하나 — 링크 안에 적힌 이름은 믿지 않는다 (2026-09-18 보안 점검 "조작한 공유 링크의 피싱 출처")
 * - 주소가 있으면 https 주소만 허용하고, 화면에 보일 이름은 그 주소의 사이트 이름으로 다시 만든다
 *   ("wine-searcher.com"이라고 보이는데 누르면 다른 사이트로 가는 링크를 막는다)
 * - 주소가 없으면 "라벨"만 허용한다
 * - 조건에 맞지 않는 출처는 null → 목록에서 뺀다
 */
const sourceSchema = z
  .object({ name: text(200), url: z.string().max(2000).nullable() })
  .transform((source) => {
    if (source.url === null) return source.name === LABEL_SOURCE_NAME ? { name: LABEL_SOURCE_NAME, url: null } : null;
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") return null;
      return { name: url.hostname.replace(/^www\./, ""), url: url.toString() };
    } catch {
      return null;
    }
  });

/** 출처 목록 — 믿을 수 없는 출처(null)는 뺀다 */
const sourcesSchema = z
  .array(sourceSchema)
  .max(20)
  .transform((sources) => sources.filter((source) => source !== null));

const fieldSchema = z.object({
  key: z.enum(DETAIL_KEYS),
  status: z.enum(["found", "not_found", "not_applicable"]),
  text: text(3000).nullable(),
  reason: text(500).nullable(),
  sources: sourcesSchema,
  vintageBasis: z.string().regex(/^\d{4}$/).nullable(),
  // 출처를 믿을 수 없는 점수는 뺀다
  scores: z
    .array(z.object({ critic: text(200), score: text(50), source: sourceSchema }))
    .max(3)
    .transform((scores) =>
      scores.flatMap((score) => (score.source ? [{ critic: score.critic, score: score.score, source: score.source }] : [])),
    ),
});

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);

const detailsSchema = z.object({
  wine: z.object({ name: text(200), producer: text(200).nullable(), vintage: text(10).nullable() }),
  summary: text(500),
  fields: z.array(fieldSchema).max(DETAIL_KEYS.length),
  map: z
    .object({ label: text(200), lat, lon, marker: z.boolean(), bbox: z.tuple([lon, lat, lon, lat]) })
    .nullable(),
  recommendations: z
    .array(z.object({ name: text(200), producer: text(200).nullable(), reason: text(1000), sources: sourcesSchema }))
    .max(3)
    // 확인된 출처가 하나도 남지 않은 추천은 뺀다 (서버와 같은 기준)
    .transform((items) => items.filter((item) => item.sources.length > 0)),
});

// ─────────────────────────────────────────────
// 2. 글자 ↔ 주소에 넣을 수 있는 글자(base64url)
// ─────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** 바이트 묶음을 압축(compress) 또는 압축 풀기(decompress) 한다. 결과가 maxBytes를 넘으면 null */
async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maxBytes = Infinity,
): Promise<Uint8Array | null> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // 상한을 넘으면 더 풀지 않고 멈춘다 — 풀면 엄청 커지는 링크로 브라우저가 멈추지 않게
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const canCompress = () => typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

// ─────────────────────────────────────────────
// 3. 밖에서 쓰는 기능
// ─────────────────────────────────────────────

/** 지금 결과를 여는 공유 링크를 만든다 */
export async function createShareUrl(details: WineDetails): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(details));
  const encoding: Encoding = canCompress() ? "z" : "j";
  const bytes = encoding === "z" ? await transform(json, new CompressionStream("deflate-raw")) : json;
  if (!bytes) throw new Error("압축 실패");
  return `${window.location.origin}/${HASH_PREFIX}${encoding}${toBase64Url(bytes)}`;
}

/** 지금 주소가 공유 링크인지 */
export function hasSharedResult(hash: string): boolean {
  return hash.startsWith(HASH_PREFIX);
}

/** 공유 링크 주소(# 부분)에서 결과를 꺼낸다. 모양이 틀리거나 망가졌으면 null */
export async function readSharedResult(hash: string): Promise<WineDetails | null> {
  if (!hasSharedResult(hash)) return null;
  const payload = hash.slice(HASH_PREFIX.length);
  // 너무 긴 링크는 열지 않는다 (2026-09-18 보안 점검)
  if (payload.length > MAX_HASH_LENGTH) return null;
  const encoding = payload[0] as Encoding;
  try {
    const bytes = fromBase64Url(payload.slice(1));
    let json: Uint8Array | null;
    if (encoding === "z") {
      if (!canCompress()) return null;
      json = await transform(bytes, new DecompressionStream("deflate-raw"), MAX_DECODED_BYTES);
      if (!json) return null;
    } else if (encoding === "j") {
      json = bytes;
    } else {
      return null;
    }
    const parsed = detailsSchema.safeParse(JSON.parse(new TextDecoder().decode(json)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 공유 링크 표시(# 부분)를 주소에서 지운다 — 화면을 새로고침해도 다시 열리지 않게 */
export function clearSharedResult() {
  if (hasSharedResult(window.location.hash)) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
