export const CODE_STARTERS = [
  { label: "Explore the codebase", prompt: "Map the codebase and its main entry points. Show me where to start for the area I want to change." },
  { label: "Plan a change", prompt: "Help me plan a change. Ask what outcome I want, then find the relevant files and propose an implementation and test plan." },
  { label: "Review changes", prompt: "Review the current changes for bugs and missing test coverage. Cite the files and lines behind each finding." },
] as const;
