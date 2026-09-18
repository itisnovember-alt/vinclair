// Design Ref: §5.1, §5.2, §5.3 — 단계별 화면을 바꿔 끼우는 자리 (브라우저에서 실행)
// ① 업로드 → ② 식별 중 → ③ 확인 → ② 상세 정보 작성 중 → ⑤ 결과, 그리고 ④ 직접 입력과 실패 횟수 세기가 있다.
"use client";

import { useEffect, useRef, useState } from "react";

import ConfirmStep from "@/components/ConfirmStep";
import ManualInputStep, { type ManualInputValue, WINE_NAME_MAX_LENGTH } from "@/components/ManualInputStep";
import ProgressNotice from "@/components/ProgressNotice";
import ResultView from "@/components/ResultView";
import UploadStep, { IDENTIFY_FAILURE_MESSAGES } from "@/components/UploadStep";
import { clearSharedResult, hasSharedResult, readSharedResult } from "@/lib/share";
import { isAllowedUpload, UPLOAD_RULE_MESSAGE } from "@/lib/upload-rules";
import type {
  ApiErrorResponse,
  DetailsRequest,
  DetailsResult,
  IdentifiedWine,
  IdentifyResult,
  WineDetails,
} from "@/types/wine";

/** 식별 단계 시간 제한 — 60초 (PRD must 1 예외 처리 7번, Design Ref: §5.2) */
const IDENTIFY_TIMEOUT_MS = 60_000;

/** 연속 실패가 이 횟수에 닿으면 직접 입력으로 넘긴다 (PRD must 1 예외 처리 4번) */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 3회 연속 실패로 직접 입력에 넘어갈 때 안내 (Design Ref: §6.1) */
const TOO_MANY_FAILURES_MESSAGE = "사진 인식이 어려워 직접 입력으로 전환했어요";

/** 사진으로 식별한 와인의 정보를 찾지 못해 직접 입력으로 넘어갈 때 안내 (PRD must 2 예외 처리 2번) */
const PHOTO_WINE_NOT_FOUND_MESSAGE = "와인 정보를 찾지 못해 직접 입력으로 전환했어요";

/** [아니오] → [이름 고치기]로 넘어갈 때 안내 (PRD must 1 예외 처리 3번) */
const EDIT_NAME_MESSAGE = "라벨에서 읽은 이름이에요. 틀린 부분만 고쳐서 다시 찾아보세요";

/** 상세 정보를 요청한 경로 — 와인을 못 찾았을 때 가는 곳이 다르다 (Design Ref: §5.2) */
type DetailsFrom = "photo" | "manual";

/** 지금 화면에 보여줄 단계 */
type Step =
  | { kind: "upload" } // ① 업로드
  | { kind: "identifying"; file: File } // ② 식별 중
  | { kind: "identifyFailed"; file: File; message: string | null } // ② 60초 초과·연결 오류·사용 횟수 초과 → [다시 시도] (message: 기본 문구 대신 보여줄 안내)
  | { kind: "confirm"; wine: IdentifiedWine } // ③ 이 와인이 맞나요?
  // ④ 직접 입력 — reason: 넘어온 이유 / notFound: 입력한 와인을 못 찾음 / value: 처음 채워둘 값
  //   editing: 식별 결과를 고치러 온 경우 (PRD must 1 예외 처리 3번, 2026-09-18 변경)
  | { kind: "manualInput"; reason: string | null; notFound: boolean; value: ManualInputValue; editing: boolean }
  | { kind: "detailsLoading"; request: DetailsRequest; from: DetailsFrom } // ② 상세 정보 작성 중
  | { kind: "detailsFailed"; request: DetailsRequest; from: DetailsFrom; message: string | null } // ② 연결 오류·사용 횟수 초과 → [다시 시도]
  | { kind: "result"; details: WineDetails; shared: boolean }; // ⑤ 결과 — shared: 공유 링크로 연 결과

const EMPTY_MANUAL_VALUE: ManualInputValue = { name: "", vintage: "" };

/** 공유 링크가 망가졌을 때 업로드 화면에 띄울 안내 */
const BROKEN_SHARE_MESSAGE = "공유 링크를 열 수 없어요. 링크가 끝까지 복사됐는지 확인해 주세요";

