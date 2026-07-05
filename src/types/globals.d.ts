export {};

declare global {
  interface Window {
    /** True while the first-run onboarding overlay owns the screen. Other
     *  first-run overlays (announcement popup) stand down while it is set. */
    __junoOnboardingActive?: boolean;
  }
}
