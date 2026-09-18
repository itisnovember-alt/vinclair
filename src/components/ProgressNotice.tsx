// Design Ref: §5.1 ② 진행 중, §5.4 ② 체크리스트
// 서버가 일하는 동안 보여주는 화면 조각. 식별 단계와 상세 정보 단계에서 함께 쓴다.
// 시간 제한을 재거나 다시 요청하는 일은 하지 않고, 부모(page.tsx)가 알려준 상태만 그린다.
"use client";

interface ProgressNoticeProps {
  /** 진행 중 문구 — 예: "라벨을 읽고 있어요…" */
  message: string;
  /** true면 진행 표시 대신 연결 실패 안내와 [다시 시도] 버튼을 보여준다 */
  failed?: boolean;
  /** [다시 시도]를 누르면 호출된다 */
  onRetry?: () => void;
  /** 실패 안내를 기본 문구 대신 이 문구로 보여준다 — 예: 사용 횟수 제한 */
  failedMessage?: string | null;
}

export default function ProgressNotice({ message, failed = false, onRetry, failedMessage = null }: ProgressNoticeProps) {
  if (failed) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center" data-testid="progress-failed">
        {/* PRD must 1 예외 처리 7번 / must 2 예외 처리 1번 원문 "연결이 불안정합니다. 다시 시도해 주세요" */}
        <p role="alert" className="font-serif text-xl leading-relaxed font-bold break-keep">
          {failedMessage ?? (
            <>
              연결이 불안정합니다.
              <br />
              다시 시도해 주세요.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="flex h-14 w-full items-center justify-center rounded-sm bg-wine text-base font-bold tracking-[0.12em] text-background transition-opacity active:opacity-85"
          data-testid="retry-button"
        >
          다시 시도
        </button>
      </section>
    );
  }

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center"
      aria-live="polite"
      aria-busy="true"
      data-testid="progress"
    >
      {/* 천천히 도는 얇은 원 — 움직임 줄이기 설정을 켠 기기에서는 멈춘다 */}
      <span
        aria-hidden
        className="size-10 animate-spin rounded-full border-2 border-line border-t-wine motion-reduce:animate-none"
      />
      <p className="font-serif text-xl font-bold">{message}</p>
    </section>
  );
}