export default function Home() {
  const [step, setStep] = useState<Step>({ kind: "upload" });
  // 업로드 화면에 띄울 실패 안내 문구
  const [notice, setNotice] = useState<string | null>(null);

  // 진행 중인 요청 — 화면을 떠나거나 새 요청을 보내면 이전 요청을 취소한다
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  // 연속 실패 횟수 — 화면에 보여주지 않고 규칙 판단에만 쓰므로 ref로 둔다
  const failureCountRef = useRef(0);

  // [이름 고치기]로 들어왔는지 — 와인을 못 찾아 다시 입력할 때도 같은 화면(제목·버튼)을 유지하려고 기억해 둔다
  const editingNameRef = useRef(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  // PRD must 2 ⑤ — 공유 링크로 들어오면 다시 검색하지 않고 링크 안의 결과를 그대로 보여준다
  useEffect(() => {
    const hash = window.location.hash;
    if (!hasSharedResult(hash)) return;
    let cancelled = false;
    void readSharedResult(hash).then((details) => {
      if (cancelled) return;
      if (details) {
        setStep({ kind: "result", details, shared: true });
      } else {
        clearSharedResult();
        setNotice(BROKEN_SHARE_MESSAGE);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 새 요청을 시작한다 — 이전 요청은 취소하고, 이 요청의 번호를 돌려준다 */
  function startRequest(): { controller: AbortController; requestId: number } {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return { controller, requestId: ++requestIdRef.current };
  }

  /**
   * 실패 1회를 센다. (Design Ref: §5.2 실패 횟수 규칙)
   * - 3회 미만: 업로드 화면에 안내 문구
   * - 3회 도달: 직접 입력 화면으로 넘기고 횟수를 0으로 되돌린다
   */
  function registerFailure(message: string) {
    failureCountRef.current += 1;
    if (failureCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
      failureCountRef.current = 0;
      editingNameRef.current = false;
      setNotice(null);
      setStep({
        kind: "manualInput",
        reason: TOO_MANY_FAILURES_MESSAGE,
        notFound: false,
        value: EMPTY_MANUAL_VALUE,
        editing: false,
      });
      return;
    }
    setStep({ kind: "upload" });
    setNotice(message);
  }

  async function identify(file: File) {
    const { controller, requestId } = startRequest();

    setNotice(null);
    setStep({ kind: "identifying", file });

    // Design Ref: §5.2 — 60초가 지나면 요청을 멈추고 [다시 시도]를 보여준다
    const timer = setTimeout(() => controller.abort(), IDENTIFY_TIMEOUT_MS);

    const form = new FormData();
    form.append("image", file);

    try {
      const response = await fetch("/api/identify", { method: "POST", body: form, signal: controller.signal });
      const body: unknown = await response.json();
      if (requestId !== requestIdRef.current) return; // 더 새 요청이 있으면 이 결과는 버린다

      if (response.ok) {
        const result = body as IdentifyResult;
        if (!result.ok) {
          // Design Ref: §5.2 — 식별 실패는 PRD 안내 문구와 함께 실패 1회
          registerFailure(IDENTIFY_FAILURE_MESSAGES[result.failure]);
          return;
        }
        // Design Ref: §5.2 — 식별 성공 → 실패 횟수 0으로 되돌리고 ③ 확인
        failureCountRef.current = 0;
        setStep({ kind: "confirm", wine: result.wine });
        return;
      }

      const { error } = body as ApiErrorResponse;
      if (error?.code === "INVALID_FILE") {
        // 서버 검사에서 걸린 경우도 화면 검사와 같이 업로드 조건 위반으로 센다
        registerFailure(error.message);
        return;
      }
      // AI_ERROR·RATE_LIMITED 등 서버 오류 — 실패 횟수에는 넣지 않는다 (Design Ref: §5.2 실패 횟수 규칙)
      // 사용 횟수 제한이면 "요청이 너무 많아요" 안내를 보여준다 (PRD 7항, 2026-09-18 추가)
      setStep({ kind: "identifyFailed", file, message: error?.code === "RATE_LIMITED" ? error.message : null });
    } catch {
      if (requestId !== requestIdRef.current) return;
      // 60초 초과(요청 취소) 또는 인터넷 연결 오류
      setStep({ kind: "identifyFailed", file, message: null });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 상세 정보를 요청한다. (Design Ref: §2.2 흐름 ②③, §5.2)
   * 이 단계에는 시간 제한을 두지 않고, 결과는 실패 횟수에 영향을 주지 않는다.
   */
  async function loadDetails(request: DetailsRequest, from: DetailsFrom) {
    const { controller, requestId } = startRequest();
    setStep({ kind: "detailsLoading", request, from });

    try {
      const response = await fetch("/api/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (requestId !== requestIdRef.current) return;

      if (!response.ok) {
        const { error } = body as ApiErrorResponse;
        // INVALID_INPUT — 같은 요청을 다시 보내도 또 거절되므로 [다시 시도] 대신 이름 고치기 화면으로 보낸다
        //   (예: 라벨에서 읽은 이름이 100자를 넘음 / 2026-09-18 Gap "400 무한 재시도")
        if (error?.code === "INVALID_INPUT") {
          editingNameRef.current = true;
          setStep({
            kind: "manualInput",
            reason: error.message,
            notFound: false,
            value: { name: request.name.slice(0, WINE_NAME_MAX_LENGTH), vintage: request.vintage ?? "" },
            editing: true,
          });
          return;
        }
        // AI_ERROR·RATE_LIMITED 등 — 같은 와인으로 다시 시도할 수 있게 한다
        setStep({ kind: "detailsFailed", request, from, message: error?.code === "RATE_LIMITED" ? error.message : null });
        return;
      }

      const result = body as DetailsResult;
      if (result.ok) {
        setStep({ kind: "result", details: result.details, shared: false });
        return;
      }

      // 와인을 찾지 못함 — 경로에 따라 다르게 안내한다 (Design Ref: §5.2, §6.1)
      if (from === "photo") {
        setStep({
          kind: "manualInput",
          reason: PHOTO_WINE_NOT_FOUND_MESSAGE,
          notFound: false,
          value: EMPTY_MANUAL_VALUE,
          editing: false, // 빈칸으로 새로 입력하는 화면
        });
      } else {
        // 직접 입력 경로 — "입력한 와인을 찾지 못했습니다" + 입력값 유지
        setStep({
          kind: "manualInput",
          reason: null,
          notFound: true,
          value: { name: request.name, vintage: request.vintage ?? "" },
          editing: editingNameRef.current,
        });
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStep({ kind: "detailsFailed", request, from, message: null });
    }
  }

  function handleSelect(file: File) {
    // Design Ref: §2.2 흐름 ① — 서버로 보내기 전에 브라우저에서 먼저 검사한다
    if (!isAllowedUpload(file)) {
      // 업로드 조건 위반도 실패 1회 (PRD must 1 예외 처리 4번)
      registerFailure(UPLOAD_RULE_MESSAGE);
      return;
    }
    void identify(file);
  }

  /** 처음(① 업로드)으로 돌아간다 */
  function goToUpload() {
    editingNameRef.current = false;
    clearSharedResult();
    controllerRef.current?.abort();
    requestIdRef.current += 1;
    setNotice(null);
    setStep({ kind: "upload" });
    // 긴 결과 화면 아래쪽에서 눌러도 업로드 화면을 맨 위부터 보여준다
    window.scrollTo(0, 0);
  }

  return (
    <main className="flex flex-1 flex-col">
      {step.kind === "upload" && <UploadStep onSelect={handleSelect} notice={notice} />}

      {step.kind === "identifying" && <ProgressNotice message="라벨을 읽고 있어요…" />}

      {step.kind === "identifyFailed" && (
        // [다시 시도] — 같은 사진으로 다시 식별한다
        <ProgressNotice
          message="라벨을 읽고 있어요…"
          failed
          failedMessage={step.message}
          onRetry={() => void identify(step.file)}
        />
      )}

      {step.kind === "confirm" && (
        // Design Ref: §5.2 — [예] → 상세 정보 / [아니오] → [다시 촬영] ① 업로드 · [이름 고치기] ④ 직접 입력
        <ConfirmStep
          wine={step.wine}
          // Design Ref: §4.3 — 사진 식별 후에는 라벨에서 읽은 6개 값을 모두 보낸다
          onConfirm={() => void loadDetails({ ...step.wine }, "photo")}
          onRetake={goToUpload}
          // [아니오] → [이름 고치기] — 식별된 이름·빈티지를 채워 일부만 고칠 수 있게 한다
          onManualInput={() => {
            editingNameRef.current = true;
            setStep({
              kind: "manualInput",
              reason: EDIT_NAME_MESSAGE,
              notFound: false,
              // 입력칸 한도(100자)를 넘는 이름은 잘라서 채운다 — 넘은 채로 보내면 서버가 거절한다
              value: { name: step.wine.name.slice(0, WINE_NAME_MAX_LENGTH), vintage: step.wine.vintage },
              editing: true,
            });
          }}
        />
      )}

      {step.kind === "manualInput" && (
        <ManualInputStep
          // 넘어온 이유·입력값이 바뀌면 화면 조각을 새로 그려 초기값을 다시 채운다
          key={`${step.reason}|${step.notFound}|${step.value.name}|${step.value.vintage}`}
          initialValue={step.value}
          editing={step.editing}
          reason={step.reason}
          notFound={step.notFound}
          onSubmit={(value) =>
            // Design Ref: §4.3 — 직접 입력 후에는 name·vintage만 보내고 나머지는 null
            void loadDetails(
              {
                name: value.name,
                producer: null,
                vintage: value.vintage || null,
                country: null,
                region: null,
                grade: null,
              },
              "manual",
            )
          }
        />
      )}

      {step.kind === "detailsLoading" && <ProgressNotice message="와인 정보를 찾고 있어요…" />}

      {step.kind === "detailsFailed" && (
        // [다시 시도] — 같은 와인으로 다시 요청한다 (시간 제한 없음)
        <ProgressNotice
          message="와인 정보를 찾고 있어요…"
          failed
          failedMessage={step.message}
          onRetry={() => void loadDetails(step.request, step.from)}
        />
      )}

      {step.kind === "result" && (
        <ResultView details={step.details} shared={step.shared} onRestart={goToUpload} />
      )}
    </main>
  );
}
