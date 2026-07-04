import { fetch, ProxyAgent, type Dispatcher } from "undici";

// 默认攀枝花，泽在这里；后面可以做个"选城市"的设置
const LAT = Number(process.env.WEATHER_LAT || 26.5843);
const LON = Number(process.env.WEATHER_LON || 101.7168);

// 走跟 TTS 一样的代理策略：Node fetch 不读 HTTPS_PROXY，靠 undici dispatcher
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const dispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

export interface WeatherSnapshot {
  temp: number;   // 当前温度（℃，四舍五入到整数）
  high: number;   // 今日最高
  low: number;    // 今日最低
  code: number;   // WMO weather code
  icon: string;   // 对应 emoji
  updatedAt: string;
}

// WMO 天气代码 → emoji。分组参考 open-meteo 官方对照表。
const ICON_TABLE: Array<[number[], string]> = [
  [[0], "☀️"],
  [[1], "🌤"],
  [[2], "⛅"],
  [[3], "☁️"],
  [[45, 48], "🌫"],
  [[51, 53, 55, 56, 57], "🌦"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "🌧"],
  [[71, 73, 75, 77, 85, 86], "🌨"],
  [[95, 96, 99], "⛈"],
];

function iconFor(code: number): string {
  for (const [codes, emoji] of ICON_TABLE) {
    if (codes.includes(code)) return emoji;
  }
  return "🌡";
}

// 缓存 15 分钟，避免手机每次开首页都戳一次 Open-Meteo
let cache: { at: number; data: WeatherSnapshot } | null = null;
const TTL_MS = 15 * 60 * 1000;

export async function getWeather(): Promise<WeatherSnapshot | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}` +
      `&current=temperature_2m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min` +
      `&timezone=auto&forecast_days=1`;
    const res = await fetch(url, { dispatcher });
    if (!res.ok) return null;
    const raw = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    const cur = raw.current;
    const day = raw.daily;
    if (!cur || !day || cur.temperature_2m == null) return null;
    const snapshot: WeatherSnapshot = {
      temp: Math.round(cur.temperature_2m),
      high: Math.round(day.temperature_2m_max?.[0] ?? cur.temperature_2m),
      low: Math.round(day.temperature_2m_min?.[0] ?? cur.temperature_2m),
      code: cur.weather_code ?? 0,
      icon: iconFor(cur.weather_code ?? 0),
      updatedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), data: snapshot };
    return snapshot;
  } catch (err) {
    console.error(`[weather] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
