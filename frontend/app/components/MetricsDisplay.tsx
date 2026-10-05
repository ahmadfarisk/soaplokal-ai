"use client";

export interface LlmMetrics {
  total_seconds: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tokens_per_second: number | null;
}

export interface SttMetrics {
  processing_seconds: number;
  audio_seconds: number | null;
  real_time_factor: number | null;
}

export interface MetricItem {
  label: string;
  value: string;
}

const num = (n: number | null | undefined, digits = 2, suffix = "") =>
  n == null ? "—" : `${n.toFixed(digits)}${suffix}`;

const int = (n: number | null | undefined) => (n == null ? "—" : String(n));

export function llmMetricItems(m: LlmMetrics): MetricItem[] {
  return [
    { label: "Time", value: num(m.total_seconds, 2, " s") },
    { label: "Prompt tokens", value: int(m.prompt_tokens) },
    { label: "Output tokens", value: int(m.completion_tokens) },
    { label: "Speed", value: num(m.tokens_per_second, 1, " tok/s") },
  ];
}

export function sttMetricItems(m: SttMetrics): MetricItem[] {
  return [
    { label: "Processing", value: num(m.processing_seconds, 2, " s") },
    { label: "Audio length", value: num(m.audio_seconds, 1, " s") },
    // Under 1.0 = faster than real time (e.g. 0.5 = 1 min of audio in 30 s)
    { label: "Real-time factor", value: num(m.real_time_factor, 2, "x") },
  ];
}

export default function MetricsDisplay({ items }: { items: MetricItem[] | null }) {
  if (!items) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {items.map((item) => (
        <span
          key={item.label}
          className="rounded-md border border-gray-700 py-1 px-2 text-xs text-gray-400"
        >
          {item.label}: <span className="text-gray-200">{item.value}</span>
        </span>
      ))}
    </div>
  );
}