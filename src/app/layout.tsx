// Design Ref: §5.1 — 모든 단계에 공통으로 보이는 틀(머리글 + 가운데 내용 자리)
import type { Metadata } from "next";
import { Cormorant_Garamond, Jost, Noto_Sans_KR, Noto_Serif_KR } from "next/font/google";
import "./globals.css";

// 글꼴 — Ruinart 누리집(Saol 세리프 제목 + Riviera Nights 기하학 산세리프 본문)을 참고해 무료 비슷한 글꼴로 맞췄다 (2026-09-17 사용자 요청)
// 글꼴 파일을 앱에 함께 담아 기기와 상관없이 같은 모양으로 보인다

// 제목(영문·숫자): 획 굵기 대비가 큰 우아한 세리프 — Saol 대신
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  weight: ["500", "600", "700"],
  subsets: ["latin"],
});

// 본문·버튼(영문·숫자): 기하학적인 산세리프 — Riviera Nights 대신
const jost = Jost({
  variable: "--font-jost",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

// 제목(한글): 세리프, 굵게 쓰기 위해 600·700을 불러온다
// 한글 글꼴은 파일이 많아 미리 불러오지 않는다
const notoSerifKr = Noto_Serif_KR({
  variable: "--font-noto-serif-kr",
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  preload: false,
});

// 본문(한글): 산세리프 — 기기마다 기본 글꼴이 달라 보이지 않게 앱에 담는다
const notoSansKr = Noto_Sans_KR({
  variable: "--font-noto-sans-kr",
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  preload: false,
});

export const metadata: Metadata = {
  title: "Vinclair",
  description: "와인 라벨 사진으로 와인 정보를 알려주는 앱",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 결과 화면을 한국어로 제공 (PRD 성공 기준 5)
    <html lang="ko" className={`${cormorant.variable} ${jost.variable} ${notoSerifKr.variable} ${notoSansKr.variable} h-full antialiased`}>
      <body className="min-h-full">
        {/* 스마트폰 폭 기준으로 가운데 정렬한 한 줄짜리 화면 */}
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
          <header className="px-6 pt-6 pb-4">
            <p className="font-serif text-2xl font-bold tracking-[0.3em] text-wine">VINCLAIR</p>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
