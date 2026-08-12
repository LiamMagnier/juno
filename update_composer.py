import re

with open("src/components/chat/composer.tsx", "r") as f:
    content = f.read()

# First replace the shadow-float
old_shadow = """          className={cn(
            "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-composer border bg-card/95 backdrop-blur sm:rounded-lg",
            "transition-[opacity,transform,border-color,box-shadow] duration-base ease-spring motion-reduce:transition-none","""

new_shadow = """          className={cn(
            "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-composer border bg-card/95 shadow-float sm:rounded-xl",
            "transition-[opacity,transform,border-color,box-shadow,height] duration-base ease-spring motion-reduce:transition-none","""

content = content.replace(old_shadow, new_shadow)

# Find the start of the + menu dropdown
start_marker = "<DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>"
end_marker = "</DropdownMenu>"

# We want the </DropdownMenu> right before "One divider height"
idx_start = content.find(start_marker)
idx_end = content.find("One divider height, one breakpoint", idx_start)

# backtrack to the exact </DropdownMenu>
idx_end_actual = content.rfind(end_marker, idx_start, idx_end) + len(end_marker)

replacement_popover = """<Popover open={plusOpen} onOpenChange={setPlusOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={armedSummary ? `Add — ${armedSummary}` : "Add"}
                  disabled={controlsLocked}
                  className={cn(
                    "composer-add-button group shrink-0 rounded-composer-control coarse:h-11 coarse:w-11",
                    plusOpen && "bg-accent"
                  )}
                >
                  <Plus
                    aria-hidden="true"
                    strokeWidth={1.75}
                    className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                  />
                  {activeToolCount > 0 && (
                    <span
                      aria-hidden
                      className="absolute right-0 top-0 flex size-2 items-center justify-center rounded-full bg-primary ring-2 ring-card motion-safe:animate-fade-in"
                    />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                side="top"
                sideOffset={12}
                className="w-[280px] p-2 rounded-xl shadow-float"
              >
                <div className="grid grid-cols-2 gap-1">
                  <Button
                    variant="ghost"
                    className="flex h-20 flex-col items-center justify-center gap-2 rounded-xl transition-all duration-fast ease-out hover:-translate-y-0.5 hover:bg-accent hover:shadow-soft"
                    disabled={!features.storage || privateMode}
                    onClick={() => { imageInputRef.current?.click(); setPlusOpen(false); }}
                  >
                    <ImagePlus className="size-6 text-primary" />
                    <span className="text-xs font-medium">Photos</span>
                  </Button>
                  
                  <Button
                    variant="ghost"
                    className="flex h-20 flex-col items-center justify-center gap-2 rounded-xl transition-all duration-fast ease-out hover:-translate-y-0.5 hover:bg-accent hover:shadow-soft"
                    disabled={!features.storage || privateMode}
                    onClick={() => { fileInputRef.current?.click(); setPlusOpen(false); }}
                  >
                    <FileUp className="size-6 text-primary" />
                    <span className="text-xs font-medium">Files</span>
                  </Button>

                  <Button
                    variant="ghost"
                    className={cn(
                      "flex h-20 flex-col items-center justify-center gap-2 rounded-xl transition-all duration-fast ease-out hover:-translate-y-0.5 hover:bg-accent hover:shadow-soft",
                      webSearchEnabled && "bg-primary/5 border border-primary/20"
                    )}
                    disabled={!canWebSearch}
                    onClick={() => onToggleWebSearch?.(!webSearchEnabled)}
                  >
                    <Globe className={cn("size-6", webSearchEnabled ? "text-primary" : "text-muted-foreground")} />
                    <span className="text-xs font-medium">{webSearchEnabled ? "Searching" : "Search"}</span>
                  </Button>

                  <Button
                    variant="ghost"
                    className={cn(
                      "flex h-20 flex-col items-center justify-center gap-2 rounded-xl transition-all duration-fast ease-out hover:-translate-y-0.5 hover:bg-accent hover:shadow-soft",
                      canvasEnabled && "bg-primary/5 border border-primary/20"
                    )}
                    disabled={privateMode}
                    onClick={() => onToggleCanvas(!canvasEnabled)}
                  >
                    <LayoutTemplate className={cn("size-6", canvasEnabled ? "text-primary" : "text-muted-foreground")} />
                    <span className="text-xs font-medium">{canvasEnabled ? "Canvas On" : "Canvas"}</span>
                  </Button>
                </div>
              </PopoverContent>
            </Popover>"""

if idx_start != -1 and idx_end_actual != -1:
    content = content[:idx_start] + replacement_popover + content[idx_end_actual:]
    with open("src/components/chat/composer.tsx", "w") as f:
        f.write(content)
    print("Successfully replaced DropdownMenu with Popover")
else:
    print("Could not find the markers for DropdownMenu")

