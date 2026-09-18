// Design Ref: §2.2 흐름 ①, §7 — 업로드 조건(4MB 이하 JPG/PNG) 검사
// 화면(page.tsx)과 서버(api/identify)가 똑같은 기준으로 검사하도록 한 곳에 둔다.
// 다른 파일에 의존하지 않는다. (Design Ref: §9 — 공통 약속)

/** 최대 크기 4MB — Vercel이 한 번에 받는 크기(약 4.5MB)보다 작게 잡았다 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** 받는 사진 형식 */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

/** 파일 형식 정보가 비어 있을 때(일부 기기) 대신 확인하는 확장자 */
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png"];

/**
 * 조건 위반 안내 문구 — PRD must 1 예외 처리 표 1번 원문
 * 화면 안내와 서버 오류 응답(INVALID_FILE)이 같은 문구를 쓴다. (Design Ref: §6.1, §6.2)
 */
export const UPLOAD_RULE_MESSAGE = "4MB 이하의 JPG 또는 PNG 사진을 올려주세요";

/** 검사에 필요한 파일 정보 — 브라우저의 File과 서버에서 받은 File 모두 이 모양을 가진다 */
export interface UploadCandidate {
  name: string;
  size: number;
  type: string;
}

/** 조건을 지키면 true */
export function isAllowedUpload(file: UploadCandidate): boolean {
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return false;

  const type = file.type.toLowerCase();
  if (type) {
    return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
  }

  const name = file.name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * 파일 내용의 첫 바이트로 진짜 JPG·PNG인지 확인한다 — 확장자나 형식 정보는 바꿔 붙일 수 있으므로 (2026-09-18 보안 점검)
 * JPG는 FF D8 FF, PNG는 89 50 4E 47 0D 0A 1A 0A로 시작한다. 둘 다 아니면 null
 */
export function detectImageType(bytes: Uint8Array): (typeof ALLOWED_IMAGE_TYPES)[number] | null {
  const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}
