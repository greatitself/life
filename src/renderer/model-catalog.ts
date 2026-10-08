import type { ModelOption, Provider } from '../shared/types'

export function fallbackModelCatalog(provider: Provider): ModelOption[] {
  return [{ id: '', name: provider === 'claude' ? 'Claude default' : 'Codex default' }]
}

/** Keep provider default selectable without losing its advertised capabilities. */
export function withProviderDefault(provider: Provider, catalog: ModelOption[]): ModelOption[] {
  const defaultModel = catalog.find((model) => model.isDefault && model.id !== '')
  const existingDefault = catalog.find((model) => model.id === '')
  const providerDefault: ModelOption = {
    ...(existingDefault || defaultModel),
    id: '',
    name: existingDefault?.name || (provider === 'claude' ? 'Claude default' : 'Codex default'),
    isDefault: true,
  }
  return [providerDefault, ...catalog.filter((model) => model.id !== '')]
}
