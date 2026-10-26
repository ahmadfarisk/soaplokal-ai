"use client";

import { useMemo, useState } from "react";
import { SoapSections, StatItem, formatSoapForCopy, parseSoap, ui } from "@/lib/studio";

interface SoapNoteCardProps {
  rawNote: string;
  generating: boolean;
  canGenerate: boolean;
  /** Why the button is disabled, shown as a hint (null when it isn't). */
  disabledReason: string | null;
  /** Shown when the note could not be written automatically. */
  hint: string | null;
  autoGenerate: boolean;
  onAutoGenerateChange: (value: boolean) => void;
  onGenerate: () => void;
  stats: StatItem[];
}

const SECTIONS: {
  key: keyof SoapSections;
  label: string;
  hint: string;
  box: string;
  title: string;
}[] = [
  { key: "subjective", label: "Subjective", hint: "What the patient reports", box: "border-sky-100 bg-sky-50", title: "text-sky-800" },
  { key: "objective", label: "Objective", hint: "Measurements and findings", box: "border-emerald-100 bg-emerald-50", title: "text-emerald-800" },
  { key: "assessment", label: "Assessment", hint: "The doctor's impression", box: "border-amber-100 bg-amber-50", title: "text-amber-800" },
  { key: "plan", label: "Plan", hint: "Treatment and follow-up", box: "border-violet-100 bg-violet-50", title: "text-violet-800" },
];

export default function SoapNoteCard({
  rawNote,
  generating,
  canGenerate,
  disabledReason,
  hint,
  autoGenerate,
  onAutoGenerateChange,
  onGenerate,
  stats,
}: SoapNoteCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const sections = useMemo(() => parseSoap(rawNote), [rawNote]);
  const hasNote = rawNote.trim().length > 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatSoapForCopy(sections));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked; nothing useful to do.
    }
  }

  return (
    <section className={`${ui.card} flex flex-col`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={ui.cardTitle}>Catatan SOAP</h2>
          <p className={`${ui.muted} mt-0.5`}>Draf yang ditulis berdasarkan transkrip.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className={`${ui.secondaryButton} !px-3 !py-1.5`} onClick={() => setShowRaw((v) => !v)} disabled={!hasNote}>
            {showRaw ? "Formatted view" : "Raw view"}
          </button>
          <button className={`${ui.secondaryButton} !px-3 !py-1.5`} onClick={copy} disabled={!hasNote || generating}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className={ui.primaryButton} onClick={onGenerate} disabled={!canGenerate || generating}>
            {generating && <span className={ui.spinner} />}
            {generating ? "Writing..." : hasNote ? "Regenerate" : "Generate SOAP note"}
          </button>
        </div>
      </div>

      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={autoGenerate}
          onChange={(e) => onAutoGenerateChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 accent-sky-600"
        />
        Tulis catatan secara otomatis setelah transkripsi
      </label>

      {!canGenerate && disabledReason && !generating && (
        <p className="mt-2 text-sm text-slate-600">{disabledReason}</p>
      )}
      {hint && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{hint}</p>
      )}

      <div className="mt-4 flex-1">
        {generating ? (
          <div className="space-y-3" aria-label="Writing the SOAP note">
            {SECTIONS.map((s) => (
              <div key={s.key} className={`animate-pulse rounded-2xl border p-4 ${s.box}`}>
                <div className="h-3 w-24 rounded-full bg-slate-300/70" />
                <div className="mt-3 h-3 w-full rounded-full bg-slate-200" />
                <div className="mt-2 h-3 w-4/5 rounded-full bg-slate-200" />
              </div>
            ))}
          </div>
        ) : !hasNote ? (
          <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 text-center text-sm text-slate-600">
            The SOAP note will appear here once the transcript is ready.
          </div>
        ) : showRaw ? (
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-800">
            {rawNote}
          </pre>
        ) : (
          <div className="space-y-3">
            {SECTIONS.map((s) => (
              <div key={s.key} className={`rounded-2xl border p-4 ${s.box}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className={`text-sm font-semibold ${s.title}`}>{s.label}</h3>
                  {/* <span className="text-xs text-slate-600">{s.hint}</span> */}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-800">
                  {sections[s.key] || <span className="italic text-slate-600">Nothing recorded.</span>}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {stats.length > 0 && !generating && (
        <div className="mt-3 flex flex-wrap gap-2">
          {stats.map((s) => (
            <span
              key={s.label}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600"
            >
              {s.label}: <span className="font-medium text-slate-800">{s.value}</span>
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-slate-600">
        AI-generated draft. A clinician should review it for accuracy before it is used.
      </p>
    </section>
  );
}