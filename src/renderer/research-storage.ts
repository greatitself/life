import type { ConnectionState } from '../shared/types'

export interface ResearchScope {
  key: string
  profileId: string
  workspace: string
  host: string
  root: string
}

export function researchDirectory(rootDirectory: string): string {
  if (!rootDirectory.startsWith('/') || rootDirectory.includes('\0'))
    throw new Error('Research needs an absolute machine root directory.')
  return rootDirectory.replace(/\/+$/, '') + '/.life/research'
}

export function makeResearchScope(connection: ConnectionState): ResearchScope | undefined {
  if (connection.status !== 'connected' || !connection.profile || !connection.home?.startsWith('/'))
    return
  const workspace = connection.home.replace(/\/+$/, '') || '/'
  return {
    key: JSON.stringify(['research', connection.profile.id, workspace]),
    profileId: connection.profile.id,
    workspace,
    host: connection.profile.host,
    root: researchDirectory(workspace),
  }
}

export function researchScopeMatches(scope: ResearchScope, connection: ConnectionState): boolean {
  const current = makeResearchScope(connection)
  return Boolean(
    current && current.profileId === scope.profileId && current.workspace === scope.workspace,
  )
}

/** Metadata IDs need not be filesystem names; give malformed legacy names a stable safe folder. */
export function researchStorageName(goal: { id: string; directory?: string }): string {
  const safe = (name: string | undefined) =>
    Boolean(name && name.length <= 240 && !name.startsWith('.') && !/[\/\\\0]/.test(name))
  if (safe(goal.directory)) return goal.directory!
  if (safe(goal.id)) return goal.id
  let hash = 2166136261
  for (let index = 0; index < goal.id.length; index++)
    hash = Math.imul(hash ^ goal.id.charCodeAt(index), 16777619)
  return 'goal-' + (hash >>> 0).toString(16)
}

export const researchReadme = `# Life Research

This machine's research workspace lives at ~/.life/research independently of Agents projects. Each direct child directory containing goal.json is a goal. Keep goal IDs unique and stable.

A goal.json contains {id,title,goal,problems,createdAt,updatedAt,threadId?}. Each problem contains {id,title,description,notes,status,updatedAt,threadId?}; status is open, blocked, or solved. Unknown metadata and conversation IDs are preserved.

Map files are optional, in priority order: map.html, map.mmd, map.json, then Life's automatic goal/problem map.

map.json: {nodes:[{id,label,detail?,x,y,width?,height?,color?,shape?,problemId?,action?}],edges:[{from,to,label?,color?,dashed?,arrow?}]}. Node shapes include box, pill, ellipse, diamond, and note. Set action to overview, or problemId to an existing problem ID.

map.mmd accepts Mermaid diagrams. map.html is a self-contained HTML document or fragment; scripts run in an isolated frame. Embed assets directly. The frame receives --bg, --surface, --text, --muted, and --border colors, and data-theme. To select a problem, postMessage({type:'life-research-select',problemId:'existing-id'}, '*') to parent. To select the overview, postMessage({type:'life-research-select',overview:true}, '*') to parent.

Life refreshes files while Research is visible and after turns complete. It writes goal.json atomically and leaves map files and other artifacts intact. Browser edits remain cached while the machine is offline. Migration copies recognized legacy .research goals and their artifacts; the originals are retained.
`

export const legacyResearchInstructions = `# Research workspace

This directory contains research goals and artifacts, independently of Life's application source and Agents projects. Follow the user's request and the selected permission mode.

Read the current goal.json before editing research metadata. Preserve its stable goal and problem IDs, conversation links, unrelated fields, and unknown metadata. Keep findings and artifacts in the current goal directory. Use atomic file replacements, and wait while ../.life.lock exists before editing goal.json.

The center map uses map.html, map.mmd, map.json in that priority order, falling back to the automatic goal/problem map. See ../README.md for the supported formats. Life refreshes these files after a turn. Research requests do not authorize changing Life's application source.
`

