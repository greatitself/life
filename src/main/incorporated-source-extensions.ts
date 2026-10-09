import { createHash } from 'node:crypto'
import type { SourceExtensionBundle } from '../shared/source-extensions'

/** Hash format 1: recursively sorted object keys; array order and all bundle fields retained. */
export const incorporatedBundleHashVersion = 1

export interface IncorporatedSourceExtension {
  id: string
  sha256: string
}

// Only exact bundle identities are published. Source snapshots and backup data stay private.
// These changes now ship as Life's built-in interface. Keep this historical identity list so
// a later upgrade can still recognize the original export without executing old code.
export const incorporatedSourceExtensions: readonly IncorporatedSourceExtension[] = [
  {
    id: 'source-031b0e38170a',
    sha256: '2ee00d729d7dee8f07332ef0909c89d51e5ebc3f1816b6930b2cf2b6d1e4233c',
  },
  {
    id: 'source-0dc6197e23cf',
    sha256: '29c70c06697ee76ef216f9ba627ce0ee4860dc49b3de48340b19d5fc913ae4ec',
  },
  {
    id: 'source-1f744fc8d6d7',
    sha256: '0b0721eeb354692b06b8c00c5740fdab19d0850a6e480a8586d53f290c3f0339',
  },
  {
    id: 'source-2846644351b9',
    sha256: '97d3123fe65c9df9de0abe0a7139d388c94c0e825d6e7d8acf4895c10ca9c668',
  },
  {
    id: 'source-2c5d2001c41c',
    sha256: '8f0f6aff2e796c1788180f142ad7cc40e0db9bf8cae4c70f03f7e7a7c7baf739',
  },
  {
    id: 'source-38077381109d',
    sha256: 'eab799a62e71d165ee556731ab9b1251efdca3a3666d953e4c9a9dee54532da5',
  },
  {
    id: 'source-5066db7ba3f3',
    sha256: 'c7f766dedb0887eb0726bd96242fe4a697732165c4d0cdf62d8bc4adc6ba02bd',
  },
  {
    id: 'source-56303aa9af08',
    sha256: 'ed376cfe370210d348fddeee62ddfca04fcf2c2ec6ac73e5f7ae83e6c1a15975',
  },
  {
    id: 'source-73b7de289714',
    sha256: '4e9c48f3c2d997acf423af1c12db6ed89e24010a5de2d726d02006fe19150551',
  },
  {
    id: 'source-7872447a26e1',
    sha256: '32655f53ef56e92d3393ac81006deb14a0fd9714e88c26f45fc6c2b63a76963f',
  },
  {
    id: 'source-7ae6e7db5cdd',
    sha256: '13c9dfede5bbfd28f9917cebc5343a0391352fec18a3a630913079d0620ae20d',
  },
  {
    id: 'source-7fe231a4b39b',
    sha256: '3b70ea1a094763a87ffd0f7cb9291cb79f2d9d18fc517971dfdd60f8728784f6',
  },
  {
    id: 'source-8390092f925a',
    sha256: '2c157cbdd7733caf47fc3538abf7e55f1fedc8b5f1f8384f3b475ad5cc5e60cd',
  },
  {
    id: 'source-8e17df5a7830',
    sha256: '7e10d54b970300e5136b442cb1218a53438824a93bac3b11c2dfeb4d1141937b',
  },
  {
    id: 'source-94638dc56d1e',
    sha256: '6da842fe590d995c9b78a294ac572d35d1f77f54bec79e5b2aa3b4e7815879d8',
  },
  {
    id: 'source-9bb3ffbcce4d',
    sha256: 'dbffdfe8e4b70d90f28b7515866ebbfc582da831f1b2e90bbc0f4a2cb68e4a89',
  },
  {
    id: 'source-a80581604688',
    sha256: '8454db5eca03f2a6b342d885edc1d5cca7277f0c2f86db931a6efa863ae0ee1a',
  },
  {
    id: 'source-b1de0fc7acc3',
    sha256: '27c4c3450cdf92be62639cbebadaa2bbab9d12bac16bedf0e73a9097d8610a44',
  },
  {
    id: 'source-b4b5867cc0cc',
    sha256: 'a9426f086ede8aa1b8ced9baafce1dee62ab9c6480a0886df6f6f8ee45aac992',
  },
  {
    id: 'source-bc725feec6fa',
    sha256: '7e2658de91fb3a3bfbf34d15c568a5e3d15cd207da446d457150db821050f500',
  },
  {
    id: 'source-d14e8c229403',
    sha256: 'aad45a9bbbe8ed7539af54431708e1fff4389d08440910fe86d6efe67027adb0',
  },
  {
    id: 'source-d39f6c57b8d7',
    sha256: '1ef044782c5b793f58b79e0085f86f861932f7f7b871c04e7f28840e27074554',
  },
  {
    id: 'source-de08b7661bb6',
    sha256: 'c9a8517b63fa916d73647a66d730e6290280bcfbbe9bff8c4e78f3ebf95d2d9b',
  },
  {
    id: 'source-df30d8af2e48',
    sha256: 'b584536d68f3b32c1d10e303e2023651ec9d3e0411c40ed4259d89faedb95513',
  },
  {
    id: 'source-e143e0e038ea',
    sha256: '7e0067a7f77c8c565d75233ea69f631148e336064549a514d838665e3023a526',
  },
  {
    id: 'source-e29be4176e7b',
    sha256: '142bc9a63e9c5aeb2f13ee3116172f9c176193edf92b47e23c749943a213616a',
  },
  {
    id: 'source-f4c0f424ebf0',
    sha256: '43b129feceed8bc43fe3edd6c9fe2217269001163aacce44080cc5506e14e567',
  },
]

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}

export function incorporatedBundleHash(bundle: SourceExtensionBundle): string {
  return createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex')
}

export function isIncorporatedSourceExtension(
  bundle: SourceExtensionBundle,
  manifest: readonly IncorporatedSourceExtension[] = incorporatedSourceExtensions,
): boolean {
  const candidates = manifest.filter((entry) => entry.id === bundle.id)
  return (
    candidates.length > 0 &&
    candidates.some((entry) => entry.sha256 === incorporatedBundleHash(bundle))
  )
}
