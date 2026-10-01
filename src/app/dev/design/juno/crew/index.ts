/**
 * The crew character system (D-032): everything the screens mount.
 *
 *   CrewFace          a member as a character, any size (≤ 28 px: cached sprites)
 *   CrewPeek          the character over its own thread, name and state in words
 *   CrewHeader        the compact thread header
 *   CrewRoster        the roster grid, with "Add to crew"
 *   AvatarEditor      "Customize Mira"
 *   CrewCreate        the "Add to crew" flow
 *   SetupSheet        the member's precise setup
 *   SetupChangeCard   a setup change proposed in the thread (before, after, Apply)
 *   MessageReaction   the member reacting to a message
 *   getCrewTheme      the member's thread colours (bubbles, send disc, ring, accent text)
 */

export { CrewFace, CREW_STATE_LABEL, avatarOf, useAvatar, loadEngine, type CrewFaceProps, type CrewMember, type CrewState, type Facing, type LiveHandle } from "./face";
export { CrewPeek, type CrewPeekProps } from "./peek";
export { CrewHeader, CrewRoster, type CrewHeaderProps, type CrewRosterProps, type RosterMember } from "./roster";
export { AvatarEditor, type AvatarEditorProps, type EditorTab } from "./editor";
export { CrewCreate, type CrewCreateProps, type CreateStep, type NewMember } from "./create";
export { SetupChangeCard, SetupSheet, type SetupChange, type SetupChangeCardProps, type SetupData, type SetupSheetProps } from "./setup";
export { MessageReaction, type MessageReactionProps } from "./reaction";
export { getCrewTheme, themeForColor, themeContrast, type CrewTheme, type ThreadTheme } from "./theme";
export { SHORT_WORDS, stateSentence } from "./words";
export { CREW, CREW_BY_ID, STATE_ORDER, stateLine, type CrewFixture } from "./fixtures";
export {
  AVATAR_VERSION,
  avatarFromSeed,
  normalizeAvatar,
  surpriseAvatar,
  describeAvatar,
  avatarKey,
  type AvatarConfig,
  type BodyShape,
  type MaterialKind,
  type EyeStyle,
  type AccessoryId,
} from "./avatar2";
