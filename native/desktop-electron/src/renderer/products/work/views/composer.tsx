/**
 * Writing a task.
 *
 * Two requests, always: `work:create-task` makes a draft (which costs nothing
 * and holds no executor), then `work:dispatch-run` is the only thing that
 * dispatches and the only thing that can refuse. Splitting them is what lets a
 * refusal leave a saved draft behind rather than losing what the user wrote.
 *
 * The composer's real job is to be honest about a rule that has no visible
 * cause: **goal, files, connectors and skill are fixed at dispatch.** Nothing
 * chosen here can be changed for the attempt it starts. The panel says so once,
 * plainly, at the point of commitment — a control that implied otherwise would
 * be a progress bar that completes while the run never sees the file.
 *
 * What this panel deliberately does NOT do is guess where the task will run. The
 * server infers required capabilities from the goal and matches them against
 * what a paired Mac has actually advertised; a second inference here would be a
 * second inference that can disagree with the one that decides. What is shown
 * instead is what the user themselves selected, which is knowable.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import type { WorkCapabilitiesSnapshot, WorkGrantCandidate, WorkSkillRef } from '../contract.js';
import { workInvoke, describeWorkError } from '../lib/bridge.js';
import { formatDuration, formatMicroUsd, formatTokens, joinList } from '../lib/format.js';
import {
  accessModeLabel,
  capabilityPhrase,
  capabilityRequiresLocalHost,
  grantKindLabel,
  hostStateLabel,
  hostStateTone,
  policyPresentation,
  targetLabel,
  targetSummary,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  type WorkAccessMode,
  type WorkPermissionPolicy,
  type WorkTarget,
} from '../lib/vocabulary.js';
import {
  Action,
  Disclosure,
  Eyebrow,
  IconAction,
  Note,
  Panel,
  SectionHeader,
  StatusLabel,
} from '../components/primitives.js';
import { IconAlert, IconClose, IconFile, IconFolder, IconPlus } from '../components/icons.js';

export function TaskComposer({
  capabilities,
  capabilitiesError,
  capabilitiesLoading,
  onCreated,
  onCancel,
}: {
  readonly capabilities: WorkCapabilitiesSnapshot | null;
  readonly capabilitiesError: string | null;
  readonly capabilitiesLoading: boolean;
  readonly onCreated: (sessionId: string) => void;
  readonly onCancel?: () => void;
}): ReactNode {
  const [goal, setGoal] = useState('');
  const [grants, setGrants] = useState<readonly WorkGrantCandidate[]>([]);
  const [connectorIds, setConnectorIds] = useState<readonly string[]>([]);
  const [skillSlug, setSkillSlug] = useState<string | null>(null);
  const [policy, setPolicy] = useState<WorkPermissionPolicy>('balanced');
  const [target, setTarget] = useState<WorkTarget>('automatic');
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hosts = capabilities?.hosts ?? [];
  const reachableHost = hosts.find((host) => host.state === 'online' || host.state === 'idle') ?? null;

  /* A `/slug` at the front of the goal is a skill invocation, but only if it
     matches something in the library — `/tmp is full of junk` is not one. The
     goal is deliberately left un-stripped: it is what the user actually wrote,
     and validating a run against an edited goal would validate it against
     something nobody asked for. */
  const invokedSkill = useMemo(() => {
    const match = /^\/([a-z0-9-]+)\b/i.exec(goal.trim());
    if (match === null) return null;
    const slug = match[1];
    if (slug === undefined) return null;
    return capabilities?.skills.find((skill) => skill.slug === slug) ?? null;
  }, [goal, capabilities]);

  const effectiveSkill = invokedSkill?.slug ?? skillSlug;

  const addGrant = async (kind: 'local_folder' | 'local_file', accessMode: WorkAccessMode): Promise<void> => {
    try {
      const candidate = await workInvoke('work:choose-grant', { kind, accessMode });
      if (candidate === null) return;
      setGrants((current) =>
        current.some((grant) => grant.token === candidate.token) ? current : [...current, candidate],
      );
    } catch (cause: unknown) {
      setError(describeWorkError(cause));
    }
  };

  const submit = async (): Promise<void> => {
    const trimmed = goal.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await workInvoke('work:create-task', {
        goal: trimmed,
        target,
        permissionPolicy: policy,
        model,
        connectorIds: [...connectorIds],
        grantTokens: grants.map((grant) => grant.token),
        skillSlug: effectiveSkill,
      });
      await workInvoke('work:dispatch-run', { sessionId: created.sessionId });
      onCreated(created.sessionId);
    } catch (cause: unknown) {
      setError(describeWorkError(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const localUnavailable =
    reachableHost === null
      ? hosts.length === 0
        ? 'No Mac is paired with this account.'
        : 'No paired Mac is answering right now.'
      : null;

  return (
    <Panel className="p-4" aria-label="New task">
      <SectionHeader
        title="New task"
        description="Describe what you want done, and what “done” looks like."
        trailing={
          onCancel === undefined ? undefined : (
            <IconAction label="Discard this task" onClick={onCancel}>
              <IconClose className="size-4" />
            </IconAction>
          )
        }
      />

      <label className="sr-only" htmlFor="work-goal">
        What you want done
      </label>
      <textarea
        id="work-goal"
        rows={4}
        value={goal}
        onChange={(event) => {
          setGoal(event.target.value);
        }}
        placeholder="Describe the task — what you want done, and what “done” looks like"
        className="w-full resize-y rounded-field border border-input bg-background px-3 py-2 text-body text-foreground placeholder:text-muted-foreground"
      />

      {invokedSkill === null ? null : (
        <Note tone="quiet" className="mt-2">
          Starts with <span className="font-mono">/{invokedSkill.slug}</span>, so {invokedSkill.name}{' '}
          will be applied. A skill can never widen what this task may reach — what it asks for is
          intersected with what the task already had.
        </Note>
      )}

      {capabilitiesError === null ? null : (
        <Note tone="danger" icon={<IconAlert className="size-3.5" />} className="mt-2">
          {capabilitiesError} The lists below are empty because the request failed, not because you
          have nothing.
        </Note>
      )}

      {/* ------------------------------------------------------------------ */}
      <Field label="Files and folders" hint="Nothing on your Mac is reachable unless you add it here.">
        {grants.length === 0 ? (
          <p className="text-caption text-muted-foreground">Nothing added.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {grants.map((grant) => (
              <li key={grant.token} className="flex items-center gap-2">
                {grant.kind === 'local_folder' ? (
                  <IconFolder className="size-4 text-muted-foreground" />
                ) : (
                  <IconFile className="size-4 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-caption text-foreground">
                  {grant.label}
                </span>
                <span className="font-mono text-label uppercase text-muted-foreground">
                  {grantKindLabel(grant.kind)} · {accessModeLabel(grant.accessMode)}
                </span>
                <IconAction
                  label={`Remove ${grant.label}`}
                  onClick={() => {
                    setGrants((current) => current.filter((entry) => entry.token !== grant.token));
                  }}
                >
                  <IconClose className="size-3.5" />
                </IconAction>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Action
            size="sm"
            icon={<IconPlus className="size-3.5" />}
            onClick={() => {
              void addGrant('local_folder', 'read_write_no_delete');
            }}
          >
            Add a folder
          </Action>
          <Action
            size="sm"
            icon={<IconPlus className="size-3.5" />}
            onClick={() => {
              void addGrant('local_file', 'read');
            }}
          >
            Add a file, read-only
          </Action>
        </div>
      </Field>

      {/* ------------------------------------------------------------------ */}
      <Field
        label="Apps this task may reach"
        hint="Off means this task cannot reach it. Your connections themselves are unchanged."
      >
        {capabilitiesLoading ? (
          <p className="text-caption text-muted-foreground">Reading your connected apps…</p>
        ) : capabilities === null || capabilities.connectors.length === 0 ? (
          <p className="text-caption text-muted-foreground">No connected apps on this account.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {capabilities.connectors.map((connector) => {
              const checked = connectorIds.includes(connector.id);
              return (
                <li key={connector.id}>
                  <label className="flex items-center gap-2 text-caption text-foreground">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!connector.healthy}
                      onChange={(event) => {
                        setConnectorIds((current) =>
                          event.target.checked
                            ? [...current, connector.id]
                            : current.filter((id) => id !== connector.id),
                        );
                      }}
                      className="size-3.5 accent-primary"
                    />
                    <span className={connector.healthy ? undefined : 'text-muted-foreground line-through'}>
                      {connector.name}
                    </span>
                    {connector.healthy ? null : (
                      <span className="text-caption text-warning">
                        {connector.unhealthyReason ?? 'Not usable right now'}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Field>

      {/* ------------------------------------------------------------------ */}
      <Field label="Skill" hint="Or write /slug at the front of the task.">
        <select
          value={effectiveSkill ?? ''}
          disabled={invokedSkill !== null}
          onChange={(event) => {
            setSkillSlug(event.target.value === '' ? null : event.target.value);
          }}
          aria-label="Skill to apply"
          className="h-8 rounded-control border border-input bg-background px-2 text-caption text-foreground disabled:opacity-45"
        >
          <option value="">None</option>
          {(capabilities?.skills ?? []).map((skill) => (
            <option key={skill.slug} value={skill.slug}>
              {skill.name} (v{skill.version})
            </option>
          ))}
        </select>
        <SkillReach
          skill={(capabilities?.skills ?? []).find((entry) => entry.slug === effectiveSkill) ?? null}
          target={target}
        />
      </Field>

      {/* ------------------------------------------------------------------ */}
      <Field label="How often it asks">
        <div role="radiogroup" aria-label="How often this task asks" className="flex flex-col gap-1.5">
          {WORK_PERMISSION_POLICIES.map((candidate) => {
            const presentation = policyPresentation(candidate);
            return (
              <label key={candidate} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="work-policy"
                  value={candidate}
                  checked={policy === candidate}
                  onChange={() => {
                    setPolicy(candidate);
                  }}
                  className="mt-1 size-3.5 accent-primary"
                />
                <span className="min-w-0">
                  <span className="text-caption text-foreground">{presentation.label}</span>
                  <span className="block text-caption text-muted-foreground">
                    {presentation.summary}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <Note tone="quiet" className="mt-2">
          {policyPresentation(policy).floor}
        </Note>
      </Field>

      {/* ------------------------------------------------------------------ */}
      <Field label="Where it runs">
        <div role="radiogroup" aria-label="Where this task runs" className="flex flex-col gap-1.5">
          {WORK_TARGETS.map((candidate) => {
            const unavailable = candidate === 'local' ? localUnavailable : null;
            return (
              <label key={candidate} className="flex items-start gap-2">
                <input
                  type="radio"
                  name="work-target"
                  value={candidate}
                  checked={target === candidate}
                  disabled={unavailable !== null}
                  onChange={() => {
                    setTarget(candidate);
                  }}
                  className="mt-1 size-3.5 accent-primary"
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'text-caption',
                      unavailable === null ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {targetLabel(candidate)}
                  </span>
                  <span className="block text-caption text-muted-foreground">
                    {unavailable ?? targetSummary(candidate)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {hosts.length === 0 ? null : (
          <ul className="mt-2 flex flex-col gap-0.5">
            {hosts.map((host) => (
              <li key={host.id} className="flex items-center gap-2">
                <StatusLabel tone={hostStateTone(host.state)} label={hostStateLabel(host.state)} />
                <span className="text-caption text-muted-foreground">{host.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Field>

      {/* ------------------------------------------------------------------ */}
      {capabilities === null || capabilities.models.length === 0 ? null : (
        <Field label="Model">
          <select
            value={model ?? ''}
            onChange={(event) => {
              setModel(event.target.value === '' ? null : event.target.value);
            }}
            aria-label="Model to run on"
            className="h-8 rounded-control border border-input bg-background px-2 text-caption text-foreground"
          >
            <option value="">Let Juno choose</option>
            {capabilities.models.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {entry.label}
                {entry.available ? '' : ' — unavailable'}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* ------------------------------------------------------------------ */}
      <Reach grants={grants} connectorNames={selectedConnectorNames(capabilities, connectorIds)} />

      {capabilities === null ? null : (
        <Disclosure summary="What this run commits to" className="mt-3">
          <p className="max-w-prose text-caption text-muted-foreground">
            It stops at {formatMicroUsd(capabilities.defaultBudget.maxCostMicroUsd)},{' '}
            {formatTokens(capabilities.defaultBudget.maxTokens)} tokens, or{' '}
            {formatDuration(capabilities.defaultBudget.maxRuntimeMs)} of working time — whichever
            comes first. If one is reached the task stops and tells you where it got to. Waiting for
            you does not count against the clock.
          </p>
        </Disclosure>
      )}

      <Note tone="notice" className="mt-3">
        The task, its files, its apps and its skill are fixed when it starts. Changing any of them
        afterwards applies to the next attempt, not the one running.
      </Note>

      {error === null ? null : (
        <Note tone="danger" icon={<IconAlert className="size-3.5" />} className="mt-2">
          {error}
        </Note>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Action
          variant="primary"
          busy={submitting}
          disabledReason={goal.trim().length === 0 ? 'Describe the task first.' : null}
          onClick={() => {
            void submit();
          }}
        >
          Start this task
        </Action>
        {onCancel === undefined ? null : (
          <Action variant="quiet" onClick={onCancel}>
            Discard
          </Action>
        )}
      </div>
    </Panel>
  );
}

/**
 * What a chosen skill asks for, and whether that is compatible with where the
 * task is headed.
 *
 * A skill can never *widen* a run — `resolveSkillPermissions` intersects what it
 * asks for with what the run already had, so a shared or pasted skill can never
 * add a tool. What it can do is ask for something the chosen target cannot
 * provide, and a cloud run silently dropping the half of a skill that needed the
 * Mac is exactly the kind of quiet degradation this panel exists to pre-empt.
 */
function SkillReach({
  skill,
  target,
}: {
  readonly skill: WorkSkillRef | null;
  readonly target: WorkTarget;
}): ReactNode {
  if (skill === null || skill.capabilities.length === 0) return null;
  const needsLocal = skill.capabilities.filter(capabilityRequiresLocalHost);
  const phrases = skill.capabilities.map(capabilityPhrase);

  return (
    <div className="mt-2">
      <p className="text-caption text-muted-foreground">
        {skill.name} uses {joinList(phrases)}. It can only ever narrow what this task may reach,
        never widen it.
      </p>
      {needsLocal.length > 0 && target === 'cloud' ? (
        <Note tone="notice" className="mt-1">
          {joinList(needsLocal.map(capabilityPhrase))} needs your Mac, and this is set to run in the
          cloud. That part would be skipped.
        </Note>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <Eyebrow>{label}</Eyebrow>
      {hint === undefined ? null : (
        <p className="mb-1.5 mt-0.5 text-caption text-muted-foreground">{hint}</p>
      )}
      <div className={hint === undefined ? 'mt-1.5' : undefined}>{children}</div>
    </div>
  );
}

function selectedConnectorNames(
  capabilities: WorkCapabilitiesSnapshot | null,
  connectorIds: readonly string[],
): readonly string[] {
  if (capabilities === null) return [];
  return capabilities.connectors
    .filter((connector) => connectorIds.includes(connector.id))
    .map((connector) => connector.name);
}

/**
 * What this task will be able to reach, built only from what the user chose.
 *
 * Not an inference. The server decides required capabilities from the goal and
 * this window has no business second-guessing it — but "you granted two folders
 * and one app" is a fact, and it is the fact somebody wants restated before they
 * commit.
 */
function Reach({
  grants,
  connectorNames,
}: {
  readonly grants: readonly WorkGrantCandidate[];
  readonly connectorNames: readonly string[];
}): ReactNode {
  const parts: string[] = [];
  if (grants.length > 0) {
    parts.push(grants.length === 1 ? '1 file or folder you added' : `${grants.length} files or folders you added`);
  }
  if (connectorNames.length > 0) parts.push(joinList(connectorNames));

  return (
    <div className="mt-4 border-t border-border pt-3">
      <Eyebrow>Reaches</Eyebrow>
      <p className="mt-1 max-w-prose text-caption text-muted-foreground">
        {parts.length === 0
          ? 'Nothing on your Mac and no connected app. It works from what you write above, plus web research.'
          : `${joinList(parts)}. Everything else you have connected stays out of reach.`}
      </p>
    </div>
  );
}
