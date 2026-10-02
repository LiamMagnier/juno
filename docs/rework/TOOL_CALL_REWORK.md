# Tool calls, script execution and skills — Claude implementation brief

Owner request recorded 2026-10-01. Documentation only; do not start implementation in this brand task. This runtime work is separate from the Alevr identity. The owner wants the practical capabilities of ChatGPT/Claude-style tool use: the model can decide it needs to execute a script or apply a skill, actually do so through the product runtime, inspect the result and continue toward the requested outcome.

## Result the owner expects

Across supported models, a conversation can run Python or another supported script, use an installed skill and work with the resulting files/images/data. Writing a code block or saying a script ran is not execution. The conversation must receive real stdout/stderr, exit status and produced artifacts, and recover or continue using that evidence.

The goal is a consistent tool experience across providers, not a promise that every external model has identical capabilities. Inspect each provider's actual tool interface, publish truthful capabilities to the model and verify the models the product offers. When a selected model cannot call a required tool, explain the limitation or use an explicitly supported adapter/dispatch strategy; do not pretend execution occurred.

## Implementation direction

1. **Audit and reuse existing execution.** Inspect the shared runner/agent-core harness, Chat/work/agent dispatch and native/Packages/JunoCode tool runtime before building anything. Map existing provider adapters, tools, skill resolution, execution hosts and result/artifact delivery. Close gaps rather than creating another disconnected runner.
2. **One coherent tool contract.** Available tool names, descriptions and argument schemas must reach the selected model correctly. Validate arguments, preserve call/result identities, handle parallel calls where supported and return results through each provider's expected tool-result protocol. Normalize provider differences without discarding meaningful errors or cancellation states.
3. **Actual script execution.** Expose Python and the other intentionally supported runtimes (for example JavaScript/Node and shell) through real execution tools. Use the appropriate existing local, remote or hosted execution context, with predictable working directory, input files, runtime/dependency information and generated-file capture. Clearly distinguish contexts instead of implying a hosted script can silently access the user's Mac.
4. **Skills are executable workflows.** Discover installed/available skills, read their instructions and referenced resources, select the relevant workflow, then invoke actual tools/scripts as the skill requires. A skill listing, prompt description or claimed application does not satisfy this requirement. Skills do not silently widen the conversation's existing permissions.
5. **Complete the loop.** Support successive calls: inspect inputs, run, inspect output, repair a failed script when appropriate, produce the requested deliverable and respond. Handle long-running work, incremental output, timeouts, stop/cancel, reconnect and outcome-unknown recovery through the existing durable execution model. Avoid duplicate runs on reconnect/replay.
6. **Deliver useful output.** Images/plots, documents, spreadsheets, audio and other files become actual conversation attachments/artifacts and remain accessible after completion. Keep generated files associated with the originating task. Return relevant output and concise errors to the model; preserve full logs through existing inspectable evidence rather than overwhelming the conversation.
7. **Unify product presentation.** Chat, Orbit, Code and voice should report real tool activity, readable progress, required decisions and finished output consistently, with honest platform/capability differences. Preserve existing approval, isolation and secret-handling contracts. No new user-facing jargon is needed merely because provider protocols differ.

## Required validation before claiming complete

- A supported model reads a supplied CSV, executes Python, computes a result and returns an actual generated chart/file whose content is inspected.
- Another supported provider performs the same workflow through its adapter, including a real failure followed by a corrected run and a truthful final answer.
- A skill requiring referenced instructions/resources and a script is selected, read, executed and produces its expected artifact.
- A supported non-Python script executes in the intended context, with stdout, stderr and exit status recorded.
- Stop, long-running output, reconnect and replay do not claim success early or repeat a consequential operation accidentally.
- Existing permission decisions, unsupported capabilities and missing dependencies produce understandable recoverable states; the model sees enough evidence to respond correctly.
- The relevant real web/native/voice surfaces show the output and task state correctly. Capability coverage is recorded per provider/runtime/surface; an untested model is not marked compatible.

Deliver the architecture/source map, provider capability matrix, implementation and meaningful regression/workflow evidence when the owner later resumes development. This brief itself implements none of those runtime changes.

## Audit and design (2026-10-02)

The audit, source map, provider capability matrix, target design and implementation lanes are in [TOOL_RUNTIME_DESIGN.md](TOOL_RUNTIME_DESIGN.md). It is a design only; no runtime code changed.
