import { CustomizeFrame } from "@/components/customize/customize-nav";
import { MemoryManager } from "@/components/memory/memory-manager";

/*
 * The manager draws the page header itself, because the header's controls
 * (the On/Off switch, the menu of import, export, learning and reset) are
 * memory state, and the header has to be the same element while the page
 * loads and after (see MemoryPageSkeleton).
 */
export default function MemoryPage() {
  return (
    <CustomizeFrame current="memory">
      <MemoryManager />
    </CustomizeFrame>
  );
}
