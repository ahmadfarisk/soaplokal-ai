"use client";

import { useState } from "react";
interface SoapSections {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}


/**
 * Removes <think>...</think> blocks some "reasoning" models prepend to their
 * answer. Handles multiple blocks, and also handles an unclosed tag (the
 * model got cut off by max_tokens mid-thought) by dropping everything from
 * <think> to the end, so no stray reasoning leaks into the note.
 */
export function stripThinking(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/<think>[\s\S]*$/i, "");
  return text.trim();
}

/**
 * Splits the LLM's raw response into the four SOAP sections. Relies on the
 * prompt (see page.tsx) instructing the model to use these exact headers.
 * Falls back gracefully if the model didn't follow the format perfectly —
 * anything unmatched lands in "subjective" so nothing silently disappears.
 * Strips <think>...</think> reasoning blocks before parsing, so a thinking
 * model's scratchpad never ends up inside a SOAP section.
 */
export function parseSoapNote(raw: string): SoapSections {
  const sections: SoapSections = { subjective: "", objective: "", assessment: "", plan: "" };

  const cleaned = stripThinking(raw);
  const pattern = /\*{0,2}(Subjective|Objective|Assessment|Plan)\*{0,2}\s*:?\s*\*{0,2}\s*\n?/gi
  const parts = cleaned.split(pattern);

  // raw.split with a capturing group interleaves: [textBefore, header, textAfter, header, textAfter, ...]
  let currentKey: keyof SoapSections | null = null;
  for (const part of parts) {
    const lower = part.trim().toLowerCase();
    if (lower === "subjective" || lower === "objective" || lower === "assessment" || lower === "plan") {
      currentKey = lower as keyof SoapSections;
    } else if (currentKey) {
      sections[currentKey] += part.trim();
    } else if (part.trim()) {
      // Text before any recognized header — keep it rather than dropping it.
      sections.subjective += part.trim();
    }
  }

  return sections;
}

interface SoapNoteResultProps {
  rawText: string;
}

export default function SoapNoteResult({ rawText }: SoapNoteResultProps) {
  const [viewRaw, setViewRaw] = useState(false);

  function toggleViewRaw() {
    setViewRaw(!viewRaw)
  }

  if (!rawText) {
    return (
      <section className="rounded-lg border border-gray-200 p-4 h-auto">
        <h2 className="text-sm font-medium text-gray-400 mb-3">SOAP note</h2>
        <p className="text-sm text-gray-400">Generated note will appear here.</p>
      </section>
    );
  }

  const { subjective, objective, assessment, plan } = parseSoapNote(rawText);

  const rows: { label: string; value: string }[] = [
    { label: "Subjective", value: subjective },
    { label: "Objective", value: objective },
    { label: "Assessment", value: assessment },
    { label: "Plan", value: plan },
  ];

  return (
    <section className="rounded-lg border border-gray-200 p-4">

      <div className="flex justify-between">
        <h2 className="text-sm font-medium text-gray-400 mb-3">SOAP note</h2>
        <button
          className={`text-xs ${viewRaw ? "text-green-700" : "text-gray-400"}`}
          onClick={toggleViewRaw}
        >
          Raw Toggle
        </button>
      </div>

      {viewRaw ? 
        <div className="space-y-4">
          <p>
            {rawText}
          </p>
        </div>
      : 
        <div className="space-y-4">
          {rows.map((row) => (
            <div key={row.label}>
              {/* Title/Label (eg. Subjective, Objective, etc.) */}
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-200 mb-1">
                {row.label}
              </h3>
              {/* The values*/}
              <p className="text-sm whitespace-pre-wrap text-gray-400">
                {row.value || <span className="text-gray-100">—</span>}
              </p>
            </div>
          ))}
        </div>
      }
    </section>
  );
}