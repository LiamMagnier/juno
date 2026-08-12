/**
 * The Chat service's public surface.
 *
 * `index.ts` in main wires exactly one thing — `new ChatService({transport,
 * tokens, emit})` — and then routes each `chat:*` invoke channel to the method
 * of the same name. Everything else in this directory is an implementation
 * detail and is exported only for the unit tests, which exercise the SSE parser
 * and the pure mappings directly rather than through a live socket.
 */

export { ChatService, pickDefaultModel } from './service.js';
export type { ChatEventSink, ChatServiceOptions } from './service.js';
export { ChatServiceError, SignedOutError, TurnInFlightError, describeFailure } from './errors.js';
export { AnonymousSseReader } from './sse.js';
export type { SseParseResult } from './sse.js';
export { parseWireChunk, toConversation, toMessage, toModelDescriptor, previewOf } from './wire.js';
export type { WireChunk } from './wire.js';
export {
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  decodeDroppedFile,
  safeFileName,
  type AttachmentPicker,
} from './attachments.js';
