import type { ReactNode } from 'react'
import * as Select from '@radix-ui/react-select'
import { BrainCircuit, Check, ChevronDown, ChevronUp, Gauge } from 'lucide-react'
import type { ModelOption, Provider } from '../../shared/types'
import { parsePrefixedSelection } from '../selector-values'
import { ProviderIcon } from './Icons'
import './thread-controls.css'

interface Choice {
  value: string
  label: string
  description?: string
  disabled?: boolean
}
function ChoiceMenu({
  label,
  value,
  choices,
  icon,
  onChange,
}: {
  label: string
  value: string
  choices: Choice[]
  icon: ReactNode
  onChange: (value: string) => void
}) {
  const options = choices.filter(
    (item, index) => choices.findIndex((entry) => entry.value === item.value) === index,
  )
  if (!options.some((item) => item.value === value))
    options.push({
      value,
      label: `${value || 'Default'} (unavailable)`,
      description: 'Choose an option reported by this provider.',
      disabled: true,
    })
  const selected = options.find((item) => item.value === value)!
  return (
    <Select.Root
      value={`choice:${value}`}
      onValueChange={(next) => {
        const selected = parsePrefixedSelection(next)
        if (selected !== undefined) onChange(selected)
      }}
    >
      <Select.Trigger
        className="life-choice-trigger"
        aria-label={`${label}: ${selected.label}`}
        title={selected.description || label}
      >
        {icon}
        <span className="life-choice-value">
          <Select.Value>{selected.label}</Select.Value>
        </span>
        <Select.Icon>
          <ChevronDown size={11} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="life-choice-content"
          position="popper"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <Select.ScrollUpButton className="life-choice-scroll">
            <ChevronUp size={14} />
          </Select.ScrollUpButton>
          <Select.Viewport className="life-choice-viewport">
            <Select.Group>
              <Select.Label className="life-choice-heading">{label}</Select.Label>
              {options.map((item) => (
                <Select.Item
                  key={item.value}
                  value={`choice:${item.value}`}
                  disabled={item.disabled}
                  textValue={item.label}
                  className="life-choice-item"
                >
                  <span className="life-choice-item-copy">
                    <Select.ItemText>{item.label}</Select.ItemText>
                    {item.description ? <small>{item.description}</small> : null}
                  </span>
                  <Select.ItemIndicator>
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Viewport>
          <Select.ScrollDownButton className="life-choice-scroll">
            <ChevronDown size={14} />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
function effortName(value: string) {
  return value === 'xhigh'
    ? 'Extra high'
    : value.replace(
        /(^|[_-])([a-z])/g,
        (_, separator, letter: string) => `${separator ? ' ' : ''}${letter.toUpperCase()}`,
      )
}
export function RunSelectors({
  models,
  provider,
  model,
  reasoningEffort,
  serviceTier,
  onChange,
}: {
  models: ModelOption[]
  provider: Provider
  model: string
  reasoningEffort: string
  serviceTier: string
  onChange: (value: { model?: string; reasoningEffort?: string; serviceTier?: string }) => void
}) {
  const current = models.find((item) => item.id === model)
  const efforts = current?.supportedReasoningEfforts || []
  const tiers = current?.serviceTiers || []
  return (
    <div className="life-run-selectors" role="group" aria-label="Thread model, reasoning and speed">
      <ChoiceMenu
        label="Model"
        value={model}
        icon={<ProviderIcon provider={provider} size={14} />}
        choices={models.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => onChange({ model: value })}
      />
      <ChoiceMenu
        label="Reasoning effort"
        value={reasoningEffort}
        icon={<BrainCircuit size={14} />}
        choices={[
          {
            value: '',
            label: current?.defaultReasoningEffort
              ? `Default (${effortName(current.defaultReasoningEffort)})`
              : 'Reasoning: default',
            description: efforts.length
              ? 'Use the model’s default reasoning effort.'
              : 'This model has not reported configurable reasoning options.',
          },
          ...efforts.map((item) => ({
            value: item.reasoningEffort,
            label: effortName(item.reasoningEffort),
            description: item.description,
          })),
        ]}
        onChange={(value) => onChange({ reasoningEffort: value })}
      />
      <ChoiceMenu
        label="Response speed"
        value={serviceTier}
        icon={<Gauge size={14} />}
        choices={[
          {
            value: '',
            label: 'Speed: default',
            description: tiers.length
              ? 'Use the provider’s default service tier.'
              : 'This model has not reported configurable speed options.',
          },
          ...tiers.map((item) => ({
            value: item.id,
            label: item.name,
            description: item.description,
          })),
        ]}
        onChange={(value) => onChange({ serviceTier: value })}
      />
    </div>
  )
}
