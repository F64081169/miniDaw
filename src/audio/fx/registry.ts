import type { InsertType } from '../../core/types';

export interface FxParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  scale?: 'lin' | 'log';
  options?: { value: number; label: string }[];
}

export interface FxDef {
  type: InsertType;
  name: string;
  short: string;
  description: string;
  params: FxParamDef[];
}

export const DELAY_DIVISIONS = [
  { value: 0.25, label: '1/16' },
  { value: 0.5, label: '1/8' },
  { value: 0.75, label: '1/8 附點' },
  { value: 1, label: '1/4' },
  { value: 1.5, label: '1/4 附點' },
  { value: 2, label: '1/2' },
];

export const FX_DEFS: Record<InsertType, FxDef> = {
  eq: {
    type: 'eq',
    name: '頻道等化器',
    short: 'EQ',
    description: '低切、低頻／中頻／高頻三段調整與高切。先切掉不需要的低頻，是讓混音乾淨的第一步。',
    params: [
      { id: 'lowCut', label: '低切', min: 20, max: 1000, default: 20, unit: 'Hz', scale: 'log' },
      { id: 'lowFreq', label: '低頻', min: 40, max: 500, default: 100, unit: 'Hz', scale: 'log' },
      { id: 'lowGain', label: '低頻增益', min: -18, max: 18, default: 0, unit: 'dB' },
      { id: 'midFreq', label: '中頻', min: 150, max: 8000, default: 1000, unit: 'Hz', scale: 'log' },
      { id: 'midGain', label: '中頻增益', min: -18, max: 18, default: 0, unit: 'dB' },
      { id: 'midQ', label: '中頻 Q', min: 0.3, max: 8, default: 1, scale: 'log' },
      { id: 'highFreq', label: '高頻', min: 1500, max: 16000, default: 8000, unit: 'Hz', scale: 'log' },
      { id: 'highGain', label: '高頻增益', min: -18, max: 18, default: 0, unit: 'dB' },
      { id: 'highCut', label: '高切', min: 2000, max: 20000, default: 20000, unit: 'Hz', scale: 'log' },
    ],
  },
  comp: {
    type: 'comp',
    name: '壓縮器',
    short: 'Comp',
    description: '縮小音量起伏，讓聲音更穩定、更貼前。人聲、貝斯、鼓組最常用。',
    params: [
      { id: 'threshold', label: '門檻', min: -60, max: 0, default: -18, unit: 'dB' },
      { id: 'ratio', label: '比例', min: 1, max: 20, default: 3, unit: ':1', scale: 'log' },
      { id: 'attack', label: '起音', min: 0.1, max: 200, default: 10, unit: 'ms', scale: 'log' },
      { id: 'release', label: '釋放', min: 10, max: 1000, default: 150, unit: 'ms', scale: 'log' },
      { id: 'knee', label: '拐點', min: 0, max: 30, default: 6, unit: 'dB' },
      { id: 'makeup', label: '補償增益', min: 0, max: 24, default: 3, unit: 'dB' },
    ],
  },
  drive: {
    type: 'drive',
    name: '破音',
    short: 'Drive',
    description: '溫暖的類比飽和到粗獷的破音，讓聲音更有顆粒與存在感。',
    params: [
      { id: 'drive', label: '推力', min: 0, max: 1, default: 0.4 },
      { id: 'tone', label: '音色', min: 500, max: 12000, default: 4500, unit: 'Hz', scale: 'log' },
      { id: 'mix', label: '乾濕比', min: 0, max: 1, default: 1 },
      { id: 'output', label: '輸出', min: -24, max: 6, default: 0, unit: 'dB' },
    ],
  },
  chorus: {
    type: 'chorus',
    name: '合唱',
    short: 'Chorus',
    description: '讓聲音變寬、變厚，常用在清音吉他、電鋼琴、合成器。',
    params: [
      { id: 'rate', label: '速度', min: 0.05, max: 5, default: 0.6, unit: 'Hz', scale: 'log' },
      { id: 'depth', label: '深度', min: 0, max: 1, default: 0.5 },
      { id: 'mix', label: '乾濕比', min: 0, max: 1, default: 0.4 },
    ],
  },
  tremolo: {
    type: 'tremolo',
    name: '顫音／自動聲像',
    short: 'Trem',
    description: '週期性改變音量或左右位置，經典電鋼琴、衝浪吉他音色。',
    params: [
      { id: 'rate', label: '速度', min: 0.5, max: 12, default: 5, unit: 'Hz' },
      { id: 'depth', label: '深度', min: 0, max: 1, default: 0.5 },
      {
        id: 'stereo',
        label: '模式',
        min: 0,
        max: 1,
        default: 0,
        options: [
          { value: 0, label: '音量' },
          { value: 1, label: '聲像' },
        ],
      },
    ],
  },
  pump: {
    type: 'pump',
    name: '側鏈抽吸',
    short: 'Pump',
    description: '跟著拍子自動壓低音量再回彈，模擬 EDM 的側鏈壓縮「呼吸感」。',
    params: [
      { id: 'depth', label: '深度', min: 0, max: 1, default: 0.65 },
      { id: 'release', label: '回彈', min: 0.05, max: 0.95, default: 0.45, unit: '拍' },
      {
        id: 'division',
        label: '觸發',
        min: 0.5,
        max: 2,
        default: 1,
        options: [
          { value: 0.5, label: '每 1/8' },
          { value: 1, label: '每拍' },
          { value: 2, label: '每 2 拍' },
        ],
      },
    ],
  },
  lofi: {
    type: 'lofi',
    name: 'Lo-Fi 復古',
    short: 'Lo-Fi',
    description: '降位元、滾降高頻、錄音帶抖動與黑膠雜訊，一秒變 Lo-fi。',
    params: [
      { id: 'bits', label: '位元', min: 4, max: 16, default: 10 },
      { id: 'lowpass', label: '高頻滾降', min: 1000, max: 14000, default: 5200, unit: 'Hz', scale: 'log' },
      { id: 'wow', label: '抖動', min: 0, max: 1, default: 0.3 },
      { id: 'noise', label: '黑膠雜訊', min: 0, max: 1, default: 0.25 },
      { id: 'drive', label: '飽和', min: 0, max: 1, default: 0.3 },
    ],
  },
  delay: {
    type: 'delay',
    name: '立體延遲',
    short: 'Delay',
    description: '與速度同步的延遲回音，可切換左右乒乓。',
    params: [
      { id: 'time', label: '時值', min: 0.25, max: 2, default: 0.75, options: DELAY_DIVISIONS },
      { id: 'feedback', label: '回授', min: 0, max: 0.9, default: 0.35 },
      { id: 'mix', label: '乾濕比', min: 0, max: 1, default: 0.25 },
      { id: 'tone', label: '音色', min: 1000, max: 12000, default: 5000, unit: 'Hz', scale: 'log' },
      {
        id: 'pingpong',
        label: '乒乓',
        min: 0,
        max: 1,
        default: 1,
        options: [
          { value: 0, label: '關' },
          { value: 1, label: '開' },
        ],
      },
    ],
  },
};

