"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/components/app/app-provider";
import { ChoiceMenu } from "@/components/settings/choice-menu";
import { useSaveStates } from "@/components/settings/save-status";
import { useSettingsSave } from "@/components/settings/use-settings-save";
import { SettingBlock, SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { SaveStatus } from "@/components/settings/save-status";
import { EditorialSection } from "@/components/app/editorial";
import { cn } from "@/lib/utils";
import { PERSONALITIES, DEFAULT_PERSONALITY, isPersonalityId } from "@/lib/personalities";
import { PRODUCT_NAME } from "@/lib/brand/names";

/** Reply languages, stored by their English name, which is what the prompt builder reads. */
const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Match my message" },
  { value: "English", label: "English" },
  { value: "Spanish", label: "Spanish" },
  { value: "French", label: "French" },
  { value: "German", label: "German" },
  { value: "Portuguese", label: "Portuguese" },
  { value: "Italian", label: "Italian" },
  { value: "Japanese", label: "Japanese" },
  { value: "Korean", label: "Korean" },
  { value: "Chinese", label: "Chinese" },
  { value: "Hindi", label: "Hindi" },
  { value: "Arabic", label: "Arabic" },
];

/**
 * How Juno talks to you: what it calls you, what it keeps in mind, its tone
 * and its language.
 *
 * The name lives here and only here. Account had a second Name field with its
 * own save path, and the two could each show a different "Saved".
 */
/**
 * `page` is the Instructions page in Customize: the same fields and saves,
 * set as a writing page (a large field for the instructions, the
 * personalities as cards) rather than as settings rows.
 */
