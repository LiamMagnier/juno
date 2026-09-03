export {};

declare global {
  interface Window {
    /**
     * Set by ChatView when it rewrites the URL with history.replaceState
     * (a brand-new chat becoming /chat/<id>) while the /chat page stays
     * mounted. AppProvider must not router.refresh() in that state: the
     * refresh resolves the rewritten URL to the [id] page file and remounts
     * the chat mid-conversation.
     */
    __junoSoftRoutePath?: string | null;
    /** True while the first-run onboarding overlay owns the screen. Other
     *  first-run overlays (announcement popup) stand down while it is set. */
    __junoOnboardingActive?: boolean;
  }
}
