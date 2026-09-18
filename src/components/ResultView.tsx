// Design Ref: §5.1 ⑤ 결과, §3.3 화면 표기 규칙, §5.4 ⑤ 체크리스트
// 간략 설명과 9개 항목을 보여주는 화면 조각.
// PLAN 작업 14: 9칸을 빠짐없이 보여주는 기본 틀.
// PLAN 작업 18: 간략 설명을 위, 9개 항목을 아래에 두고 스마트폰 세로 화면에 맞춰 배치한다.
// PLAN 작업 21 (2026-09-18): 9개 항목 아래에 유사 와인 추천 최대 3병, 맨 아래에 [링크 공유] 버튼을 둔다.
"use client";

import { useEffect, useState } from "react";

import { createShareUrl } from "@/lib/share";

import type { CriticScore, DetailField, DetailKey, SimilarWine, SourceLink, WineDetails, WineMap } from "@/types/wine";
import { DETAIL_KEYS } from "@/types/wine";

/**
 * 출처 하나 — 주소가 있으면 누르면 새 탭으로 그 페이지를 연다.
 * OpenAI 웹 검색 이용 조건: 출처가 잘 보이고 누르면 이동할 수 있어야 한다.
 */
function SourceName({ source }: { source: SourceLink }) {
  if (!source.url) return <span>{source.name}</span>;
  return (
    <a
      href={source.url}
      target="_blank"
      // 새 탭이 Vinclair 화면을 조작하지 못하게 하고, 어디서 왔는지 넘기지 않는다
      rel="noopener noreferrer"
      // 손가락으로 누르기 쉽게 위아래 여백을 조금 넓힌다
      className="py-1 underline decoration-foreground/30 underline-offset-2 active:text-wine hover:text-wine hover:decoration-wine"
      data-testid="source-link"
    >
      {source.name}
    </a>
  );
}

/** "출처: a.com, b.com" 한 줄 */
function SourceList({ sources }: { sources: SourceLink[] }) {
  if (sources.length === 0) return null;
  return (
    <p className="text-xs leading-relaxed text-foreground/50">
      출처:{" "}
      {sources.map((source, index) => (
        <span key={`${source.name}-${index}`}>
          {index > 0 && ", "}
          <SourceName source={source} />
        </span>
      ))}
    </p>
  );
}

/**
 * 생산지 지도 — PRD must 2 ③ (2026-09-17 추가)
 * OpenStreetMap이 제공하는 지도 화면을 끼워 넣는다. 국가와 지역이 함께 보이게 넓게 보여주고, 지역에 핀을 찍는다.
 */
function WineMapView({ map }: { map: WineMap }) {
  const [west, south, east, north] = map.bbox.map((value) => value.toFixed(4));
  const embed = new URL("https://www.openstreetmap.org/export/embed.html");
  embed.searchParams.set("bbox", `${west},${south},${east},${north}`);
  embed.searchParams.set("layer", "mapnik");
  if (map.marker) embed.searchParams.set("marker", `${map.lat.toFixed(4)},${map.lon.toFixed(4)}`);
  const bigMap = `https://www.openstreetmap.org/?mlat=${map.lat.toFixed(4)}&mlon=${map.lon.toFixed(4)}#map=7/${map.lat.toFixed(4)}/${map.lon.toFixed(4)}`;

  return (
    <figure className="mt-2 flex flex-col gap-1.5" data-testid="wine-map">
      <div className="relative aspect-[4/3] w-full overflow-hidden border border-line bg-surface">
        <iframe
          src={embed.toString()}
          title={`생산지 지도: ${map.label}`}
          loading="lazy"
          // 지도 안에서 다른 페이지로 이동하거나 Vinclair 화면을 조작하지 못하게 막는다
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full"
        />
      </div>
      <figcaption className="flex items-baseline justify-between gap-3 text-xs text-foreground/50">
        <span>{map.label}</span>
        <a
          href={bigMap}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 py-1 underline decoration-foreground/30 underline-offset-2 hover:text-wine"
        >
          큰 지도 보기
        </a>
      </figcaption>
    </figure>
  );
}

