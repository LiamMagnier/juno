/**
 * How long one provider request may take before the client gives up on it.
 *
 * Both vendor SDKs default to ten minutes and retry twice, so a lab that
 * accepts the connection and then answers nothing costs half an hour of
 * silence. That is not a hypothetical: on 2026-08-06 `open.bigmodel.cn`
 * intermittently accepted a streaming `chat/completions` POST and returned zero
 * bytes — `curl --max-time 30` timed out with nothing received on the same key
 * that had answered `429` in 0.6s a minute earlier — and a Work run sat at
 * `running`, no plan, no tokens, for as long as anyone was willing to watch.
 * The run had no way to notice: the loop only checks the budget after a request
 * comes back, and the executor renews its lease while it waits, so neither the
 * runtime ceiling nor the stalled-run sweep could ever fire.
 *
 * Two minutes because that is comfortably past a slow first token on a
 * reasoning model — thinking is streamed, so an adaptive Claude or a GLM in
 * `reasoning_content` is producing events the whole time — and far short of a
 * ceiling a person will sit through. It is a floor on honesty, not a
 * performance target: `runAgentLoop` enforces the same number as a silence
 * deadline of its own, so the wait is bounded even for an adapter that never
 * reaches an SDK.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
