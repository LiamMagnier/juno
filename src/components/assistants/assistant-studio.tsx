"use client";

import React, { useState } from "react";
import { Bot, Save, X, Plus, Trash2 } from "lucide-react";
import type { JunoAssistantConfig, CreateAssistantInput } from "@/lib/assistants";
import { MODEL_LIST } from "@/lib/models";

interface AssistantStudioProps {
  initialAssistant?: JunoAssistantConfig | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (assistant: JunoAssistantConfig) => void;
}

export function AssistantStudio({ initialAssistant, isOpen, onClose, onSave }: AssistantStudioProps) {
  const [name, setName] = useState(initialAssistant?.name || "");
  const [description, setDescription] = useState(initialAssistant?.description || "");
  const avatarIcon = initialAssistant?.avatarIcon || "bot";
  const [systemPrompt, setSystemPrompt] = useState(initialAssistant?.systemPrompt || "");
  const [starterPrompts, setStarterPrompts] = useState<string[]>(
    initialAssistant?.starterPrompts || ["How can you help me today?"]
  );
  const [preferredModelId, setPreferredModelId] = useState(initialAssistant?.preferredModelId || "juno:auto");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAddStarter = () => {
    setStarterPrompts([...starterPrompts, ""]);
  };

  const handleRemoveStarter = (index: number) => {
    setStarterPrompts(starterPrompts.filter((_, i) => i !== index));
  };

  const handleUpdateStarter = (index: number, val: string) => {
    const updated = [...starterPrompts];
    updated[index] = val;
    setStarterPrompts(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !systemPrompt.trim()) {
      setError("Please provide a name and system prompt instructions.");
      return;
    }

    setIsSaving(true);
    setError(null);

    const payload: CreateAssistantInput = {
      name: name.trim(),
      description: description.trim(),
      avatarIcon,
      systemPrompt: systemPrompt.trim(),
      starterPrompts: starterPrompts.filter((p) => p.trim().length > 0),
      preferredModelId: preferredModelId === "juno:auto" ? undefined : preferredModelId,
    };

    try {
      const url = initialAssistant ? `/api/assistants/${initialAssistant.id}` : "/api/assistants";
      const method = initialAssistant ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save assistant");
      }

      const data = await res.json();
      onSave(data.assistant);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="flex flex-col w-full max-w-2xl max-h-[90vh] rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-coral-500/10 text-coral-600 dark:text-coral-400">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {initialAssistant ? "Edit Assistant" : "Create Juno Assistant"}
              </h2>
              <p className="text-xs text-neutral-500">
                Configure custom instructions, preferred model, and capabilities.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4 text-xs">
          {error && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 p-3 text-rose-600 dark:text-rose-400">
              {error}
            </div>
          )}

          {/* Name & Description */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Assistant Name *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Python Data Analyst"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-9 rounded-lg border border-neutral-200 bg-white px-3 text-xs text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-coral-500"
              />
            </div>

            <div>
              <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Preferred Model
              </label>
              <select
                value={preferredModelId}
                onChange={(e) => setPreferredModelId(e.target.value)}
                className="w-full h-9 rounded-lg border border-neutral-200 bg-white px-3 text-xs text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-coral-500"
              >
                <option value="juno:auto">Auto (Intelligent Routing)</option>
                {MODEL_LIST.filter((m) => m.modality === "chat" && !m.comingSoon).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Short Description
            </label>
            <input
              type="text"
              placeholder="What does this assistant do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full h-9 rounded-lg border border-neutral-200 bg-white px-3 text-xs text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-coral-500"
            />
          </div>

          {/* Instructions */}
          <div>
            <label className="block font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Instructions (System Prompt) *
            </label>
            <textarea
              required
              rows={5}
              placeholder="Provide exact behavioral guidelines, persona, output styles, and domain constraints..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 bg-white p-3 font-mono text-xs text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-coral-500"
            />
          </div>

          {/* Starter Prompts */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-medium text-neutral-700 dark:text-neutral-300">
                Starter Prompts
              </label>
              <button
                type="button"
                onClick={handleAddStarter}
                className="flex items-center gap-1 text-coral-600 dark:text-coral-400 hover:underline text-caption"
              >
                <Plus className="h-3 w-3" /> Add Prompt
              </button>
            </div>
            <div className="space-y-2">
              {starterPrompts.map((prompt, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. Analyze this CSV dataset for correlations..."
                    value={prompt}
                    onChange={(e) => handleUpdateStarter(idx, e.target.value)}
                    className="flex-1 h-8 rounded-lg border border-neutral-200 bg-white px-3 text-xs text-neutral-900 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-coral-500"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveStarter(idx)}
                    className="p-1.5 text-neutral-400 hover:text-rose-500 rounded-sm"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-6 py-3.5 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="flex items-center gap-1.5 rounded-lg bg-coral-500 px-4 py-2 text-xs font-medium text-white shadow hover:bg-coral-600 disabled:opacity-50 transition"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{isSaving ? "Saving..." : "Save Assistant"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
