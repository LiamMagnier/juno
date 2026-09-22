/**
 * Media, people and conversation.
 *
 * The speech bubble is the product's most-drawn mark — it is Chat in the
 * switcher and every row in the history list — so it is drawn once here and
 * varied by what sits inside it, never by redrawing the bubble.
 */
import { createIcon as icon, p, c, rect, dot } from "./create-icon";

/* — Pictures ———————————————————————————————————————————————————————— */

const FRAME = rect(3.4, 4.4, 17.2, 15.2, 3.2);

export const Image = icon("image", [
  FRAME,
  c(9, 9.4, 1.9, "accent"),
  p("M4.2 17.4 9 12.6a2.2 2.2 0 0 1 3.1 0l5.4 5.4"),
]);
export const ImageIcon = Image;
export const ImagePlus = icon("image-plus", [
  p("M20.6 11.4v5.6a2.6 2.6 0 0 1-2.6 2.6H6a2.6 2.6 0 0 1-2.6-2.6V7a2.6 2.6 0 0 1 2.6-2.6h5.6"),
  c(9, 9.4, 1.8),
  p("M4.2 17.4 9 12.6a2.2 2.2 0 0 1 3.1 0l5.4 5.4"),
  p("M17.6 3.4v5.2"),
  p("M15 6h5.2"),
]);
export const ImageOff = icon("image-off", [
  p("M8.4 4.4H18A2.6 2.6 0 0 1 20.6 7v9.6"),
  p("M19 19.4a2.6 2.6 0 0 1-1 .2H6a2.6 2.6 0 0 1-2.6-2.6V7a2.6 2.6 0 0 1 1.6-2.4"),
  p("M4.2 17.4 9 12.6a2.2 2.2 0 0 1 3.1 0l1 1"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Camera = icon("camera", [
  p("M8.6 6.4 9.9 4.3a1.4 1.4 0 0 1 1.2-.7h1.8a1.4 1.4 0 0 1 1.2.7l1.3 2.1H18a2.6 2.6 0 0 1 2.6 2.6v8a2.6 2.6 0 0 1-2.6 2.6H6A2.6 2.6 0 0 1 3.4 17V9A2.6 2.6 0 0 1 6 6.4z"),
  c(12, 12.8, 3.4),
]);
export const Film = icon("film", [
  rect(3.4, 4.4, 17.2, 15.2, 3.2),
  p("M8 4.4v15.2"),
  p("M16 4.4v15.2"),
  p("M3.4 12h17.2"),
]);
export const Video = icon("video", [
  rect(3, 6, 12.6, 12, 3),
  p("M15.6 13.2 20 16a.8.8 0 0 0 1.2-.7V8.7A.8.8 0 0 0 20 8l-4.4 2.8z"),
]);
export const Music2 = icon("music-2", [c(7.6, 17.4, 3), p("M10.6 17.4V5.4l8.6-1.8v11.8"), c(16.2, 15.4, 3)]);
export const AudioLines = icon("audio-lines", [
  p("M3.6 11v2"),
  p("M7.4 7.6v8.8"),
  p("M11.2 4.6v14.8"),
  p("M15 8.6v6.8"),
  p("M18.8 10.4v3.2"),
]);
export const Mic = icon("mic", [
  rect(9.2, 3, 5.6, 11.4, 2.8, "pulse"),
  p("M5.6 11.2v1a6.4 6.4 0 0 0 12.8 0v-1"),
  p("M12 18.6v2.4"),
]);
export const MicOff = icon("mic-off", [
  p("M14.8 6.2V5.8a2.8 2.8 0 0 0-5.6 0v5.4"),
  p("M14.8 11.4v.2a2.8 2.8 0 0 1-4.4 2.3"),
  p("M5.6 11.2v1a6.4 6.4 0 0 0 10.5 4.9"),
  p("M18.4 12.2v-1"),
  p("M12 18.6v2.4"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Volume2 = icon("volume-2", [
  p("M11.4 4.6 6.6 8.6H3.8a.8.8 0 0 0-.8.8v5.2a.8.8 0 0 0 .8.8h2.8l4.8 4a.6.6 0 0 0 1-.46V5.06a.6.6 0 0 0-1-.46"),
  p("M15.8 9.4a3.6 3.6 0 0 1 0 5.2"),
  p("M18.6 6.6a7.6 7.6 0 0 1 0 10.8"),
]);
export const PhoneOff = icon("phone-off", [
  p("M10.6 5.6 9.4 8.4l2.2 2.2"),
  p("M13 13 15.6 14.4l2.8-1.2a1.6 1.6 0 0 1 2.2 1.5v2.4a2 2 0 0 1-2.2 2 16.4 16.4 0 0 1-9.8-4.6"),
  p("M8.6 14.5a16.4 16.4 0 0 1-4.6-9.7 2 2 0 0 1 2-2.2h2.4a1.6 1.6 0 0 1 1.5 1.3"),
  p("M4.4 4.4 19.6 19.6"),
]);

/* — Conversation ———————————————————————————————————————————————————— */

export const MessageCircle = icon("message-circle", [
  p("M20.6 11.6a8.2 8.2 0 0 1-11.9 7.34l-4.86 1.42 1.42-4.86A8.2 8.2 0 1 1 20.6 11.6"),
]);
export const MessageCircleQuestion = icon("message-circle-question", [
  p("M20.6 11.6a8.2 8.2 0 0 1-11.9 7.34l-4.86 1.42 1.42-4.86A8.2 8.2 0 1 1 20.6 11.6"),
  p("M9.9 9.4a2.2 2.2 0 0 1 4.28.73c0 1.47-2.2 2.2-2.2 2.2"),
  dot(12, 15.2, 1.05),
]);
const BUBBLE = rect(3.4, 4.2, 17.2, 12.4, 3.2);
const TAIL = p("M8.4 16.6 6.5 20.4l4.9-3.8");
export const MessageSquare = icon("message-square", [BUBBLE, TAIL]);
export const MessageSquareText = icon("message-square-text", [
  BUBBLE,
  TAIL,
  p("M7.8 8.8h8.4"),
  p("M7.8 12.4h5.4"),
]);
export const MessageSquarePlus = icon("message-square-plus", [
  BUBBLE,
  TAIL,
  p("M12 7.4v6"),
  p("M9 10.4h6"),
]);
export const MessagesSquare = icon("messages-square", [
  p("M8 15.4H5.8a2.4 2.4 0 0 1-2.4-2.4V6.2a2.4 2.4 0 0 1 2.4-2.4h8.4a2.4 2.4 0 0 1 2.4 2.4v.8"),
  p("M9.6 8.6h8.6a2.4 2.4 0 0 1 2.4 2.4v5.4a2.4 2.4 0 0 1-2.4 2.4h-5.4l-3.8 2.6V18.8a2.4 2.4 0 0 1-1.8-2.32V11a2.4 2.4 0 0 1 2.4-2.4"),
]);
export const Mail = icon("mail", [
  rect(2.8, 5, 18.4, 14, 3),
  p("M3.6 7.6 10.6 12.9a2.4 2.4 0 0 0 2.8 0l7-5.3"),
]);
export const MailWarning = icon("mail-warning", [
  p("M21.2 10.4V8a3 3 0 0 0-3-3H5.8a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h8.4"),
  p("M3.6 7.6 10.6 12.9a2.4 2.4 0 0 0 2.8 0l3-2.3"),
  p("M19 13.6v2.8"),
  dot(19, 19.2, 1.05),
]);
export const Megaphone = icon("megaphone", [
  p("M4.4 10.2v3.6a2 2 0 0 0 2 2h2l8.6 4.2a.8.8 0 0 0 1.16-.72V4.72A.8.8 0 0 0 17 4L8.4 8.2h-2a2 2 0 0 0-2 2"),
  p("M8.4 8.2v7.6"),
  p("M20.4 10v4"),
]);

/* — People —————————————————————————————————————————————————————————— */

export const User = icon("user", [c(12, 8.2, 3.8), p("M4.8 20.2a7.4 7.4 0 0 1 14.4 0")]);
export const Users = icon("users", [
  c(9.6, 8, 3.6),
  p("M3.2 20a6.8 6.8 0 0 1 12.8 0"),
  p("M16.2 4.8a3.6 3.6 0 0 1 0 6.9"),
  p("M17.6 14.4a6.8 6.8 0 0 1 3.2 4"),
]);
export const UserPen = icon("user-pen", [
  c(10.4, 8, 3.7),
  p("M3.6 20a6.9 6.9 0 0 1 9.9-6.2"),
  p("M18.4 12.6a1.9 1.9 0 0 1 2.7 2.7l-4.5 4.5-2.9.5.5-2.9z"),
]);
export const Bot = icon("bot", [
  rect(3.6, 8, 16.8, 11.6, 3.6),
  p("M12 4.2V8"),
  dot(12, 3.2, 1.3, "accent"),
  dot(8.6, 13.4, 1.25),
  dot(15.4, 13.4, 1.25),
]);
export const LogOut = icon("log-out", [
  p("M10.4 4.4H6.8a2.4 2.4 0 0 0-2.4 2.4v10.4a2.4 2.4 0 0 0 2.4 2.4h3.6"),
  p("M15.6 7.6 20 12l-4.4 4.4", "arrow-right"),
  p("M20 12H9.6"),
]);
export const Moon = icon("moon", [p("M20.2 13.6A8.6 8.6 0 0 1 10.4 3.8a8.6 8.6 0 1 0 9.8 9.8")]);
export const Sun = icon("sun", [
  c(12, 12, 4.2),
  p("M12 2.8v2", "rotor"),
  p("M12 19.2v2", "rotor"),
  p("M4.4 4.4 5.8 5.8", "rotor"),
  p("M18.2 18.2l1.4 1.4", "rotor"),
  p("M2.8 12h2", "rotor"),
  p("M19.2 12h2", "rotor"),
  p("M4.4 19.6 5.8 18.2", "rotor"),
  p("M18.2 5.8l1.4-1.4", "rotor"),
]);
export const Paperclip = icon("paperclip", [
  p("M20.1 10.9 12 19a5.1 5.1 0 0 1-7.2-7.2l8.1-8.1a3.4 3.4 0 0 1 4.8 4.8l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"),
]);
export const Link2 = icon("link-2", [
  p("M9.4 17.4H7.6a5.4 5.4 0 0 1 0-10.8h1.8"),
  p("M14.6 6.6h1.8a5.4 5.4 0 0 1 0 10.8h-1.8"),
  p("M8.2 12h7.6"),
]);
export const Link2Off = icon("link-2-off", [
  p("M9.4 17.4H7.6a5.4 5.4 0 0 1-3.5-9.5"),
  p("M14.6 6.6h1.8a5.4 5.4 0 0 1 3.9 9.1"),
  p("M8.2 12h3"),
  p("M4.4 4.4 19.6 19.6"),
]);
export const Share2 = icon("share-2", [
  c(17.6, 5.8, 2.8),
  c(6.4, 12, 2.8),
  c(17.6, 18.2, 2.8),
  p("M8.8 10.6 15.2 7.2"),
  p("M8.8 13.4 15.2 16.8"),
]);