export function PersonalizationSection({ variant = "settings" }: { variant?: "settings" | "page" } = {}) {
  const router = useRouter();
  const { user, settings } = useApp();
  const save = useSettingsSave();
  const saves = useSaveStates();

  const activePersonality = isPersonalityId(settings.personality) ? settings.personality : DEFAULT_PERSONALITY;
  const personalityOptions = React.useMemo(
    () => PERSONALITIES.map((p) => ({ value: p.id, label: p.label, description: p.description })),
    []
  );

  const [name, setName] = React.useState(user.name ?? "");
  // The name last sent, so the unmount flush below does not send it again
  // while the refresh that brings `user.name` up to date is still on its way.
  const nameSent = React.useRef<string | null>(null);
  React.useEffect(() => {
    nameSent.current = null;
  }, [user.name]);
  const saveName = () => {
    const value = name.trim();
    if (value === (user.name ?? "") || value === nameSent.current) return;
    nameSent.current = value;
    void saves.track("name", async () => {
      // Not through useSettingsSave: the name is a User column, not a
      // Settings one, and it is server-rendered into the bootstrap (sidebar,
      // greeting), so a refresh is what makes every surface agree.
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      }).catch(() => null);
      if (!res?.ok) {
        if (nameSent.current === value) nameSent.current = null;
        toast.error("Couldn’t save your name.");
        return false;
      }
      router.refresh();
      return true;
    });
  };

  // A language set elsewhere (a native app, an older build) still shows as
  // itself rather than as an empty select.
  const languages = LANGUAGES.some((l) => l.value === settings.responseLanguage)
    ? LANGUAGES
    : [...LANGUAGES, { value: settings.responseLanguage, label: settings.responseLanguage }];

  const [instructions, setInstructions] = React.useState(settings.customInstructions);
  const saveInstructions = () => {
    if (instructions === settings.customInstructions) return;
    void saves.track("customInstructions", () => save({ customInstructions: instructions }));
  };

  // A draft still being typed is saved when the section goes away, not only
  // on blur. Escape, ⌘, or a navigation unmounts the section with the field
  // still focused, and React never hears that field's blur (the browser fires
  // it on a node already detached from the root), so the text was dropped.
  // Each saver returns early when there is nothing new, so a field that did
  // blur first is not saved twice.
  const flushDrafts = React.useRef<() => void>(() => {});
  React.useLayoutEffect(() => {
    flushDrafts.current = () => {
      saveName();
      saveInstructions();
    };
  });
  React.useEffect(() => {
    const flush = flushDrafts;
    return () => flush.current();
  }, []);

  if (variant === "page") {
    const words = instructions.trim() ? instructions.trim().split(/\s+/).length : 0;
    return (
      <div className="space-y-16">
        <EditorialSection
          title="About you"
          meta={<span>Every chat reads this</span>}
          controls={
            <div className="flex flex-col items-start gap-1.5">
              <SaveStatus state={saves.status("customInstructions")} />
              <SaveStatus state={saves.status("name")} />
            </div>
          }
        >
          <label htmlFor="personal-name" className="block text-ui font-medium text-foreground">
            {`What ${PRODUCT_NAME} calls you`}
          </label>
          <Input
            id="personal-name"
            value={name}
            maxLength={80}
            placeholder="Your name"
            autoComplete="given-name"
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className="mt-2 h-10 max-w-sm"
          />

          <div className="mt-8 flex items-baseline justify-between gap-3">
            <label htmlFor="custom-instructions" className="text-ui font-medium text-foreground">
              Custom instructions
            </label>
            <span className="ed-annot">{words === 1 ? "1 word" : `${words} words`}</span>
          </div>
          <p className="mt-1 max-w-[34rem] text-ui text-muted-foreground">
            {`${PRODUCT_NAME} keeps these in mind in every conversation: who you are, what you work on, how you like answers.`}
          </p>
          <Textarea
            id="custom-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={saveInstructions}
            placeholder="For example: I’m a product manager. Keep answers short and use bullet points."
            className="mt-3 min-h-56 rounded-card px-4 py-3.5 text-body leading-relaxed"
          />
        </EditorialSection>

        <EditorialSection
          title="Responses"
          meta={<span>Your instructions come first</span>}
          controls={<SaveStatus state={saves.status("personality")} />}
        >
          <div role="radiogroup" aria-label="Personality" className="ed-stagger grid gap-2 @[34rem]/ed:grid-cols-2 @[52rem]/ed:grid-cols-3">
            {PERSONALITIES.map((p) => {
              const on = p.id === activePersonality;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    if (on) return;
                    void saves.track("personality", () => save({ personality: p.id }));
                  }}
                  className={cn(
                    "group/p relative flex min-h-[6.5rem] flex-col items-start rounded-card border p-4 text-left transition-[border-color,background-color,transform] duration-base ease-out-soft active:scale-[0.99] motion-reduce:transition-none",
                    on
                      ? "border-foreground/70 bg-background"
                      : "border-border/70 hover:border-foreground/30 hover:bg-muted/50"
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="ed-h3 text-foreground">{p.label}</span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid size-4 place-items-center rounded-full border transition-colors duration-fast",
                        on ? "border-foreground bg-foreground" : "border-border"
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full bg-background transition-transform duration-base ease-out-soft", on ? "scale-100" : "scale-0")} />
                    </span>
                  </span>
                  <span className="mt-1.5 text-ui text-muted-foreground">{p.description}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-ui font-medium text-foreground">Response language</p>
              <p className="text-ui text-muted-foreground">{`The language ${PRODUCT_NAME} replies in.`}</p>
            </div>
            <div className="flex items-center gap-3">
              <SaveStatus state={saves.status("responseLanguage")} />
              <Select
                value={settings.responseLanguage}
                onValueChange={(responseLanguage) => void saves.track("responseLanguage", () => save({ responseLanguage }))}
              >
                <SelectTrigger aria-label="Response language" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </EditorialSection>
      </div>
    );
  }

  return (
    <>
      <SettingsGroup>
        <SettingRow
          label={`What ${PRODUCT_NAME} calls you`}
          htmlFor="personal-name"
          description="Used in greetings, and shown in the sidebar."
          wide
          status={saves.status("name")}
          control={
            <Input
              id="personal-name"
              value={name}
              maxLength={80}
              placeholder="Your name"
              autoComplete="given-name"
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="w-full @[34rem]/pane:w-56"
            />
          }
        />
        <SettingBlock
          label="Custom instructions"
          description={`${PRODUCT_NAME} keeps these in mind in every conversation.`}
          status={saves.status("customInstructions")}
        >
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={saveInstructions}
            placeholder="For example: I’m a product manager. Keep answers short and use bullet points."
            className="min-h-32"
            aria-label="Custom instructions"
          />
        </SettingBlock>
      </SettingsGroup>

      <SettingsGroup title="Responses" description="Your custom instructions take priority over both.">
        <SettingRow
          label="Personality"
          description={PERSONALITIES.find((p) => p.id === activePersonality)?.description}
          wide
          status={saves.status("personality")}
          control={
            <ChoiceMenu
              label="Personality"
              value={activePersonality}
              options={personalityOptions}
              onChange={(personality) => {
                if (personality === activePersonality) return;
                void saves.track("personality", () => save({ personality }));
              }}
              className="@[34rem]/pane:w-52"
            />
          }
        />
        <SettingRow
          label="Response language"
          description={`The language ${PRODUCT_NAME} replies in.`}
          wide
          status={saves.status("responseLanguage")}
          control={
            <Select
              value={settings.responseLanguage}
              onValueChange={(responseLanguage) =>
                void saves.track("responseLanguage", () => save({ responseLanguage }))
              }
            >
              <SelectTrigger aria-label="Response language" className="w-full @[34rem]/pane:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroup>
    </>
  );
}
