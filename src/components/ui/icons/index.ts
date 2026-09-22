/**
 * The Juno mark set — one import for every glyph in the product.
 *
 * `import { Plus, Folder } from "@/components/ui/icons"`. Nothing imports
 * `lucide-react` any more: see `create-icon.tsx` for why the set was redrawn
 * and what rules it is drawn to, and `globals.css` (search `juno-icon`) for the
 * hover choreography the `data-part` names drive.
 */
export { createIcon, type IconProps, type IconComponent, type IconNode, type Icon } from "./create-icon";
export * from "./glyphs-core";
export * from "./glyphs-documents";
export * from "./glyphs-media";
export * from "./glyphs-system";
export * from "./glyphs-status";
