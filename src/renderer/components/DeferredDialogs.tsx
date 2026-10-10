import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { Modal } from './Modal'

type DialogControls = {
  open: boolean
  onOpenChange: (open: boolean) => void
  suspended?: boolean
}
type FallbackProps = DialogControls & { title: string; failed?: boolean; onRetry?: () => void }

function DialogFallback({ open, suspended, onOpenChange, title, failed, onRetry }: FallbackProps) {
  return (
    <Modal
      open={open && !suspended}
      onOpenChange={onOpenChange}
      title={title}
      description={failed ? 'This dialog could not be loaded.' : 'Opening this dialog…'}
      onCloseAutoFocus={(event) => {
        // Loading finishes by replacing this modal with the real dialog.
        if (open) event.preventDefault()
      }}
    >
      {failed ? (
        <>
          <p role="alert">Try again, or close this dialog and continue working.</p>
          <button className="button primary" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <p role="status">Loading…</p>
      )}
    </Modal>
  )
}

class DialogBoundary extends Component<
  FallbackProps & { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <DialogFallback {...this.props} failed /> : this.props.children
  }
}

function OpenedDialog<P extends DialogControls>({
  Dialog,
  props,
}: {
  Dialog: ComponentType<P>
  props: P
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // Strict Mode repeats mount effects. Commit the initially closed dialog
  // before opening it so first-use native reads run once, as they did eagerly.
  return <Dialog {...props} open={props.open && mounted} />
}

/** Load on first use, then retain the dialog's draft, subscriptions and cached state. */
export function deferredDialog<P extends DialogControls>(
  load: () => Promise<{ default: (props: P) => ReactNode }>,
  title: string,
): ComponentType<P> {
  return function DeferredDialog(props: P) {
    const [visibility, setVisibility] = useState(() => ({
      open: props.open,
      requested: props.open,
      opener:
        props.open && document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }))
    if (props.open !== visibility.open) {
      setVisibility({
        open: props.open,
        requested: visibility.requested || props.open,
        opener:
          props.open && document.activeElement instanceof HTMLElement
            ? document.activeElement
            : visibility.opener,
      })
    }
    const [attempt, setAttempt] = useState(0)
    const Deferred = useMemo(() => lazy(load), [attempt])
    useEffect(() => {
      if (props.open || !visibility.opener) return
      const frame = requestAnimationFrame(() => {
        if (document.activeElement === document.body && !document.querySelector('[role="dialog"]'))
          visibility.opener?.isConnected && visibility.opener.focus()
      })
      return () => cancelAnimationFrame(frame)
    }, [props.open, visibility.opener])
    if (!visibility.requested) return null
    const fallback = {
      open: props.open,
      suspended: props.suspended,
      onOpenChange: props.onOpenChange,
      title,
    }
    return (
      <DialogBoundary {...fallback} key={attempt} onRetry={() => setAttempt((value) => value + 1)}>
        <Suspense fallback={<DialogFallback {...fallback} />}>
          <OpenedDialog Dialog={Deferred} props={props} />
        </Suspense>
      </DialogBoundary>
    )
  }
}

export const ConnectionDialog = deferredDialog<
  ComponentProps<(typeof import('./ConnectionDialog'))['ConnectionDialog']>
>(
  () => import('./ConnectionDialog').then((module) => ({ default: module.ConnectionDialog })),
  'Connect a machine',
)
export const ProjectDialog = deferredDialog<
  ComponentProps<(typeof import('./ProjectDialog'))['ProjectDialog']>
>(
  () => import('./ProjectDialog').then((module) => ({ default: module.ProjectDialog })),
  'Select a project',
)
export const HostHistoryDialog = deferredDialog<
  ComponentProps<(typeof import('./HostHistoryDialog'))['HostHistoryDialog']>
>(
  () => import('./HostHistoryDialog').then((module) => ({ default: module.HostHistoryDialog })),
  'Host chat history',
)
export const CustomizationDialog = deferredDialog<
  ComponentProps<(typeof import('./CustomizationDialog'))['CustomizationDialog']>
>(
  () => import('./CustomizationDialog').then((module) => ({ default: module.CustomizationDialog })),
  'Settings',
)
export const UpdateDialog = deferredDialog<
  ComponentProps<(typeof import('./UpdateDialog'))['UpdateDialog']>
>(
  () => import('./UpdateDialog').then((module) => ({ default: module.UpdateDialog })),
  'Life updates',
)
export const UsageDialog = deferredDialog<
  ComponentProps<(typeof import('./UsageDialog'))['UsageDialog']>
>(() => import('./UsageDialog').then((module) => ({ default: module.UsageDialog })), 'Usage')
export const ExtensionDialog = deferredDialog<
  ComponentProps<(typeof import('./ExtensionDialog'))['ExtensionDialog']>
>(
  () => import('./ExtensionDialog').then((module) => ({ default: module.ExtensionDialog })),
  'Manage extensions',
)
export const SourceCodeDialog = deferredDialog<
  ComponentProps<(typeof import('./SourceCodeDialog'))['SourceCodeDialog']>
>(
  () => import('./SourceCodeDialog').then((module) => ({ default: module.SourceCodeDialog })),
  'Life source',
)
export const PortForwardDialog = deferredDialog<
  ComponentProps<(typeof import('./PortForwardDialog'))['PortForwardDialog']>
>(
  () => import('./PortForwardDialog').then((module) => ({ default: module.PortForwardDialog })),
  'Port forwarding',
)
