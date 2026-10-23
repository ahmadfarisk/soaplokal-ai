"use client";

import { useState } from "react";

export interface GenerationParams {
  temperature: number;
  top_p: number;
  top_k: number;
  repetition_penalty: number;
  max_tokens: number;
}

export const DEFAULT_GENERATION_PARAMS: GenerationParams = {
  temperature: 0.4,
  top_p: 0.3,
  top_k: 40,
  repetition_penalty: 1.1,
  max_tokens: 1024,
};

interface FieldConfig {
  key: keyof GenerationParams;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: FieldConfig[] = [
  {
    key: "temperature",
    label: "Temperature",
    hint: "Lower = more focused and faithful, higher = more varied. 0 = deterministic.",
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: "top_p",
    label: "Top-p",
    hint: "Only sample from the smallest set of tokens covering this much probability.",
    min: 0.1,
    max: 1,
    step: 0.05,
  },
  {
    key: "top_k",
    label: "Top-k",
    hint: "Only sample from the k most likely tokens. 0 = off.",
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: "repetition_penalty",
    label: "Repetition penalty",
    hint: "1.0 = off. Values above ~1.2 tend to cause gibberish.",
    min: 1,
    max: 1.5,
    step: 0.01,
  },
  {
    key: "max_tokens",
    label: "Max tokens",
    hint: "Hard cap on response length. Too low cuts the output off mid-sentence.",
    min: 64,
    max: 4096,
    step: 64,
  },
];

interface GenerationParamsPanelPopUpProps {
  params: GenerationParams;
  onChange: (params: GenerationParams) => void;
}

/**
 * Sampling controls for the LLM. These are sent with every /chat request,
 * so changing them never requires reloading the model.
 * Collapsed by default, like DownloadPanel.
 */
export default function GenerationParamsPanelPopUp({ params, onChange }: GenerationParamsPanelPopUpProps) {
  function setValue(key: keyof GenerationParams, raw: string) {
    const value = parseFloat(raw);
    if (Number.isNaN(value)) return;
    onChange({ ...params, [key]: value });
  }

  const [popupVisible, setPopupVisible] = useState(false);


  return (
    <div className="rounded-lg border border-button-border group w-full h-full flex items-center justify-center">
      <button 
        className="cursor-pointer text-text-main text-center text-sm w-full h-full px-3 py-2"
        onClick={() => setPopupVisible(true)}
      >
        Generation parameters
      </button>

      {popupVisible && 
        // Black screen
        <div className="fixed inset-0 w-screen h-screen bg-black/50 z-50 flex flex-col justify-center items-center">

          {/* Popup content */}
          <div className="flex flex-col gap-2 px-4 py-4 rounded-md bg-main-bg border border-contain-border mx-auto my-auto min-w-2xl w-fit">
            <div className="w-full flex justify-end">
              <button
                onClick={() => setPopupVisible(false)}
                className="text-md text-text-main cursor-pointer mb-2"
              >
                X
              </button>
            </div>
            {FIELDS.map((f) => (
              <div key={f.key}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-text-dark">{f.label}</label>
                  <input
                    type="number"
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={params[f.key]}
                    onChange={(e) => setValue(f.key, e.target.value)}
                    className="w-24 rounded-md border border-button-border px-2 py-1 text-sm text-text-main bg-main-bg text-right"
                  />
                </div>
                <input
                  type="range"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={params[f.key]}
                  onChange={(e) => setValue(f.key, e.target.value)}
                  className="w-full"
                />
                <p className="text-xs text-text-dark-2">{f.hint}</p>
              </div>
            ))}

            <button
              onClick={() => onChange(DEFAULT_GENERATION_PARAMS)}
              className="rounded-md border border-button-border text-text-main text-sm px-4 py-2 mt-3 cursor-pointer"
            >
              Reset to defaults
            </button>
          </div>

        </div>
      }

        

    </div>
  );
}
