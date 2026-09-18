// Design Ref: §4.3, §7 — 생산지 지도에 쓸 위치를 OpenStreetMap(Nominatim)에서 찾는 파일
// PRD must 2 ③ 생산지 지도 (2026-09-17 추가) / PLAN 작업 18
// 보내는 값은 와인의 생산 국가·지역 이름뿐이다. 사진이나 이용자 정보는 보내지 않는다. (PRD 7항)
import "server-only";

import type { WineMap } from "@/types/wine";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/** Nominatim 이용 정책: 어떤 앱이 요청하는지 알려야 한다 */
const USER_AGENT = "Vinclair/0.1 (wine label info app; https://vinclair.vercel.app)";

/** 지도가 늦게 와도 결과 화면을 붙잡지 않도록 짧게 기다린다 */
const TIMEOUT_MS = 4000;

/**
 * 지도에 보이는 넓이(경도·위도 폭) — 지역 한 점만 보이지 않고 나라가 함께 보이도록 넓게 잡는다.
 * 예: 보르도 중심이면 프랑스 대부분, 나파 밸리 중심이면 캘리포니아 북부가 보인다.
 */
const VIEW_LON_SPAN = 12;
const VIEW_LAT_SPAN = 8;

/** 검색어 한 칸의 최대 길이 — AI가 준 이름을 그대로 보내므로 길이를 제한한다 */
const MAX_QUERY_PART = 80;

// 같은 지역을 반복해서 묻지 않게 서버가 켜져 있는 동안 기억해 둔다 (Nominatim 이용 정책: 결과 저장 권장)
const cache = new Map<string, { lat: number; lon: number } | null>();

interface NominatimPlace {
  lat: string;
  lon: string;
}

async function search(query: string): Promise<{ lat: number; lon: number } | null> {
  if (cache.has(query)) return cache.get(query) ?? null;

  const url = `${NOMINATIM_URL}?${new URLSearchParams({ q: query, format: "jsonv2", limit: "1" })}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null; // 일시 오류는 기억하지 않는다

  const places = (await response.json()) as NominatimPlace[];
  const lat = Number(places[0]?.lat);
  const lon = Number(places[0]?.lon);
  const point = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  cache.set(query, point);
  return point;
}

/**
 * 생산 국가·지역 이름으로 지도 정보를 만든다. 찾지 못하거나 오류가 나면 null (지도를 그리지 않는다)
 * - 지역이 있으면 "지역, 국가"로 찾고, 못 찾으면 국가만으로 찾는다
 */
export async function findWineMap(place: {
  country: string | null;
  region: string | null;
  label: string | null;
}): Promise<WineMap | null> {
  const country = place.country?.trim().slice(0, MAX_QUERY_PART) || null;
  const region = place.region?.trim().slice(0, MAX_QUERY_PART) || null;
  if (!country) return null;

  try {
    const regionPoint = region ? await search(`${region}, ${country}`) : null;
    const point = regionPoint ?? (await search(country));
    if (!point) return null;

    const west = Math.max(-180, point.lon - VIEW_LON_SPAN / 2);
    const east = Math.min(180, point.lon + VIEW_LON_SPAN / 2);
    const south = Math.max(-85, point.lat - VIEW_LAT_SPAN / 2);
    const north = Math.min(85, point.lat + VIEW_LAT_SPAN / 2);
    return {
      label: place.label?.trim() || [region, country].filter(Boolean).join(", "),
      lat: point.lat,
      lon: point.lon,
      // 지역을 못 찾아 국가 중심을 쓴 경우에는 표시 핀을 찍지 않는다 (엉뚱한 곳을 지역처럼 보이지 않게)
      marker: regionPoint !== null,
      bbox: [west, south, east, north],
    };
  } catch {
    // 시간 초과·연결 오류 — 지도만 빼고 결과는 그대로 보여준다
    return null;
  }
}
