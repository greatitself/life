import { useEffect, useRef } from 'react'
import * as Select from '@radix-ui/react-select'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  GitBranch,
  GitPullRequest,
  LockKeyhole,
  PenLine,
  Zap,
} from 'lucide-react'
import type { ConnectionState, ModelOption, PermissionMode, Provider } from '../../shared/types'
import type { Thread } from '../state'
import { fallbackModelCatalog } from '../model-catalog'
import { ProviderIcon } from './Icons'
import './reference-composer.css'

const effortName = (value: string) =>
  value === 'xhigh'
    ? 'Extra high'
    : value.replace(
        /(^|[_-])([a-z])/g,
        (_, separator, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`,
      )
const permissionChoices: {
  id: PermissionMode
  name: string
  description: string
  icon: typeof LockKeyhole
}[] = [
  {
    id: 'review',
    name: 'Supervised',
    description: 'Review commands and file changes that need approval.',
    icon: LockKeyhole,
  },
  {
    id: 'edit',
    name: 'Auto-accept edits',
    description: 'Auto-approve workspace edits; ask for other actions.',
    icon: PenLine,
  },
  {
    id: 'plan',
    name: 'Plan only',
    description: 'Explore and plan without changing files.',
    icon: ClipboardList,
  },
]
type RunPatch = {
  model?: string
  reasoningEffort?: string
  serviceTier?: string
  mode?: PermissionMode
}

export function ReferenceComposerControls({
  models,
  provider,
  model,
  reasoningEffort,
  serviceTier,
  mode,
  modeDisabled,
  providerDisabled,
  onChange,
  onProviderChange,
}: {
  models: ModelOption[]
  provider: Provider
  model: string
  reasoningEffort: string
  serviceTier: string
  mode: PermissionMode
  modeDisabled: boolean
  providerDisabled: boolean
  onChange: (patch: RunPatch) => void
  onProviderChange: (provider: Provider, model: string) => void
}) {
  const current = models.find((item) => item.id === model)
  const modelLabel = current?.name || model || 'Agent default'
  const catalogs = (
    providerDisabled
      ? [provider]
      : ([provider, provider === 'codex' ? 'claude' : 'codex'] as Provider[])
  ).map((agent) => {
    const catalog = agent === provider ? models : fallbackModelCatalog(agent)
    const choices = catalog.filter(
      (item, index) => catalog.findIndex((entry) => entry.id === item.id) === index,
    )
    if (agent === provider && !choices.some((item) => item.id === model))
      choices.push({ id: model, name: modelLabel })
    return { agent, choices }
  })
  const efforts = current?.supportedReasoningEfforts || []
  const tiers = current?.serviceTiers || []
  const displayedEffort = reasoningEffort || current?.defaultReasoningEffort || ''
  const permission = permissionChoices.find((item) => item.id === mode) || permissionChoices[0]
  return (
    <div
      className="reference-run-controls"
      role="group"
      aria-label="Model, reasoning, speed, and permissions"
    >
      <Select.Root
        value={JSON.stringify([provider, model])}
        onValueChange={(value) => {
          const [agent, id] = JSON.parse(value) as [Provider, string]
          if (agent !== provider) onProviderChange(agent, id)
          else onChange({ model: id })
        }}
      >
        <Select.Trigger
          className="reference-control reference-model-control"
          aria-label={`Model: ${modelLabel}`}
          title={`${provider === 'codex' ? 'Codex' : 'Claude Code'} · ${modelLabel}`}
        >
          <ProviderIcon provider={provider} size={18} />
          <span className="reference-control-label">
            <Select.Value>{modelLabel}</Select.Value>
          </span>
          <Select.Icon>
            <ChevronDown size={13} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="reference-select-content"
            position="popper"
            side="top"
            align="start"
            sideOffset={12}
            collisionPadding={12}
          >
            <Select.ScrollUpButton className="reference-menu-scroll">
              <ChevronUp size={14} />
            </Select.ScrollUpButton>
            <Select.Viewport className="reference-menu-viewport">
              {catalogs.map(({ agent, choices }) => (
                <Select.Group key={agent}>
                  <Select.Label className="reference-menu-heading">
                    {agent === 'codex' ? 'Codex · OpenAI' : 'Claude Code · Anthropic'}
                  </Select.Label>
                  {choices.map((item) => (
                    <Select.Item
                      className="reference-select-item"
                      key={item.id}
                      value={JSON.stringify([agent, item.id])}
                      textValue={item.name}
                      disabled={
                        agent === provider &&
                        item.id === model &&
                        !models.some((entry) => entry.id === model)
                      }
                    >
                      <Select.ItemText>{item.name}</Select.ItemText>
                      <Select.ItemIndicator>
                        <Check size={14} />
                      </Select.ItemIndicator>
                    </Select.Item>
                  ))}
                </Select.Group>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="reference-menu-scroll">
              <ChevronDown size={14} />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      <span className="reference-control-divider" aria-hidden="true" />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="reference-control reference-effort-control"
          aria-label={`Reasoning: ${displayedEffort ? effortName(displayedEffort) : 'Default'}; speed: ${serviceTier || 'Default'}`}
          title="Reasoning effort and response speed"
        >
          <Zap size={18} fill="currentColor" />
          <span className="reference-control-label">
            {displayedEffort ? effortName(displayedEffort) : 'Default'}
          </span>
          <ChevronDown size={13} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="reference-run-menu"
            side="top"
            align="start"
            sideOffset={12}
            collisionPadding={12}
          >
            <DropdownMenu.Label className="reference-menu-heading">
              Reasoning effort
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={`choice:${reasoningEffort}`}
              onValueChange={(value) => onChange({ reasoningEffort: value.slice(7) })}
            >
              <DropdownMenu.RadioItem className="reference-radio-item" value="choice:">
                Default
                <DropdownMenu.ItemIndicator>
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
              {efforts.map((item) => (
                <DropdownMenu.RadioItem
                  className="reference-radio-item"
                  key={item.reasoningEffort}
                  value={`choice:${item.reasoningEffort}`}
                  title={item.description}
                >
                  {effortName(item.reasoningEffort)}
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
              {reasoningEffort &&
              !efforts.some((item) => item.reasoningEffort === reasoningEffort) ? (
                <DropdownMenu.RadioItem
                  className="reference-radio-item"
                  value={`choice:${reasoningEffort}`}
                  disabled
                >
                  {effortName(reasoningEffort)} (unavailable)
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ) : null}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="reference-menu-separator" />
            <DropdownMenu.Label className="reference-menu-heading">
              Response speed
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={`choice:${serviceTier}`}
              onValueChange={(value) => onChange({ serviceTier: value.slice(7) })}
            >
              <DropdownMenu.RadioItem className="reference-radio-item" value="choice:">
                Default
                <DropdownMenu.ItemIndicator>
                  <Check size={14} />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
              {tiers.map((item) => (
                <DropdownMenu.RadioItem
                  className="reference-radio-item"
                  key={item.id}
                  value={`choice:${item.id}`}
                  title={item.description}
                >
                  {item.name}
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
              {serviceTier && !tiers.some((item) => item.id === serviceTier) ? (
                <DropdownMenu.RadioItem
                  className="reference-radio-item"
                  value={`choice:${serviceTier}`}
                  disabled
                >
                  {serviceTier} (unavailable)
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ) : null}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span className="reference-control-divider" aria-hidden="true" />
      <Select.Root
        value={mode}
        disabled={modeDisabled}
        onValueChange={(value) => onChange({ mode: value as PermissionMode })}
      >
        <Select.Trigger
          className="reference-control reference-permission-control"
          aria-label={`Agent permission mode: ${permission.name}`}
          title={permission.description}
        >
          <permission.icon size={18} aria-hidden="true" />
          <span className="reference-control-label">
            <Select.Value>{permission.name}</Select.Value>
          </span>
          <Select.Icon>
            <ChevronDown size={13} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="reference-select-content reference-permission-menu"
            position="popper"
            side="top"
            align="start"
            sideOffset={8}
            collisionPadding={12}
          >
            <Select.Viewport className="reference-menu-viewport">
              <Select.Group aria-label="Agent permissions">
                {permissionChoices.map((item) => (
                  <Select.Item
                    className="reference-select-item reference-permission-item"
                    key={item.id}
                    value={item.id}
                    textValue={item.name}
                    aria-label={`${item.name}. ${item.description}`}
                  >
                    <span className="reference-permission-copy">
                      <span className="reference-permission-title">
                        <item.icon size={16} aria-hidden="true" />
                        <Select.ItemText>{item.name}</Select.ItemText>
                      </span>
                      <small>{item.description}</small>
                    </span>
                    <Select.ItemIndicator>
                      <Check size={14} aria-hidden="true" />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Group>
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}

export function ReferenceComposerDetails({
  thread,
  connection,
  onWorkspace,
  onNotify,
}: {
  thread?: Thread
  connection: ConnectionState
  onWorkspace: () => void
  onNotify: (message: string) => void
}) {
  const element = useRef<HTMLSpanElement>(null)
  const ready = connection.status === 'connected' && Boolean(connection.workspace)
  const matches =
    ready &&
    thread?.profileId === connection.profile?.id &&
    thread?.workspace === connection.workspace
  const branch = matches ? thread?.gitBranch : undefined
  const pullRequest = matches ? thread?.pullRequest : undefined
  useEffect(() => {
    const container = element.current?.closest('.composer-container')
    const chat = container?.closest('.chat-area') as HTMLElement | null
    if (!container || !chat) return
    const update = () =>
      chat.style.setProperty(
        '--reference-composer-height',
        `${Math.ceil(container.getBoundingClientRect().height)}px`,
      )
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => {
      observer.disconnect()
      chat.style.removeProperty('--reference-composer-height')
    }
  }, [])
  return (
    <span className="reference-composer-details" ref={element}>
      {pullRequest ? (
        <span
          className="reference-pull-request"
          title={pullRequest.title}
          aria-label={`Pull request ${pullRequest.number}: ${pullRequest.title}`}
        >
          <GitPullRequest size={14} />#{pullRequest.number}
        </span>
      ) : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="reference-branch-control"
          disabled={!ready}
          aria-label={branch ? `Current branch: ${branch}` : 'Workspace branch details'}
          title={branch || 'Git branch has not been loaded'}
        >
          <GitBranch size={14} />
          <span>{branch || 'Branch unavailable'}</span>
          <ChevronDown size={12} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="reference-run-menu"
            side="top"
            align="end"
            sideOffset={10}
            collisionPadding={12}
          >
            <DropdownMenu.Label className="reference-menu-heading">
              {branch || 'Workspace'}
            </DropdownMenu.Label>
            <DropdownMenu.Item
              className="reference-radio-item"
              disabled={!branch}
              onSelect={() => {
                if (branch)
                  void navigator.clipboard
                    .writeText(branch)
                    .then(() => onNotify('Branch name copied.'))
                    .catch(() => onNotify('Could not copy the branch name.'))
              }}
            >
              Copy branch name
            </DropdownMenu.Item>
            <DropdownMenu.Item className="reference-radio-item" onSelect={onWorkspace}>
              Open workspace sidebar
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  )
}
