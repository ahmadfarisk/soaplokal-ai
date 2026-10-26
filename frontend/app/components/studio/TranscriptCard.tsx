"use client";

import { useEffect, useRef, useState } from "react";
import { StatItem, ui } from "@/lib/studio";

interface TranscriptCardProps {
  transcript: string;
  onChange: (text: string) => void;
  /** True while audio is still being captured or transcribed. */
  readOnly: boolean;
  stats: StatItem[];
  onClear: () => void;
}

export default function TranscriptCard({ transcript, onChange, readOnly, stats, onClear }: TranscriptCardProps) {
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const trimmed = transcript.trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

  // Keep the newest text in view while a live transcript is growing.
  useEffect(() => {
    if (readOnly && textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [transcript, readOnly]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked; nothing useful to do.
    }
  }

  return (
    <section className={`${ui.card} flex flex-col`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className={ui.cardTitle}>Transcript</h2>
          <p className={`${ui.muted} mt-0.5`}>
            {readOnly ? "Listening and transcribing..." : "You can correct mistakes before the note is written."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
            {wordCount} {wordCount === 1 ? "word" : "words"}
          </span>
          <button className={`${ui.secondaryButton} !px-3 !py-1.5`} onClick={copy} disabled={!trimmed}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className={`${ui.secondaryButton} !px-3 !py-1.5`} onClick={onClear} disabled={!trimmed || readOnly}>
            Clear
          </button>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={transcript}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder="The transcript will appear here."
        className="mt-4 h-80 w-full resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[15px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-200 read-only:bg-slate-50"
      />

      {stats.length > 0 && (
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
    </section>
  );
}