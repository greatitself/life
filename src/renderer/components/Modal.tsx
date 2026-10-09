import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useRef, type ComponentProps, type ReactNode } from 'react'
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  children: ReactNode
  className?: string
  onCloseAutoFocus?: ComponentProps<typeof Dialog.Content>['onCloseAutoFocus']
}) {
  const content = useRef<HTMLDivElement>(null)
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          ref={content}
          className={`modal ${className}`}
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={(event) => {
            const field = content.current?.querySelector<HTMLInputElement>(
              'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
            )
            if (field) {
              event.preventDefault()
              field.focus()
            }
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
