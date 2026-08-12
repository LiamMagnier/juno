with open("src/components/chat/composer.tsx", "r") as f:
    content = f.read()

# 1. Re-apply shadow-float to the composer
old_shadow = """          className={cn(
            "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-composer border bg-card/95 backdrop-blur sm:rounded-lg",
            "transition-[opacity,transform,border-color,box-shadow] duration-base ease-spring motion-reduce:transition-none","""

new_shadow = """          className={cn(
            "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-composer border bg-card/95 shadow-float sm:rounded-xl",
            "transition-[opacity,transform,border-color,box-shadow,height] duration-base ease-spring motion-reduce:transition-none","""

content = content.replace(old_shadow, new_shadow)

# 2. Fix the + Button trigger (remove badge, change animation to simple rotate-90)
old_trigger = """                  <Plus
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                  />
                  {/* The armed badge used to be gated on `researchArmed` alone, so
                      turning on web search, canvas, memory or three connectors left
                      the whole composer with no at-rest signal that anything was
                      armed — the count existed but only INSIDE the menu you had to
                      open to see it. Same count, now on the outside. Past one, the
                      dot cannot say how many, so it becomes the number. */}
                  {activeToolCount > 0 && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full bg-primary ring-2 ring-card motion-safe:animate-fade-in",
                        activeToolCount > 1
                          ? "h-3.5 min-w-3.5 px-[3px] font-mono text-[10px] font-medium leading-none tabular-nums text-primary-foreground"
                          : "h-2 w-2"
                      )}
                    >
                      {activeToolCount > 1 ? activeToolCount : null}
                    </span>
                  )}
                </Button>"""

new_trigger = """                  <Plus
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className="composer-add-icon size-4 transition-transform duration-base ease-out group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                  />
                  {activeToolCount > 0 && (
                    <span
                      aria-hidden
                      className="absolute right-0 top-0 flex size-2 items-center justify-center rounded-full bg-primary ring-2 ring-card motion-safe:animate-fade-in"
                    />
                  )}
                </Button>"""

content = content.replace(old_trigger, new_trigger)

# 3. Add premium drop shadow to the DropdownMenuContent
old_content_tag = """              <DropdownMenuContent
                align="start"
                side="top"
                sideOffset={8}
                className={voiceActive && !researchMenuItem ? "w-52" : "w-64"}
              >"""

new_content_tag = """              <DropdownMenuContent
                align="start"
                side="top"
                sideOffset={12}
                className={cn(voiceActive && !researchMenuItem ? "w-52" : "w-64", "rounded-xl shadow-float p-1")}
              >"""

content = content.replace(old_content_tag, new_content_tag)

# Remove the duplicate ModelSelector I accidentally injected during the first pass (it's back after git checkout)
# Wait, actually git checkout restored it to the commit *before* my duplicate injection, because I injected it.
# Let's verify. The duplicate was near line 2219. I'll just remove it if it exists.
dup_model_selector = """            {/* Model Selector & Thinking Slider inserted right here in the composer row */}
            <div className="ml-1">
              <ModelSelector
                value={model}
                onChange={onModelChange}
                reasoningEffort={reasoningEffort}
                onReasoningChange={onReasoningChange}
              />
            </div>"""

if dup_model_selector in content:
    content = content.replace(dup_model_selector, "")

with open("src/components/chat/composer.tsx", "w") as f:
    f.write(content)
print("Composer menu fixed and styled.")