/** 9개 항목의 화면 이름 — PRD must 2 목록 순서 */
const DETAIL_LABELS: Record<DetailKey, string> = {
  origin: "생산 국가·지역",
  grapes: "포도 품종 및 블렌딩 비율",
  tasteAroma: "맛과 향",
  winemaking: "제조 방법",
  drinkWindow: "시음 적기",
  foodPairing: "어울리는 음식",
  criticScores: "평론가 평점",
  producerInfo: "생산자 정보",
  grade: "등급",
};

interface ResultViewProps {
  details: WineDetails;
  /** 공유 링크로 연 결과인지 — 맞으면 머리 위에 안내를 보여준다 */
  shared?: boolean;
  /** [다른 와인 찾기] — 처음(업로드)으로 */
  onRestart: () => void;
}

/** 평론가 평점 한 줄 — 왼쪽 평가 주체, 오른쪽 점수, 아래 출처 */
function ScoreRow({ score }: { score: CriticScore }) {
  return (
    <li className="flex flex-col gap-0.5 border-b border-line/70 py-2 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span>{score.critic}</span>
        <span className="shrink-0 font-serif text-xl font-bold text-wine">{score.score}</span>
      </div>
      <span className="text-xs text-foreground/50">
        출처: <SourceName source={score.source} />
      </span>
    </li>
  );
}

