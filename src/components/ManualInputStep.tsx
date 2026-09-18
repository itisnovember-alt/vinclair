// Design Ref: §5.1 ④ 직접 입력, §5.4 ④ 체크리스트
// 와인 이름·빈티지를 직접 입력받는 화면 조각. (PRD must 1 예외 처리 5·6번)
// 입력값을 서버로 보내는 일은 하지 않고, 부모(page.tsx)에게 넘기기만 한다.
"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

/** 와인 이름 최대 글자 수 (PRD must 1 예외 처리 5번, Design Ref: §4.3) */
export const WINE_NAME_MAX_LENGTH = 100;

/** 와인을 찾지 못했을 때 안내 — PRD must 1 예외 처리 6번 원문 */
export const WINE_NOT_FOUND_MESSAGE = "입력한 와인을 찾지 못했습니다. 이름을 확인해 주세요";

export interface ManualInputValue {
  name: string;
  vintage: string; // "" / "2019" / "NV"
}

/**
 * 빈티지 입력을 "숫자 4자리 또는 NV"로만 받는다. (Design Ref: §5.4 ④ — 입력 자체를 제한)
 * - 숫자로 시작하면 숫자만 4자리까지
 * - N으로 시작하면 "N", "NV"까지만 (소문자도 대문자로)
 */
export function sanitizeVintage(raw: string): string {
  const value = raw.toUpperCase().replace(/\s/g, "");
  if (value.startsWith("N")) return value.startsWith("NV") ? "NV" : "N";
  return value.replace(/\D/g, "").slice(0, 4);
}

/** 빈티지가 비었거나 완성된 형태(숫자 4자리 / NV)면 true */
export function isCompleteVintage(vintage: string): boolean {
  return vintage === "" || vintage === "NV" || /^\d{4}$/.test(vintage);
}

interface ManualInputStepProps {
  /** 처음 채워둘 값 — 식별 결과를 고칠 때나, 와인을 못 찾아 다시 입력할 때 이전 입력을 유지한다 */
  initialValue?: ManualInputValue;
  /**
   * true면 식별 결과를 고치러 온 것이다 (PRD must 1 예외 처리 3번, 2026-09-18 변경)
   * 제목과 버튼 글자가 바뀌고, 이름 칸에 커서를 끝에 두어 바로 고칠 수 있게 한다.
   */
  editing?: boolean;
  /** 넘어온 이유 안내 (3회 연속 실패 / 정보 못 찾음) — 있을 때만 표시 */
  reason?: string | null;
  /** true면 "입력한 와인을 찾지 못했습니다" 안내를 보여준다 */
  notFound?: boolean;
  /** [찾아보기] */
  onSubmit: (value: ManualInputValue) => void;
}

// 너비(w-…)는 칸마다 따로 정한다
const inputClass =
  "h-12 rounded-sm border border-line bg-surface px-4 text-base outline-none transition-colors placeholder:text-foreground/35 focus:border-wine";

export default function ManualInputStep({
  initialValue = { name: "", vintage: "" },
  editing = false,
  reason = null,
  notFound = false,
  onSubmit,
}: ManualInputStepProps) {
  const [name, setName] = useState(initialValue.name);
  const [vintage, setVintage] = useState(initialValue.vintage);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // 이름을 고치러 온 경우, 이름 칸을 바로 쓸 수 있게 커서를 글자 끝에 둔다
  useEffect(() => {
    if (!editing) return;
    const input = nameInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  const trimmedName = name.trim();
  const vintageComplete = isCompleteVintage(vintage);
  // 이름이 비었거나 빈티지를 쓰다 만 상태면 [찾아보기]를 누를 수 없다
  const canSubmit = trimmedName.length > 0 && vintageComplete;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({ name: trimmedName, vintage });
  }

  return (
    <section className="flex flex-col gap-8 px-6 pt-10 pb-10" data-testid="manual-input-step">
      <h1 className="font-serif text-[1.75rem] leading-snug font-bold">
        {editing ? "이름을 고쳐 주세요" : "와인 정보를 입력해 주세요"}
      </h1>

      {reason && (
        <p className="border-l-2 border-wine bg-wine-soft px-4 py-3 text-sm text-wine" data-testid="manual-reason">
          {reason}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
        <label className="flex flex-col gap-2">
          <span className="text-sm">
            와인 이름 <span className="text-wine">*</span>
          </span>
          <input
            ref={nameInputRef}
            type="text"
            value={name}
            // 브라우저 제한(maxLength)에 더해 코드에서도 100자로 자른다
            onChange={(event) => setName(event.target.value.slice(0, WINE_NAME_MAX_LENGTH))}
            maxLength={WINE_NAME_MAX_LENGTH}
            placeholder="예: Château Margaux"
            autoComplete="off"
            required
            className={`${inputClass} w-full`}
            data-testid="manual-name"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm">
            빈티지 <span className="text-foreground/50">(선택)</span>
          </span>
          <input
            type="text"
            value={vintage}
            // 브라우저의 글자 수 제한(maxLength)은 걸지 않는다 — 걸러내기 전에 입력이 막혀
            // "20a1b9" 입력·붙여넣기가 "201"이 되는 문제가 있었다. 4자리 제한은 sanitizeVintage가 한다.
            onChange={(event) => setVintage(sanitizeVintage(event.target.value))}
            placeholder="예: 2019 또는 NV"
            autoComplete="off"
            autoCapitalize="characters"
            className={`${inputClass} w-44`}
            data-testid="manual-vintage"
          />
          {!vintageComplete && (
            <span className="text-xs text-foreground/55" data-testid="manual-vintage-hint">
              숫자 4자리 또는 NV로 입력해 주세요
            </span>
          )}
        </label>

        {notFound && (
          <p role="alert" className="border-l-2 border-wine bg-wine-soft px-4 py-3 text-sm text-wine" data-testid="manual-not-found">
            {WINE_NOT_FOUND_MESSAGE}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="flex h-14 w-full items-center justify-center rounded-sm bg-wine text-base font-bold tracking-[0.12em] text-background transition-opacity active:opacity-85 disabled:cursor-not-allowed disabled:opacity-35"
          data-testid="manual-submit"
        >
          {editing ? "이 이름으로 찾기" : "찾아보기"}
        </button>
      </form>
    </section>
  );
}
