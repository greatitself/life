export interface ForwardedPort {
  remoteHost: string
  remotePort: number
  localHost: '127.0.0.1'
  localPort: number
  url: string
}

export interface PortForwardingState {
  enabled: boolean
  active: boolean
  ports: ForwardedPort[]
  error?: string
}