/** 한 칸의 내용 — 표기 글자는 코드가 정한다 (Design Ref: §3.3) */
function FieldValue({ field, map }: { field: DetailField; map: WineMap | null }) {
  if (field.status === "not_found") {
    return <p className="text-foreground/40">정보 없음</p>;
  }
  if (field.status === "not_applicable") {
    return (
      <p className="text-foreground/40">
        해당 없음{field.reason ? ` (${field.reason})` : ""}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {field.key === "criticScores" ? (
        // 점수마다 출처를 따로 보여주므로 칸 전체 출처 줄은 두지 않는다 (같은 사이트가 두 번 보이지 않게)
        <ul className="flex flex-col" data-testid="critic-scores">
          {field.scores.map((score, index) => (
            <ScoreRow key={index} score={score} />
          ))}
        </ul>
      ) : (
        field.text && <p className="leading-relaxed">{field.text}</p>
      )}
      {/* PRD must 2 규칙 8 — 다른 빈티지 정보를 썼으면 기준 연도 */}
      {field.vintageBasis && (
        <p className="text-xs text-wine" data-testid="vintage-basis">
          ({field.vintageBasis}년 빈티지 기준)
        </p>
      )}
      {field.key !== "criticScores" && <SourceList sources={field.sources} />}
      {/* 1번 생산 국가·지역 칸에만 지도를 붙인다 */}
      {field.key === "origin" && map && <WineMapView map={map} />}
    </div>
  );
}

/** 유사 와인 추천 최대 3병 — PRD must 2 규칙 13. 확인된 와인이 없으면 "정보 없음" */
function RecommendationView({ recommendations }: { recommendations: SimilarWine[] }) {
  return (
    <div className="flex flex-col gap-3" data-testid="recommendation">
      <h2 className="text-xs font-bold tracking-[0.2em] text-foreground/50">비슷한 와인 추천</h2>
      {recommendations.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {recommendations.map((recommendation, index) => (
            <li
              key={`${recommendation.name}-${index}`}
              className="flex flex-col gap-1.5 border border-line px-5 py-4 text-[0.95rem]"
              data-testid="recommendation-item"
            >
              <p className="font-serif text-lg leading-snug font-bold">{recommendation.name}</p>
              {recommendation.producer && <p className="text-sm text-foreground/60">{recommendation.producer}</p>}
              <p className="leading-relaxed">{recommendation.reason}</p>
              <SourceList sources={recommendation.sources} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.95rem] text-foreground/40">정보 없음</p>
      )}
    </div>
  );
}

/** 공유 버튼 아래에 잠깐 보이는 안내 */
type ShareNotice = "copied" | "failed" | null;

export default function ResultView({ details, shared = false, onRestart }: ResultViewProps) {
  const { wine, summary } = details;
  const [shareNotice, setShareNotice] = useState<ShareNotice>(null);

  /** [링크 공유] — 휴대폰이면 공유 창을, 아니면 링크 복사를 한다 (PRD must 2 ⑤) */
  async function share() {
    setShareNotice(null);
    try {
      const url = await createShareUrl(details);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: `Vinclair · ${wine.name}`, url });
          return;
        } catch (error) {
          // 사용자가 공유 창을 닫은 경우는 오류로 보지 않는다
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      await navigator.clipboard.writeText(url);
      setShareNotice("copied");
    } catch {
      setShareNotice("failed");
    }
  }

  // 긴 결과를 스크롤해서 읽기 시작하므로, 결과가 뜨면 화면 맨 위(와인 이름)부터 보여준다
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // 9칸을 DETAIL_KEYS 순서로 그린다. 서버가 9칸을 보장하지만, 혹시 빠져도 "정보 없음"으로 그린다
  const fields = DETAIL_KEYS.map(
    (key) =>
      details.fields.find((field) => field.key === key) ?? {
        key,
        status: "not_found" as const,
        text: null,
        reason: null,
        sources: [],
        vintageBasis: null,
        scores: [],
      },
  );

  return (
    // 한국어는 단어 중간에서 줄을 바꾸지 않고(break-keep), 긴 주소·원어 이름만 넘치지 않게 필요하면 끊는다
    <section className="flex flex-col gap-8 px-6 pt-6 pb-10 break-keep wrap-break-word" data-testid="result-view">
      {shared && (
        <p className="border-l-2 border-wine bg-wine-soft px-4 py-2 text-xs text-foreground/70" data-testid="shared-notice">
          공유받은 결과예요. 만든 시점의 정보라 지금과 다를 수 있어요.
        </p>
      )}

      {/* 머리 — 와인명 + 빈티지, 생산자 */}
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-[1.75rem] leading-snug font-bold" data-testid="result-name">
          {wine.name}
        </h1>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {wine.vintage && (
            <span className="font-serif text-xl font-semibold tracking-widest text-wine" data-testid="result-vintage">
              {wine.vintage}
            </span>
          )}
          {wine.producer && (
            <span className="text-sm text-foreground/60" data-testid="result-producer">
              {wine.producer}
            </span>
          )}
        </div>
      </header>

      {/* 간략 설명 — 초보자가 가장 먼저 읽는 강조 박스 (Design Ref: §5.1 ⑤) */}
      {summary && (
        <div className="flex flex-col gap-2 border-l-2 border-wine bg-wine-soft px-5 py-5" data-testid="result-summary">
          <p className="text-xs font-bold tracking-[0.2em] text-wine">간략 설명</p>
          <p className="text-[0.95rem] leading-7">{summary}</p>
        </div>
      )}

      {/* 9개 항목 — PRD 순서대로 항상 9칸 */}
      <div className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-[0.2em] text-foreground/50">상세 정보</h2>
        <ol className="flex flex-col divide-y divide-line border-y border-line" data-testid="result-fields">
          {fields.map((field, index) => (
            <li key={field.key} className="flex gap-4 py-5 text-[0.95rem]" data-testid={`field-${field.key}`}>
              <span className="w-6 shrink-0 pt-0.5 font-serif text-sm text-wine" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <h3 className="font-bold">
                  <span className="sr-only">{index + 1}. </span>
                  {DETAIL_LABELS[field.key]}
                </h3>
                <FieldValue field={field} map={details.map} />
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* 유사 와인 추천 — 9개 항목 아래 (PRD must 2 ④) */}
      <RecommendationView recommendations={details.recommendations} />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void share()}
          className="flex h-14 w-full items-center justify-center rounded-sm border border-wine text-base font-bold tracking-[0.12em] text-wine transition-opacity active:opacity-85"
          data-testid="share-button"
        >
          링크 공유
        </button>
        {shareNotice && (
          <p className="text-center text-xs text-foreground/60" role="status" data-testid="share-notice">
            {shareNotice === "copied" ? "링크를 복사했어요. 원하는 곳에 붙여 넣어 보내세요" : "링크를 만들지 못했어요. 다시 시도해 주세요"}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onRestart}
        className="flex h-14 w-full items-center justify-center rounded-sm bg-wine text-base font-bold tracking-[0.12em] text-background transition-opacity active:opacity-85"
        data-testid="restart-button"
      >
        다른 와인 찾기
      </button>
    </section>
  );
}