export const legacyResearchConversationInstructions = `# Life Research conversation

Read .life-context.json in this working directory before working. It identifies this conversation's exact goal and, when selected, exact problem. Resolve its file paths relative to this working directory, then read the current goalFile. Use goalId and problemId to find the relevant records; do not guess the selected problem from a short message or from a sibling conversation.

Follow the user's request and the selected permission mode. Work toward the identified goal, focusing on the identified problem when this is a problem conversation. Preserve stable IDs, conversation links, unrelated fields and unknown metadata. Keep findings and artifacts with this conversation, and update the selected problem's findings in goalFile when appropriate.

The context's mapFiles refer to the shared goal map. Map priority is HTML, Mermaid, JSON, then Life's automatic map; read readmeFile for supported formats. Use atomic replacements and wait while lockFile exists before editing goalFile. This Research conversation does not authorize changes to Life's application source.
`

export const researchInstructions =
  legacyResearchInstructions +
  '\nRead .life-context.json in the current conversation directory when present. Follow its selected goal/problem and invocation operation, then read its methodGuideFile and methodSchemaFile. The guide defines anti-abstraction as decomposition and abstraction as composition. Preserve the user request exactly; structured research context belongs in files.\n'
export const researchConversationInstructions =
  legacyResearchConversationInstructions +
  '\nRead methodGuideFile and methodSchemaFile from this context before using research tools. The operation in .life-context.json belongs to this invocation; the live activeOperation in goal.json may be different. Anti-abstraction decomposes a whole, abstraction composes constituents, and the other operators have distinct typed artifacts. Never invent observations or turn the operator into an extra user message.\n'

