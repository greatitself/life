import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { deflateSync } from 'node:zlib'
import { lifeStudioContextSchema, type LifeStudioContext } from '../shared/life-studio'
import { shellQuote } from '../shared/validation'
import type { SSHConnection } from './ssh'

type StudioConnection = Pick<SSHConnection, 'state' | 'exec'>

// A fixed program receives the app context through stdin. Context content never
// becomes a shell argument or an extra provider user message.
const stageContextProgram = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let size = 0;
const chunks = [];
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size > 20000000) {
    process.stderr.write('Life Studio context exceeds its input limit.');
    process.exit(1);
  }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const temporary = [];
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['home', 'session', 'context'].includes(key)) ||
        typeof input.home !== 'string' || !path.isAbsolute(input.home) ||
        input.home.length > 4096 || /[\x00-\x1f]/.test(input.home) ||
        input.home.split('/').includes('..') ||
        typeof input.session !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.session)) throw new Error('Invalid Life Studio directory.');
    const context = input.context;
    if (!context || typeof context !== 'object' || Array.isArray(context) ||
        Object.keys(context).some(key => !['instructions', 'files', 'revision', 'phase'].includes(key)) ||
        typeof context.instructions !== 'string' ||
        !context.instructions.length || context.instructions.length > 100000 ||
        !Array.isArray(context.files) || context.files.length > 30 ||
        !Number.isSafeInteger(context.revision) || context.revision < 0 ||
        !['request', 'source-read', 'repair'].includes(context.phase))
      throw new Error('Invalid Life Studio context.');
    const names = new Set();
    let contentBytes = Buffer.byteLength(context.instructions);
    for (const file of context.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file) ||
          Object.keys(file).some(key => !['path', 'content'].includes(key)) ||
          typeof file.path !== 'string' ||
          !/^\.life\/[a-z][a-z0-9-]*\.json$/.test(file.path) ||
          typeof file.content !== 'string' || file.content.length > 2000000 ||
          names.has(file.path)) throw new Error('Invalid Life Studio context file.');
      names.add(file.path);
      contentBytes += Buffer.byteLength(file.content);
    }
    if (contentBytes > 3000000) throw new Error('Life Studio context exceeds 3 MB.');
    const root = path.join(input.home, '.life', 'customization', input.session);
    function privateDirectory(directory) {
      try { fs.mkdirSync(directory, {mode: 0o700}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Life Studio directories must be real directories, not symbolic links.');
      fs.chmodSync(directory, 0o700);
    }
    for (const directory of [path.join(input.home, '.life'),
        path.join(input.home, '.life', 'customization'), root, path.join(root, '.life')])
      privateDirectory(directory);
    function checkFile(file) {
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error('Life Studio context files must be regular files, not symbolic links.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const manifestPath = path.join(root, '.studio-context.json');
    checkFile(manifestPath);
    let priorFiles = [];
    if (fs.existsSync(manifestPath)) {
      const stat = fs.lstatSync(manifestPath);
      if (stat.size > 10000) throw new Error('Invalid Life Studio context manifest.');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.session !== input.session || !Array.isArray(manifest.files) ||
          manifest.files.length > 30 || manifest.files.some(file =>
            typeof file !== 'string' || !/^\.life\/[a-z][a-z0-9-]*\.json$/.test(file)))
        throw new Error('Invalid Life Studio context manifest.');
      priorFiles = manifest.files;
    }
    const files = [{path:'AGENTS.md', content:context.instructions},
      {path:'CLAUDE.md', content:context.instructions}, ...context.files,
      {path:'.studio-context.json', content:JSON.stringify({session:input.session,
        revision:context.revision, phase:context.phase, files:[...names]})}];
    // Check every destination before creating any replacement, including files
    // owned by the previous revision that are about to be retired.
    for (const file of files) checkFile(path.join(root, file.path));
    for (const file of priorFiles) checkFile(path.join(root, file));
    for (const file of files) {
      const destination = path.join(root, file.path);
      const temp = path.join(path.dirname(destination), '.life-write-' + crypto.randomUUID());
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT |
        fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporary.push(temp);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, file.content, 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      file.destination = destination;
      file.temporary = temp;
    }
    for (const file of files) {
      checkFile(file.destination);
      fs.renameSync(file.temporary, file.destination);
    }
    for (const file of priorFiles) if (!names.has(file)) {
      try { fs.unlinkSync(path.join(root, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    process.stdout.write(JSON.stringify({workspace:root}));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : 'Unable to stage Life Studio context.');
    process.exitCode = 1;
  } finally {
    for (const file of temporary) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') process.exitCode = 1; }
    }
  }
});
`

const stageContextPythonProgram = String.raw`
import errno, json, os, re, stat, sys, uuid

temporary = []
try:
    raw = sys.stdin.buffer.read(20000001)
    if len(raw) > 20000000:
        raise ValueError('Life Studio context exceeds its input limit.')
    source = json.loads(raw.decode('utf-8'))
    def string_length(text):
        return len(text.encode('utf-16-le', errors='surrogatepass')) // 2
    def content_bytes(text):
        # Match Node's UTF-8 treatment of a JavaScript string, including lone
        # UTF-16 surrogates. Valid Unicode and line endings remain exact.
        return text.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace').encode('utf-8')
    def context_path(value):
        return isinstance(value, str) and re.fullmatch(r'\.life/[a-z][a-z0-9-]*\.json', value) is not None
    if (not isinstance(source, dict) or set(source) != {'home', 'session', 'context'} or
            not isinstance(source['home'], str) or not os.path.isabs(source['home']) or
            string_length(source['home']) > 4096 or re.search(r'[\x00-\x1f]', source['home']) or
            '..' in source['home'].split('/') or not isinstance(source['session'], str) or
            re.fullmatch(r'[a-f0-9]{64}', source['session']) is None):
        raise ValueError('Invalid Life Studio directory.')
    context = source['context']
    if (not isinstance(context, dict) or set(context) != {'instructions', 'files', 'revision', 'phase'} or
            not isinstance(context['instructions'], str) or not context['instructions'] or
            string_length(context['instructions']) > 100000 or
            not isinstance(context['files'], list) or len(context['files']) > 30 or
            type(context['revision']) is not int or context['revision'] < 0 or context['revision'] > 9007199254740991 or
            context['phase'] not in ('request', 'source-read', 'repair')):
        raise ValueError('Invalid Life Studio context.')
    names = set()
    total = len(content_bytes(context['instructions']))
    for file in context['files']:
        if (not isinstance(file, dict) or set(file) != {'path', 'content'} or
                not context_path(file['path']) or not isinstance(file['content'], str) or
                string_length(file['content']) > 2000000 or file['path'] in names):
            raise ValueError('Invalid Life Studio context file.')
        names.add(file['path'])
        total += len(content_bytes(file['content']))
    if total > 3000000:
        raise ValueError('Life Studio context exceeds 3 MB.')
    home = source['home']
    root = os.path.join(home, '.life', 'customization', source['session'])
    def private_directory(directory):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
        info = os.lstat(directory)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError('Life Studio directories must be real directories, not symbolic links.')
        os.chmod(directory, 0o700)
    for directory in (os.path.join(home, '.life'), os.path.join(home, '.life', 'customization'), root, os.path.join(root, '.life')):
        private_directory(directory)
    def check_file(file):
        try:
            info = os.lstat(file)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ValueError('Life Studio context files must be regular files, not symbolic links.')
    manifest_path = os.path.join(root, '.studio-context.json')
    check_file(manifest_path)
    prior_files = []
    if os.path.exists(manifest_path):
        if os.lstat(manifest_path).st_size > 10000:
            raise ValueError('Invalid Life Studio context manifest.')
        with open(manifest_path, 'r', encoding='utf-8') as handle:
            manifest = json.load(handle)
        if (not isinstance(manifest, dict) or manifest.get('session') != source['session'] or
                not isinstance(manifest.get('files'), list) or len(manifest['files']) > 30 or
                any(not context_path(file) for file in manifest['files'])):
            raise ValueError('Invalid Life Studio context manifest.')
        prior_files = manifest['files']
    files = [{'path': 'AGENTS.md', 'content': context['instructions']},
        {'path': 'CLAUDE.md', 'content': context['instructions']}] + context['files'] + [
        {'path': '.studio-context.json', 'content': json.dumps({'session': source['session'],
            'revision': context['revision'], 'phase': context['phase'],
            'files': [file['path'] for file in context['files']]}, separators=(',', ':'))}]
    for file in files:
        check_file(os.path.join(root, file['path']))
    for file in prior_files:
        check_file(os.path.join(root, file))
    for file in files:
        destination = os.path.join(root, file['path'])
        temp = os.path.join(os.path.dirname(destination), '.life-write-' + str(uuid.uuid4()))
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        temporary.append(temp)
        with os.fdopen(descriptor, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(content_bytes(file['content']))
            handle.flush()
            os.fsync(handle.fileno())
        file['destination'] = destination
        file['temporary'] = temp
    for file in files:
        check_file(file['destination'])
        os.replace(file['temporary'], file['destination'])
    for file in prior_files:
        if file not in names:
            try:
                os.unlink(os.path.join(root, file))
            except FileNotFoundError:
                pass
    sys.stdout.write(json.dumps({'workspace': root}, separators=(',', ':')))
except Exception as error:
    sys.stderr.write(str(error) or 'Unable to stage Life Studio context.')
    sys.exit(1)
finally:
    for file in temporary:
        try:
            os.unlink(file)
        except FileNotFoundError:
            pass
`

// Compression keeps the constant shell command small. Both programs consume the
// same bounded JSON on stdin; user instructions never enter executable code.
const nodeProgram = `eval(require('node:zlib').inflateSync(Buffer.from('${deflateSync(stageContextProgram).toString('base64')}','base64')).toString('utf8'))`
const pythonProgram = `import base64,zlib;exec(zlib.decompress(base64.b64decode('${deflateSync(stageContextPythonProgram).toString('base64')}')))`
const stageContextCommand = `if command -v node >/dev/null 2>&1; then node -e ${shellQuote(nodeProgram)}; elif command -v python3 >/dev/null 2>&1; then python3 -c ${shellQuote(pythonProgram)}; else printf '%s\\n' ${shellQuote('Life Studio requires Node.js or Python 3 on the connected environment.')} >&2; exit 127; fi`

/** Stage app instructions without a project; the remote machine needs Node.js or Python 3. */
export async function stageStudioContext(
  ssh: StudioConnection,
  sessionId: string,
  context: LifeStudioContext,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = lifeStudioContextSchema.parse(context)
  if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 100)
    throw new Error('Invalid Life Studio session')
  const initial = ssh.state
  const identity = initial.profile ? { ...initial.profile } : undefined
  const current = () => {
    if (signal?.aborted) throw new Error('Life Studio context staging cancelled')
    const profile = ssh.state.profile
    if (
      initial.status !== 'connected' ||
      ssh.state.status !== 'connected' ||
      profile?.id !== identity?.id ||
      profile?.host !== identity?.host ||
      profile?.username !== identity?.username ||
      profile?.port !== identity?.port
    )
      throw new Error('Connect to the Life Studio environment first')
  }
  current()
  const home =
    initial.home ?? (await ssh.exec(`printf '%s' "$HOME"`, { signal, maxOutputBytes: 8192 }))
  current()
  if (
    !home ||
    home.length > 4096 ||
    !posix.isAbsolute(home) ||
    /[\x00-\x1f]/.test(home) ||
    home.split('/').includes('..')
  )
    throw new Error('The Life Studio environment has no valid home directory')
  const session = createHash('sha256').update(sessionId).digest('hex')
  const workspace = posix.join(home, '.life', 'customization', session)
  const input = JSON.stringify({ home, session, context: parsed })
  if (Buffer.byteLength(input) > 20_000_000)
    throw new Error('Life Studio context exceeds its input limit')
  const output = await ssh.exec(stageContextCommand, {
    signal,
    input,
    timeoutMs: 30_000,
    maxOutputBytes: 8192,
  })
  current()
  let result: unknown
  try {
    result = JSON.parse(output.trim())
  } catch {
    throw new Error('The Life Studio environment returned an invalid staging result')
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !('workspace' in result) ||
    result.workspace !== workspace
  )
    throw new Error('The Life Studio environment returned an invalid workspace')
  return workspace
}
