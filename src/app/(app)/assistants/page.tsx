"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Bot, Plus, Search, Edit3, Trash2, Pin, ArrowRight } from "lucide-react";
import type { JunoAssistantConfig } from "@/lib/assistants";
import { AssistantStudio } from "@/components/assistants/assistant-studio";

export default function AssistantsPage() {
  const router = useRouter();
  const [assistants, setAssistants] = useState<JunoAssistantConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [studioOpen, setStudioOpen] = useState(false);
  const [editingAssistant, setEditingAssistant] = useState<JunoAssistantConfig | null>(null);

  const fetchAssistants = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/assistants");
      if (res.ok) {
        const data = await res.json();
        setAssistants(data.assistants || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAssistants();
  }, []);

  const handleStartChatWithAssistant = (assistant: JunoAssistantConfig) => {
    router.push(`/chat?assistantId=${assistant.id}`);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this assistant?")) return;

    try {
      const res = await fetch(`/api/assistants/${id}`, { method: "DELETE" });
      if (res.ok) {
        setAssistants((prev) => prev.filter((a) => a.id !== id));
      }
    } catch {
      // ignore
    }
  };

  const handleTogglePin = async (assistant: JunoAssistantConfig, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/assistants/${assistant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPinned: !assistant.isPinned }),
      });
      if (res.ok) {
        const data = await res.json();
        setAssistants((prev) => prev.map((a) => (a.id === assistant.id ? data.assistant : a)));
      }
    } catch {
      // ignore
    }
  };

  const filteredAssistants = assistants.filter(
    (a) =>
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center gap-2.5">
            <Bot className="h-6 w-6 text-coral-500" />
            <span>Juno Assistants</span>
          </h1>
          <p className="text-sm text-neutral-500 mt-1">
            Specialized AI assistants with dedicated knowledge, custom instructions, and configured tools.
          </p>
        </div>

        <button
          onClick={() => {
            setEditingAssistant(null);
            setStudioOpen(true);
          }}
          className="flex items-center gap-2 rounded-xl bg-coral-500 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-coral-600 transition"
        >
          <Plus className="h-4 w-4" />
          <span>New Assistant</span>
        </button>
      </div>

      {/* Search & Filter */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
        <input
          type="text"
          placeholder="Search assistants..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full h-10 rounded-xl border border-neutral-200 bg-white/80 pl-9 pr-4 text-xs text-neutral-900 placeholder:text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-coral-500/20 focus:border-coral-500 transition"
        />
      </div>

      {/* Gallery Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-2xl border border-neutral-200/60 bg-neutral-100/50 dark:border-neutral-800 dark:bg-neutral-900/40 animate-pulse" />
          ))}
        </div>
      ) : filteredAssistants.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-dashed border-neutral-300 dark:border-neutral-800 p-8">
          <Bot className="h-10 w-10 text-neutral-400 mb-3 opacity-60" />
          <h3 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {searchQuery ? "No matching assistants" : "No assistants created yet"}
          </h3>
          <p className="text-xs text-neutral-500 mt-1 max-w-sm">
            {searchQuery
              ? "Try adjusting your search query."
              : "Create custom assistants tailored to your specific workflows, datasets, and tasks."}
          </p>
          {!searchQuery && (
            <button
              onClick={() => {
                setEditingAssistant(null);
                setStudioOpen(true);
              }}
              className="mt-4 flex items-center gap-1.5 rounded-lg bg-coral-500 px-3.5 py-2 text-xs font-medium text-white hover:bg-coral-600 transition"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create your first assistant</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAssistants.map((assistant) => (
            <div
              key={assistant.id}
              onClick={() => handleStartChatWithAssistant(assistant)}
              className="group relative flex flex-col justify-between rounded-2xl border border-neutral-200 bg-white p-5 hover:border-coral-500/40 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900/80 dark:hover:border-coral-500/40 transition cursor-pointer"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-coral-500/10 text-coral-600 dark:text-coral-400">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      onClick={(e) => handleTogglePin(assistant, e)}
                      title={assistant.isPinned ? "Unpin" : "Pin"}
                      className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-800 dark:hover:text-neutral-200"
                    >
                      <Pin className={`h-3.5 w-3.5 ${assistant.isPinned ? "fill-coral-500 text-coral-500" : ""}`} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingAssistant(assistant);
                        setStudioOpen(true);
                      }}
                      title="Edit"
                      className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-800 dark:hover:text-neutral-200"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(assistant.id, e)}
                      title="Delete"
                      className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-rose-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                  {assistant.name}
                  {assistant.isPinned && <span className="h-1.5 w-1.5 rounded-full bg-coral-500" />}
                </h3>
                <p className="text-xs text-neutral-500 mt-1 line-clamp-2">
                  {assistant.description || "Custom assistant"}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between text-xs text-neutral-400">
                <span className="text-caption font-medium text-coral-600 dark:text-coral-400 flex items-center gap-1 group-hover:translate-x-0.5 transition">
                  Start chat <ArrowRight className="h-3 w-3" />
                </span>
                <span className="text-micro">v{assistant.version}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Studio Modal */}
      <AssistantStudio
        isOpen={studioOpen}
        initialAssistant={editingAssistant}
        onClose={() => {
          setStudioOpen(false);
          setEditingAssistant(null);
        }}
        onSave={(saved) => {
          if (editingAssistant) {
            setAssistants((prev) => prev.map((a) => (a.id === saved.id ? saved : a)));
          } else {
            setAssistants((prev) => [saved, ...prev]);
          }
        }}
      />
    </div>
  );
}