// This string runs on the selected SSH machine, never in the renderer.
export const researchFileWorker = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const request = JSON.parse(process.argv[1]);
const machineRoot = fs.realpathSync(process.cwd());
const lifeRoot = path.join(machineRoot, '.life');
const root = path.join(lifeRoot, 'research');
const safeName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240 && value !== '.' && value !== '..' && !/[\/\\\0]/.test(value) && !value.startsWith('.');
const ordinary = (file, directory = false) => {
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('Research paths must be ordinary files and directories: ' + file);
  return true;
};
const goalDir = (name) => {
  if (!safeName(name)) throw Error('Invalid goal directory');
  const dir = path.join(root, name);
  ordinary(dir, true);
  return dir;
};
const allowed = new Set(['goal.json', 'map.json', 'map.mmd', 'map.html']);
const goalFile = () => {
  if (!allowed.has(request.file)) throw Error('Invalid research file');
  return path.join(goalDir(request.directory), request.file);
};
const digest = (file) => {
  if (!ordinary(file)) return null;
  if (fs.statSync(file).size > 4000000) throw Error('Research file exceeds 4 MB: ' + file);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
};
const stageFile = () => {
  if (!/^[a-f0-9-]{36}$/.test(request.stage || '')) throw Error('Invalid staged write');
  return path.join(root, '.life-stage-' + request.stage);
};
const atomicManagedFile = (file, content) => {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 200000) throw Error('Invalid Research instruction or schema');
  if (ordinary(file) && fs.readFileSync(file, 'utf8') === content) return;
  const staged = file + '.life-stage-' + crypto.randomUUID();
  try { fs.writeFileSync(staged, content, {flag: 'wx', mode: 384}); fs.renameSync(staged, file); }
  finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
};
const managedInstructions = (file, content) => {
  if (!ordinary(file)) { try { fs.writeFileSync(file, content, {flag:'wx',mode:384}); } catch(error) {if(error.code!=='EEXIST'||!ordinary(file))throw error;} return; }
  const previous = Array.isArray(request.previousInstructions) ? request.previousInstructions : [];
  if (fs.statSync(file).size <= 200000 && previous.includes(fs.readFileSync(file,'utf8'))) atomicManagedFile(file,content);
};
function run() {
  if (request.op === 'init') {
    if (!ordinary(lifeRoot, true)) fs.mkdirSync(lifeRoot, {mode: 448});
    const newRoot = !ordinary(root, true);
    const stage = path.join(lifeRoot, '.research-migration-' + crypto.randomUUID());
    const destinationRoot = newRoot ? stage : root;
    const manifestFile = path.join(root, 'migration.json');
    let previous = [];
    if (!newRoot && ordinary(manifestFile)) {
      if (fs.statSync(manifestFile).size > 4000000) throw Error('Research migration manifest exceeds 4 MB. Originals were preserved.');
      const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (!parsed || !Array.isArray(parsed.entries)) throw Error('Research migration manifest is invalid. Originals were preserved.');
      previous = parsed.entries;
    }
    const migration = [...previous];
    const knownSources = new Set(previous.map((entry) => entry.source));
    const ids = new Set();
    let copiedFiles = 0;
    let copiedBytes = 0;
    const copyTree = (source, destination) => {
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        fs.mkdirSync(destination, {mode: 448});
        for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name));
      } else if (stat.isFile()) {
        copiedFiles++;
        copiedBytes += stat.size;
        if (copiedFiles > 10000 || copiedBytes > 256000000) throw Error('Legacy Research migration exceeds 256 MB or 10000 files. Originals were preserved.');
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 384);
      }
    };
    try {
      fs.mkdirSync(stage, {mode: 448});
      if (!newRoot) for (const name of fs.readdirSync(root).filter(safeName)) {
        const dir = path.join(root, name);
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        const file = path.join(dir, 'goal.json');
        if (!ordinary(file) || fs.statSync(file).size > 4000000) continue;
        try { const goal = JSON.parse(fs.readFileSync(file, 'utf8')); if (goal && typeof goal.id === 'string') ids.add(goal.id); } catch { /* Leave unrelated malformed user files intact. */ }
      }
      const sources = [...new Set([machineRoot, ...(Array.isArray(request.legacyWorkspaces) ? request.legacyWorkspaces.slice(0, 100) : [])])];
      for (const workspace of sources) {
        if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) continue;
        const legacy = path.join(workspace, '.research');
        if (!ordinary(legacy, true)) continue;
        for (const name of fs.readdirSync(legacy).filter(safeName).sort()) {
          const source = path.join(legacy, name);
          if (knownSources.has(source)) continue;
          const stat = fs.lstatSync(source);
          if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
          const file = path.join(source, 'goal.json');
          if (!ordinary(file) || fs.statSync(file).size > 4000000) continue;
          let goal;
          try { goal = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
          if (!goal || typeof goal.id !== 'string' || typeof goal.title !== 'string' || !Array.isArray(goal.problems)) continue;
          let destination = path.join(destinationRoot, name);
          const collision = fs.existsSync(destination) || ids.has(goal.id);
          if (collision) {
            const conflicts = path.join(destinationRoot, '.legacy-conflicts');
            if (!ordinary(conflicts, true)) fs.mkdirSync(conflicts, {mode: 448});
            destination = path.join(conflicts, name + '-' + crypto.createHash('sha256').update(source).digest('hex').slice(0, 12));
            if (fs.existsSync(destination)) destination += '-' + crypto.randomUUID();
          }
          if (newRoot) copyTree(source, destination);
          else {
            const stagedGoal = path.join(stage, crypto.randomUUID());
            copyTree(source, stagedGoal);
            fs.renameSync(stagedGoal, destination);
          }
          ids.add(goal.id);
          knownSources.add(source);
          migration.push({source, destination: path.relative(destinationRoot, destination), conflict: collision});
        }
      }
      if (migration.length && (newRoot || migration.length !== previous.length)) {
        const manifestStage = path.join(stage, '.migration-' + crypto.randomUUID());
        fs.writeFileSync(manifestStage, JSON.stringify({copiedAt: new Date().toISOString(), originalsRetained: true, entries: migration}, null, 2) + '\n', {mode: 384});
        fs.renameSync(manifestStage, path.join(destinationRoot, 'migration.json'));
      }
      if (newRoot) fs.renameSync(stage, root);
    } finally {
      if (fs.existsSync(stage)) fs.rmSync(stage, {recursive: true, force: true});
    }
    const readme = path.join(root, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, request.readme, {flag: 'wx', mode: 384});
    managedInstructions(path.join(root, 'AGENTS.md'), request.instructions);
    managedInstructions(path.join(root, 'CLAUDE.md'), request.instructions);
    if (request.methodGuide !== undefined) atomicManagedFile(path.join(root, '.life-method.md'), request.methodGuide);
    if (request.methodSchema !== undefined) atomicManagedFile(path.join(root, '.life-method-schema.json'), request.methodSchema);
    const conflicts = migration.filter((entry) => entry.conflict).length;
    return {ok: true, ...(conflicts ? {migrationConflicts: conflicts} : {})};
  }
  if (!ordinary(lifeRoot, true) || !ordinary(root, true)) {
    if (request.op === 'scan') return {entries: []};
    throw Error('Research folder is not initialized');
  }
  if (request.op === 'context') {
    const goalDirectory = goalDir(request.directory);
    if (!ordinary(goalDirectory, true)) throw Error('The Research goal directory is missing');
    const goalFile = path.join(goalDirectory, 'goal.json');
    if (!ordinary(goalFile) || fs.statSync(goalFile).size > 4000000) throw Error('The Research goal is missing or too large');
    const goal = JSON.parse(fs.readFileSync(goalFile, 'utf8'));
    if (!goal || typeof goal.id !== 'string' || !Array.isArray(goal.problems)) throw Error('Invalid Research goal');
    const problem = request.problemId === undefined ? undefined : goal.problems.find((item) => item && item.id === request.problemId);
    if (request.problemId !== undefined && !problem) throw Error('The selected Research problem no longer exists');
    let conversationDirectory = goalDirectory;
    const ensureDirectory = (directory) => {
      if (ordinary(directory, true)) return;
      try { fs.mkdirSync(directory, {mode: 448}); }
      catch (error) { if (error.code !== 'EEXIST' || !ordinary(directory, true)) throw error; }
    };
    if (problem) {
      if (!safeName(request.problemDirectory)) throw Error('Invalid Research problem directory');
      const problems = path.join(goalDirectory, 'problems');
      ensureDirectory(problems);
      conversationDirectory = path.join(problems, request.problemDirectory);
      ensureDirectory(conversationDirectory);
    }
    const relative = problem ? '../../' : '';
    const context = {
      format: 'life-research-context', version: 1,
      conversation: problem ? 'problem' : 'goal', goalId: goal.id,
      ...(request.invocationId ? {invocationId: request.invocationId, executionId: request.invocationId, invocationFile: '.life-invocations/' + request.invocationId + '.json'} : {}),
      ...(request.operation ? {operation: request.operation} : {}),
      methodGuideFile: relative + '../.life-method.md',
      methodSchemaFile: relative + '../.life-method-schema.json',
      ...(problem ? {problemId: problem.id} : {}),
      goalDirectory: problem ? '../..' : '.',
      goalFile: relative + 'goal.json',
      readmeFile: relative + '../README.md',
      lockFile: relative + '../.life.lock',
      mapFiles: {json: relative + 'map.json', mermaid: relative + 'map.mmd', html: relative + 'map.html'},
    };
    if (request.invocationId) {
      if (!/^[a-f0-9-]{36}$/.test(request.invocationId)) throw Error('Invalid Research invocation identity');
      const invocations = path.join(conversationDirectory, '.life-invocations');
      ensureDirectory(invocations);
      const snapshot = path.join(invocations, request.invocationId + '.json');
      if (ordinary(snapshot)) {
        if (fs.statSync(snapshot).size > 65536 || fs.readFileSync(snapshot,'utf8') !== JSON.stringify(context,null,2) + '\n') throw Error('Research invocation metadata is immutable');
      } else fs.writeFileSync(snapshot,JSON.stringify(context,null,2)+'\n',{flag:'wx',mode:384});
    }
    const contextFile = path.join(conversationDirectory, '.life-context.json');
    if (ordinary(contextFile)) {
      if (fs.statSync(contextFile).size > 65536) throw Error('The Research conversation context is too large');
      const existing = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
      if (existing.format !== context.format || existing.goalId !== context.goalId || existing.problemId !== context.problemId) throw Error('The Research conversation directory already belongs to another context');
    }
    const staged = path.join(conversationDirectory, '.life-context-' + crypto.randomUUID());
    try {
      fs.writeFileSync(staged, JSON.stringify(context, null, 2) + '\n', {flag: 'wx', mode: 384});
      fs.renameSync(staged, contextFile);
    } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(conversationDirectory, name);
      managedInstructions(file, request.instructions);
    }
    return {directory: conversationDirectory, context};
  }
  if (request.op === 'scan') {
    const entries = [];
    for (const name of fs.readdirSync(root).filter(safeName).sort()) {
      const dir = path.join(root, name);
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const file = path.join(dir, 'goal.json');
      if (!ordinary(file)) continue;
      entries.push({directory: name, revision: digest(file), maps: ['map.json', 'map.mmd', 'map.html'].map((file) => ({file, revision: digest(path.join(dir, file))}))});
    }
    return {entries};
  }
  if (request.op === 'read') {
    const file = goalFile();
    const revision = digest(file);
    if (request.expected !== undefined && revision !== request.expected) throw Error('RESEARCH_CHANGED');
    if (!revision) return {revision: null, data: '', done: true};
    const size = fs.statSync(file).size;
    const offset = request.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw Error('Invalid read offset');
    const bytes = Buffer.alloc(Math.min(32768, size - offset));
    const handle = fs.openSync(file, 'r');
    try { fs.readSync(handle, bytes, 0, bytes.length, offset); }
    finally { fs.closeSync(handle); }
    if (digest(file) !== revision) throw Error('RESEARCH_CHANGED');
    return {revision, data: bytes.toString('base64'), done: offset + bytes.length >= size};
  }
  if (request.op === 'stage') {
    const file = stageFile();
    const bytes = Buffer.from(request.data, 'base64');
    const offset = request.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length > 32768 || offset + bytes.length > 4000000) throw Error('Invalid write chunk');
    if (offset === 0) fs.writeFileSync(file, bytes, {flag: 'wx', mode: 384});
    else {
      if (!ordinary(file) || fs.statSync(file).size !== offset) throw Error('Staged write changed');
      fs.appendFileSync(file, bytes);
    }
    return {ok: true};
  }
  if (request.op === 'discard') {
    const file = stageFile();
    if (ordinary(file)) fs.unlinkSync(file);
    return {ok: true};
  }
  if (request.op === 'commit') {
    const staged = stageFile();
    if (!ordinary(staged)) throw Error('Staged write is missing');
    const parsed = JSON.parse(fs.readFileSync(staged, 'utf8'));
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.title !== 'string' || !Array.isArray(parsed.problems)) throw Error('Invalid goal.json');
    const lock = path.join(root, '.life.lock');
    if (ordinary(lock) && Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
    let handle;
    try {
      handle = fs.openSync(lock, 'wx', 384);
      const dir = goalDir(request.directory);
      const target = path.join(dir, 'goal.json');
      if (digest(target) !== request.expected) throw Error('RESEARCH_CHANGED');
      if (!ordinary(dir, true)) fs.mkdirSync(dir, {mode: 448});
      fs.renameSync(staged, target);
      return {revision: digest(target)};
    } finally {
      if (handle !== undefined) { fs.closeSync(handle); fs.unlinkSync(lock); }
    }
  }
  throw Error('Unknown research operation');
}
try { process.stdout.write('LIFE_RESEARCH_RESULT=' + JSON.stringify({value: run()}) + '\n'); }
catch (error) { process.stdout.write('LIFE_RESEARCH_RESULT=' + JSON.stringify({error: error.message}) + '\n'); }
`
