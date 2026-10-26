"use client";

export type Phase = "idle" | "recording" | "transcribing" | "generating" | "done";

const CONFIG: Record<Phase, { label: string; pill: string; dot: string; indicator: "dot" | "ping" | "spinner" }> = {
  idle: {
    label: "Ready",
    pill: "border-slate-200 bg-slate-100 text-slate-700",
    dot: "bg-slate-400",
    indicator: "dot",
  },
  recording: {
    label: "Recording",
    pill: "border-rose-200 bg-rose-50 text-rose-700",
    dot: "bg-rose-500",
    indicator: "ping",
  },
  transcribing: {
    label: "Transcribing",
    pill: "border-amber-200 bg-amber-50 text-amber-800",
    dot: "bg-amber-500",
    indicator: "spinner",
  },
  generating: {
    label: "Writing SOAP note",
    pill: "border-violet-200 bg-violet-50 text-violet-700",
    dot: "bg-violet-500",
    indicator: "spinner",
  },
  done: {
    label: "Note ready",
    pill: "border-emerald-200 bg-emerald-50 text-emerald-700",
    dot: "bg-emerald-500",
    indicator: "dot",
  },
};

export default function StatusPill({ phase }: { phase: Phase }) {
  const config = CONFIG[phase];

  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2.5 rounded-full border px-4 py-1.5 text-sm font-medium ${config.pill}`}
    >
      {config.indicator === "spinner" && (
        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {config.indicator === "ping" && (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${config.dot}`} />
        </span>
      )}
      {config.indicator === "dot" && <span className={`inline-flex h-2.5 w-2.5 rounded-full ${config.dot}`} />}
      {config.label}
    </span>
  );
}

const STEPS = ["Capture audio", "Transcribe", "Write SOAP note"];

/** Three connected steps; the active one is highlighted, finished ones get a check. */
export function StatusSteps({ phase }: { phase: Phase }) {
  const active = phase === "recording" ? 0 : phase === "transcribing" ? 1 : phase === "generating" ? 2 : -1;
  const allDone = phase === "done";

  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm">
      {STEPS.map((label, index) => {
        const done = allDone || active > index;
        const current = active === index;

        const box = current
          ? "border-sky-300 bg-sky-50 text-sky-800"
          : done
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-slate-200 bg-white text-slate-600";
        const badge = current
          ? "bg-sky-600 text-white"
          : done
          ? "bg-emerald-600 text-white"
          : "bg-slate-200 text-slate-600";

        return (
          <li key={label} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 ${box}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold ${badge}`}>
              {done ? "\u2713" : index + 1}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}