export const INSERT_TYPES: InsertType[] = ['eq', 'comp', 'drive', 'chorus', 'tremolo', 'pump', 'lofi', 'delay'];

export function defaultFxParams(type: InsertType): Record<string, number> {
  return Object.fromEntries(FX_DEFS[type].params.map((p) => [p.id, p.default]));
}

export function formatParam(def: FxParamDef, v: number): string {
  if (def.options) {
    let best = def.options[0];
    for (const o of def.options) if (Math.abs(o.value - v) < Math.abs(best.value - v)) best = o;
    return best.label;
  }
  if (def.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`;
  if (def.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  if (def.unit === 'ms') return v < 10 ? v.toFixed(1) : `${Math.round(v)}`;
  if (def.unit === ':1') return v.toFixed(1);
  if (def.max <= 1 && def.min >= 0) return `${Math.round(v * 100)}%`;
  return v.toFixed(def.max - def.min > 20 ? 0 : 2);
}

// Bus (send/return) effect parameters
export const REVERB_PARAMS: FxParamDef[] = [
  { id: 'decay', label: '殘響長度', min: 0.3, max: 8, default: 2.2, unit: 's', scale: 'log' },
  { id: 'predelay', label: '預延遲', min: 0, max: 0.12, default: 0.02, unit: 's' },
  { id: 'damping', label: '高頻阻尼', min: 0, max: 1, default: 0.5 },
  { id: 'lowcut', label: '低切', min: 20, max: 800, default: 180, unit: 'Hz', scale: 'log' },
];

export const DELAY_BUS_PARAMS: FxParamDef[] = [
  { id: 'time', label: '時值', min: 0.25, max: 2, default: 0.75, options: DELAY_DIVISIONS },
  { id: 'feedback', label: '回授', min: 0, max: 0.9, default: 0.35 },
  { id: 'tone', label: '音色', min: 1000, max: 12000, default: 4500, unit: 'Hz', scale: 'log' },
  {
    id: 'pingpong',
    label: '乒乓',
    min: 0,
    max: 1,
    default: 1,
    options: [
      { value: 0, label: '關' },
      { value: 1, label: '開' },
    ],
  },
];

export function defaultsOf(defs: FxParamDef[]): Record<string, number> {
  return Object.fromEntries(defs.map((d) => [d.id, d.default]));
}
