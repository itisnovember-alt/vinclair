import type { NextConfig } from "next";

// 보안 헤더 — 모든 화면과 서버 응답에 붙인다 (2026-09-18 보안 점검 "보안 헤더가 없음")
const SECURITY_HEADERS = [
  // 다른 사이트가 Vinclair 화면을 자기 페이지 틀(iframe) 안에 넣지 못하게 한다 (클릭재킹 방지)
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // 브라우저가 파일 형식을 멋대로 짐작하지 않게 한다
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 다른 사이트로 이동할 때 주소 전체(공유 링크의 # 내용 포함)를 넘기지 않고 사이트 이름만 넘긴다
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // 쓰지 않는 기기 기능(마이크·위치)은 막는다. 사진은 파일 선택·촬영 창으로 받으므로 영향이 없다
  { key: "Permissions-Policy", value: "microphone=(), geolocation=(), camera=(self)" },
];

const nextConfig: NextConfig = {
  // 응답에 "Next.js로 만듦" 표시를 붙이지 않는다
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
