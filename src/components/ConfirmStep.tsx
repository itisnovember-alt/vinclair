// Design Ref: §5.1 ③ 식별 결과 확인, §5.4 ③ 체크리스트
// 식별된 와인이 맞는지 사용자에게 확인받는 화면 조각. (PRD must 1 예외 처리 2·3번)
// 다음 단계로 넘어가는 일은 하지 않고, 사용자의 선택을 부모(page.tsx)에게 알리기만 한다.
"use client";

import { useState } from "react";

import type { IdentifiedWine } from "@/types/wine";

interface ConfirmStepProps {
  wine: IdentifiedWine;
  /** [예] — 상세 정보 단계로 */
  onConfirm: () => void;
  /** [아니오] → [다시 촬영] — 업로드 단계로 */
  onRetake: () => void;
  /** [아니오] → [이름 고치기] — 식별된 이름이 채워진 입력 화면으로 (PRD must 1 예외 처리 3번) */
  onManualInput: () => void;
}

const primaryButton =
  "flex h-14 flex-1 items-center justify-center rounded-sm bg-wine text-base font-bold tracking-[0.12em] text-background transition-opacity active:opacity-85";
const secondaryButton =
  "flex h-14 flex-1 items-center justify-center rounded-sm border border-line bg-surface text-base font-bold tracking-[0.12em] text-foreground transition-colors active:bg-wine-soft";

export default function ConfirmStep({ wine, onConfirm, onRetake, onManualInput }: ConfirmStepProps) {
  // [아니오]를 누르면 버튼이 [다시 촬영] / [이름 고치기]로 바뀐다
  const [rejected, setRejected] = useState(false);

  return (
    <section className="flex flex-col gap-8 px-6 pt-10 pb-10" data-testid="confirm-step">
      <h1 className="font-serif text-[1.75rem] leading-snug font-bold">이 와인이 맞나요?</h1>

      {/* 식별된 와인 카드 — 와인명·생산자·빈티지 (NV 포함) */}
      <div className="flex flex-col gap-1 border border-line bg-surface px-5 py-6">
        <p className="font-serif text-2xl leading-snug font-bold" data-testid="confirm-name">
          {wine.name}
        </p>
        <p className="text-sm text-foreground/60" data-testid="confirm-producer">
          {wine.producer}
        </p>
        <p className="pt-2 font-serif text-xl font-semibold tracking-widest text-wine" data-testid="confirm-vintage">
          {wine.vintage}
        </p>
      </div>

      {rejected ? (
        <div className="flex flex-col gap-3">
          <p className="text-center text-sm text-foreground/60">어떻게 할까요?</p>
          <div className="flex gap-3">
            <button type="button" onClick={onRetake} className={secondaryButton} data-testid="retake-button">
              다시 촬영
            </button>
            <button type="button" onClick={onManualInput} className={secondaryButton} data-testid="manual-button">
              이름 고치기
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-3">
          <button type="button" onClick={onConfirm} className={primaryButton} data-testid="yes-button">
            예
          </button>
          <button type="button" onClick={() => setRejected(true)} className={secondaryButton} data-testid="no-button">
            아니오
          </button>
        </div>
      )}
    </section>
  );
}
