// Design Ref: §5.1 ① 업로드 단계, §5.4 ① 체크리스트
// 사진을 고르는 화면 조각. 고른 사진을 검사하거나 서버로 보내는 일은 하지 않고,
// 부모(page.tsx)에게 넘기기만 한다.
"use client";

import Image from "next/image";
import { useRef, type ChangeEvent } from "react";

// 사진: Yoonjeong 제공 (바탕 화면 와인사진/111.jpg) — 포도밭이 보이는 테라스의 와인잔 (2026-09-17 사용자 요청)
import vineyardPhoto from "../../public/images/vineyard-terrace.jpg";
import type { IdentifyFailure } from "@/types/wine";

/**
 * 식별 실패 종류별 안내 문구 — PRD must 1 AI 규칙 2~5의 반환 문구 원문
 * AI는 실패 종류만 알려주고, 화면 문구는 여기서 붙인다. (Design Ref: §6.1)
 */
export const IDENTIFY_FAILURE_MESSAGES: Record<IdentifyFailure, string> = {
  UNREADABLE: "라벨을 다시 촬영해 주세요",
  NO_LABEL: "와인 라벨 사진을 올려주세요",
  NOT_WINE: "Vinclair는 와인만 지원합니다",
  MULTIPLE_BOTTLES: "한 병만 나오게 다시 찍어주세요",
};

// PRD 7항 고지 문구 원문 — 항상 표시한다
const UPLOAD_NOTICE =
  "업로드한 사진은 와인 식별을 위해 외부 AI 서비스(OpenAI)로 전송되며, Vinclair에는 저장되지 않습니다.";

interface UploadStepProps {
  /** 사용자가 사진을 고르면 호출된다 */
  onSelect: (file: File) => void;
  /** 실패 안내 문구 — 있을 때만 표시한다 */
  notice?: string | null;
}

export default function UploadStep({ onSelect, notice = null }: UploadStepProps) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const albumInputRef = useRef<HTMLInputElement>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // 같은 사진을 다시 골라도 알아챌 수 있게 선택 기록을 비운다
    event.target.value = "";
    if (file) onSelect(file);
  }

  return (
    <section className="flex flex-col">
      {/* 포도밭 띠 사진 — 세로 사진이라 와인잔과 포도밭이 함께 보이는 가운데 부분을 보여준다 */}
      <div className="relative h-56 w-full overflow-hidden">
        <Image
          src={vineyardPhoto}
          alt="포도밭이 내려다보이는 테라스 테이블 위의 와인잔"
          fill
          preload
          sizes="(max-width: 448px) 100vw, 448px"
          className="object-cover object-[center_33%] saturate-[.85]"
        />
      </div>

      <div className="flex flex-col gap-8 px-6 pt-10 pb-8">
        <h1 className="font-serif text-[1.75rem] leading-snug font-bold">
          와인 라벨을 찍어주세요
        </h1>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-sm bg-wine text-base font-bold tracking-[0.12em] text-background transition-opacity active:opacity-85"
          >
            <span aria-hidden>📷</span> 사진 촬영
          </button>
          <button
            type="button"
            onClick={() => albumInputRef.current?.click()}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-sm border border-line bg-surface text-base font-bold tracking-[0.12em] text-foreground transition-colors active:bg-wine-soft"
          >
            <span aria-hidden>🖼</span> 사진 선택
          </button>

          {/* 실제 파일 고르기 칸은 숨기고 위 버튼으로 연다 */}
          {/* capture="environment": 스마트폰에서 뒤쪽 카메라를 바로 연다 */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            onChange={handleChange}
            className="hidden"
            data-testid="camera-input"
          />
          <input
            ref={albumInputRef}
            type="file"
            accept="image/jpeg,image/png"
            onChange={handleChange}
            className="hidden"
            data-testid="album-input"
          />

          <p className="pt-1 text-center text-xs tracking-wide text-foreground/55">
            4MB 이하 JPG/PNG만 가능
          </p>
        </div>

        {notice && (
          <p
            role="alert"
            className="border-l-2 border-wine bg-wine-soft px-4 py-3 text-sm text-wine"
          >
            {notice}
          </p>
        )}

        <p className="border-t border-line pt-5 text-xs leading-5 text-foreground/50">
          {UPLOAD_NOTICE}
        </p>
      </div>
    </section>
  );
}
