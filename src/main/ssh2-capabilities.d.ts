// ssh2's own connect() validation uses these runtime-dependent protocol capabilities.
declare module 'ssh2/lib/protocol/constants.js' {
  const constants: {
    SUPPORTED_CIPHER: string[]
    SUPPORTED_SERVER_HOST_KEY: string[]
    SUPPORTED_KEX: string[]
    SUPPORTED_MAC: string[]
  }
  export default constants
}
