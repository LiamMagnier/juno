/*
 * Every phrase the right-column shell and the Activity panel show (SPEC §10.1).
 *
 * One object, named `…_COPY`, so the i18n extractor harvests every literal in
 * it with no extractor change, and the exact-match catalog translates each
 * phrase whole. The rules the entries follow:
 *
 *  - A phrase is a complete unit. Anything variable — a query, a host, a
 *    count, a duration — rides beside it as its own argument node
 *    (`PhraseSpec`), never spliced into it, and at most one bare phrase goes
 *    into one spec (the one-phrase rule, §7.6).
 *  - Plurals are whole phrases: a count node picks `one` or `other` with
 *    `Intl.PluralRules`. There is no `n === 1 ?` anywhere in the panel.
 *  - Nothing else goes in here — no storage keys, no ids — because the
 *    extractor would harvest them as copy.
 *
 * Apostrophes are typographic (’), as in the rest of the product's copy, so a
 * phrase this panel shares with another surface (the memory toasts) is one
 * catalog entry, not two.
 */

export const PANEL_COPY = {
  shell: {
    closePanel: "Close panel",
    backToChat: "Back to chat",
    moreActions: "More actions",
    resizePanel: "Resize panel",
    resizeHint: "Drag to resize. Arrow keys adjust, Home resets.",
  },

  /** The Activity panel's stable name: the aside's accessible name and its h2. */
  activity: "Activity",

  tabs: {
    timeline: "Timeline",
    sources: "Sources",
    details: "Details",
  },

  /** The static phase word in the header while the run works (never shimmers). Status
   *  words, not the tool rows' verb prefixes ("Searching", "Reading" + an argument): one
   *  English string has one translation, so a status gets its own source text (§7.6). */
  phase: {
    thinking: "Thinking",
    searching: "Searching…",
    reading: "Reading…",
    tool: "Using a tool",
    waiting: "Waiting for your approval",
    writing: "Writing",
  },

  /** The header at rest: a lead phrase followed by a duration node. */
  lead: {
    thoughtFor: "Thought for",
    answeredIn: "Answered in",
    researchedFor: "Researched for",
    stoppedAfter: "Stopped after",
    couldntFinish: "Couldn’t finish",
  },

  timeline: {
    empty: "No steps yet",
    emptyDetail: "Steps appear here as Juno works.",
    commentary: "Said while working",
  },

  call: {
    arguments: "Arguments",
    result: "Result",
    output: "Output",
    error: "What went wrong",
    approval: "Approval",
    showAll: "Show all",
    showLess: "Show less",
    shortened: "Shortened",
    shown: "Shown",
    fullLength: "Full length",
    pages: "Pages",
    timeLimit: "Time limit",
    cached: "Reused from earlier in this turn",
    injection: "Contained instructions aimed at the assistant; they were ignored",
    noResults: "No results",
    askToRunAgain: "Ask to run again",
    /** Seeded into the composer before the tool's title (a label node). */
    tryAgain: "Try again:",
    opensInNewTab: "Opens in a new tab",
  },

  approval: {
    group: "Approve this call",
    allowOnce: "Allow once",
    alwaysAllow: "Always allow",
    decline: "Decline",
    waiting: "Waiting for your approval",
    sending: "Sending your answer",
    allowedOnce: "Allowed once",
    alwaysAllowed: "Always allowed",
    declined: "You declined this",
    expired: "Approval expired",
    blocked: "Blocked by your settings",
    cancelled: "Cancelled",
    refused: "Couldn’t record your answer",
    unreachable: "Couldn’t reach the server. Try again.",
    alreadyAnswered: "This was already answered",
    onceOnly: "Only Allow once is possible for this action",
    signedOut: "You’re signed out. Sign in, then answer again.",
    /** The disclosure that shows the exact detail the answer is bound to (its digest). */
    review: "Review what will be sent",
    reviewTask: "Review the brief",
    noArguments: "This call sends no arguments.",
    /** A task handoff's estimate, followed by the server's own figure. */
    estimatedCost: "Estimated cost",
    /*
     * The next seven are the transcript card's own sentences (approval-card.tsx),
     * word for word, so the two surfaces share one catalog entry each and never
     * describe the same request differently.
     */
    untrusted:
      "The model wrote these arguments from content it read: a web page, a file, or output from another connector. That content can contain text written to steer what gets sent. Check the values below are what you meant before you allow it.",
    untrustedTask:
      "This chat includes content Juno read from outside it, such as a web page, a file or a connected app. Check that the brief below is what you asked for before you start it.",
    risk: {
      read_only: "Reads only",
      reversible_write: "Reversible change",
      external_write: "Leaves Juno",
      destructive_or_sensitive: "Cannot be undone",
      unknown: "Unverified",
    },
    riskDetail: {
      read_only: "This reads. Nothing outside Juno changes.",
      reversible_write: "This changes something that can be put back, like a label, a folder or a draft.",
      external_write: "This sends something to another service. Once it lands there, Juno cannot take it back.",
      destructive_or_sensitive:
        "This deletes, pays for, or touches something private. Nothing here can undo it afterwards.",
      unknown:
        "Juno could not verify that this only reads, so it is treated as a change that leaves Juno. Read the arguments below before you answer.",
    },
  },

  sources: {
    cited: "Cited",
    alsoRead: "Also read",
    found: "Found",
    empty: "No sources",
    emptyDetail: "Pages the answer used appear here.",
    citedAs: "Cited as",
  },

  details: {
    model: "Model",
    effort: "Effort",
    context: "Context",
    tools: "Tools",
    connectors: "Connectors",
    memory: "Memory used",
    contextUsed: "Context used",
    window: "Window",
    toolsAvailable: "Tools available",
    nativeSearch: "Search built into the model",
    stepBudget: "Up to",
    connected: "Connected",
    couldntConnect: "Couldn’t connect",
    chosenAutomatically: "Chosen automatically",
    routed: "Picked by Auto",
    forget: "Forget",
    openSourceChat: "Open source chat",
    manageAll: "Manage all",
    forgotten: "Forgotten. Juno won’t learn this again.",
    forgetFailed: "Couldn’t forget that. Nothing was changed.",
    undo: "Undo",
    /** The effort rungs, spelled as the model selector spells them. */
    rung: {
      instant: "Instant",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Max",
    },
  },

  /** Whole-phrase plurals for count nodes. */
  units: {
    token: { one: "token", other: "tokens" },
    character: { one: "character", other: "characters" },
    earlierMessage: { one: "earlier message", other: "earlier messages" },
    attachment: { one: "attachment", other: "attachments" },
    projectFile: { one: "project file", other: "project files" },
    step: { one: "step", other: "steps" },
    tool: { one: "tool", other: "tools" },
  },

  /** What each tool is, for the Details tab's "Tools available" list. */
  toolNames: {
    web_search: "Search the web",
    web_fetch: "Read web pages",
    read_document: "Read attached documents",
    inspect_image: "Look closely at images",
    run_code: "Run code",
    search_chats: "Search your chats",
    current_time: "Check the time",
    calculate: "Do exact arithmetic",
    start_task: "Hand work to a task",
    suggest_research: "Suggest Research",
    provider_web_search: "The model’s own web search",
    provider_x_search: "Search X",
    mcp: "Connector tools",
  },

  /** Typed notices (SPEC §7.6). The typed UI never shows a notice's legacy English title. */
  notices: {
    model_changed: "Switched model to",
    skill_not_applied: "A skill couldn’t be applied",
    connector_unavailable: "couldn’t connect",
    usage_limit: "You’ve reached your usage limit",
    stall: "The model stopped responding",
    finish_length: "The answer hit its length limit",
    finish_sensitive: "The provider stopped this answer",
    tool_budget: "Stopped using tools after",
    tool_budget_searches: "Reached this turn’s search limit",
    web_off_lockdown: "Web access is off in Lockdown",
    provenance_refused: "Didn’t open a link that wasn’t in this conversation",
    hostile_content: "A page tried to give the assistant instructions",
    search_degraded: "Search was limited",
    research_skipped: "Research was skipped",
    private_tools_limited: "Connectors aren’t available in private chats",
    tools_capped: "Some tools weren’t offered",
  },

  connectorFailure: {
    auth_expired: "Sign in again in Settings",
    unreachable: "Couldn’t be reached",
    misconfigured: "Isn’t set up correctly",
    timeout: "Took too long to connect",
    not_linked: "Isn’t linked",
  },

  /** Why a Research request was refused (SPEC §9.9), shown after "Research was skipped". */
  researchRefusal: {
    not_configured: "Research isn’t set up on this server.",
    plan: "Research is available on paid plans.",
    workspace: "This project doesn’t allow Research.",
    private: "Research isn’t available in private chats.",
    lockdown: "Research is off (Lockdown).",
    live_runs: "Too many research runs are going. Wait for one to finish.",
    daily_starts: "You’ve reached today’s research limit.",
    budget: "Research needs more of your monthly allowance than is left.",
    resetsOn: "Resets on",
  },
} as const;

function collect(value: unknown, into: Set<string>) {
  if (typeof value === "string") into.add(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collect(child, into);
}

/**
 * Every phrase above, de-duplicated, for `prefetchPhrases` (SPEC §10.2): a
 * non-English reader's panel is warmed on idle, so it never opens in English.
 */
export const ALL_PANEL_PHRASES: readonly string[] = (() => {
  const phrases = new Set<string>();
  collect(PANEL_COPY, phrases);
  return [...phrases];
})();
