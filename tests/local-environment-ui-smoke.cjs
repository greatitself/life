#!/usr/bin/env node
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { join, relative, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { build } = require('esbuild')

// Actual production React components with a mock native boundary. This fixture
// performs no SSH connection, CLI execution, authentication, or inference.
const bootstrap = String.raw`
  const local={id:'local:90d3e8ec-894d-42db-9b04-a9ae7be06146',transport:'local',name:'Local',host:'localhost',port:22,username:'fixture',auth:'agent',privateKeyPath:'',workspace:'~'}
  const ssh={id:'ssh-fixture',name:'SSH research',host:'research.example',port:2222,username:'researcher',auth:'key',privateKeyPath:'/fixture/key',workspace:'/srv/project'}
  const calls={connect:[],beforeConnect:0,selected:[],directories:[],saved:[],removed:[],configList:[],configResolve:[],connectedCallbacks:[],selectedCallbacks:[]}
  const listeners=new Set()
  let current={status:'disconnected'},failure,pending,hold=false,beforePending,holdBefore=false
  function emit(state){current=state;for(const listener of listeners)listener(state);return state}
  function connected(input){return {status:'connected',profile:{...input},home:input.transport==='local'?'/tmp/local-ui':'/home/researcher',codex:'codex-cli 0.162.1',claude:'missing'}}
  window.localUITest={local,ssh,calls,getState:()=>current,setFailure:(value)=>failure=value,holdBeforeConnect:()=>holdBefore=true,beforeConnect:async()=>{calls.beforeConnect++;if(holdBefore)return new Promise(resolve=>beforePending=resolve)},finishBeforeConnect:()=>{if(!beforePending)throw new Error('No pending connection barrier');holdBefore=false;const resolve=beforePending;beforePending=undefined;resolve()},holdConnect:()=>hold=true,finishConnect:()=>{const action=pending;pending=undefined;hold=false;if(!action)throw new Error('No pending connect');action.resolve(emit(connected(action.input)))},emit}
  window.relay={
    sourceCode:{get:async()=>({builtInRevision:0,extensions:[]}),onState:()=>()=>{}},
    profiles:{list:async()=>[local,ssh],save:async input=>{calls.saved.push(input)},remove:async id=>{calls.removed.push(id)}},
    sshConfig:{list:async path=>{calls.configList.push(path||null);return {path:path||'/fixture/ssh/config',hosts:[]}},resolve:async(...args)=>{calls.configResolve.push(args);throw new Error('No fixture SSH alias')}},
    connection:{
      state:async()=>current,
      connect:async input=>{calls.connect.push({...input});emit({status:'connecting',profile:{...input}});if(failure){const value=failure;failure=undefined;const failed=emit({status:'disconnected',profile:{...input},error:value.error});if(value.returnState)return failed;throw new Error(value.error)}if(hold)return new Promise((resolve,reject)=>{pending={input,resolve,reject}});return emit(connected(input))},
      listDirectories:async path=>{calls.directories.push({profileId:current.profile?.id,path:path||null});return {path:path||'/tmp/local-ui',parent:'/tmp',entries:[{name:'project',path:'/tmp/local-ui/project with spaces'}]}},
      selectWorkspace:async path=>{if(current.status!=='connected'||current.profile?.id!==local.id)throw new Error('Fixture workspace owner changed');calls.selected.push({profileId:current.profile.id,path});return emit({...current,workspace:path})}
    },
    onConnection:listener=>{listeners.add(listener);return ()=>listeners.delete(listener)},
    chooseKey:async()=>{throw new Error('Local must not request a key')}
  }
`

const contents = String.raw`
  import React,{useEffect,useRef,useState} from 'react'
  import {createRoot} from 'react-dom/client'
  import {ConnectionDialog} from './src/renderer/components/ConnectionDialog'
  import {ProjectDialog} from './src/renderer/components/ProjectDialog'
  import {ActiveEnvironment} from './src/renderer/components/ActiveEnvironment'
  import './src/renderer/styles.css'
  const test=window.localUITest
  const scenario=new URLSearchParams(location.search).get('scenario')
  function Fixture(){
    const [profiles,setProfiles]=useState(scenario==='late'?[]:[test.local,test.ssh])
    const [connection,setConnection]=useState(test.getState())
    const [open,setOpen]=useState(true)
    const [projectOpen,setProjectOpen]=useState(false)
    const [requested,setRequested]=useState(scenario==='ssh'?test.ssh.id:undefined)
    const current=useRef(connection);current.current=connection
    useEffect(()=>window.relay.onConnection(setConnection),[])
    test.deliverProfiles=(value)=>setProfiles(value)
    test.open=(id)=>{setRequested(id);setOpen(true)}
    test.state=()=>current.current
    return <main><h1>Local environment UI fixture</h1><p>Actual React components; mock native API; no upstream provider requests.</p>
      <ActiveEnvironment connection={connection} onConnect={()=>test.open()} onChooseProject={()=>setProjectOpen(true)}/>
      <ConnectionDialog open={open} onOpenChange={setOpen} profiles={profiles} refreshProfiles={()=>{}} connection={connection} initialProfileId={requested} beforeConnect={test.beforeConnect} onConnected={state=>{test.calls.connectedCallbacks.push(state);setConnection(state);setProjectOpen(true)}}/>
      <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} connection={connection} onSelected={state=>{test.calls.selectedCallbacks.push(state);setConnection(state)}}/>
    </main>
  }
  createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>)
`

// Native Python Playwright follows the repository's webapp-testing skill.
const automation = String.raw`
import json, pathlib, sys, traceback
from playwright.sync_api import sync_playwright

url, output = sys.argv[1:]
output = pathlib.Path(output)
checks, errors = [], []
proof = {"fixture": "actual React components with a mock native API", "upstreamInference": False, "checks": checks, "browserErrors": errors}
def record(name):
    checks.append(name)
    print("PASS " + name, flush=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width":1280,"height":900})
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.set_default_timeout(10000)
    def settle():
        page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    def navigate(scenario="default"):
        page.goto(url + "?scenario=" + scenario, wait_until="networkidle")
        page.get_by_role("dialog", name="Choose an environment", exact=True).wait_for()
        settle()
        return page.get_by_role("dialog", name="Choose an environment", exact=True)
    def no_local_credentials(dialog):
        assert dialog.locator("input,select,textarea").count() == 0
        assert dialog.get_by_role("button", name="Save profile", exact=True).count() == 0
        assert dialog.get_by_role("button", name="Delete Local", exact=True).count() == 0
        assert dialog.get_by_role("button", name="Choose SSH key file", exact=True).count() == 0
        assert dialog.locator(".ssh-config-section").count() == 0
        assert dialog.get_by_role("button", name="Use Local", exact=True).count() == 1
    try:
        dialog = navigate()
        page.screenshot(path=str(output / "default-local.png"), full_page=True)
        (output / "default-local-dom.html").write_text(page.content())
        no_local_credentials(dialog)
        assert dialog.locator(".saved-profile.selected strong").inner_text() == "Local"
        assert "This computer" in dialog.locator(".saved-profile.selected").inner_text()
        assert page.evaluate("() => window.localUITest.calls.configList.length") == 0
        assert page.evaluate("() => window.localUITest.calls.configResolve.length") == 0
        record("Default Local has no SSH credential/configuration fields or Local deletion/profile-save action")

        local_choice = dialog.locator(".saved-profile").filter(has=page.get_by_text("Local", exact=True)).get_by_role("button")
        ssh_choice = dialog.locator(".saved-profile").filter(has=page.get_by_text("SSH research", exact=True)).get_by_role("button").first
        assert local_choice.get_attribute("aria-pressed") == "true"
        ssh_choice.focus()
        ssh_choice.press("Enter")
        dialog.get_by_label("Hostname or IP", exact=True).wait_for()
        local_choice.focus()
        local_choice.press("Enter")
        dialog.get_by_role("button", name="Use Local", exact=True).wait_for()
        assert local_choice.get_attribute("aria-pressed") == "true"
        assert ssh_choice.get_attribute("aria-pressed") == "false"
        assert local_choice.evaluate("button => document.activeElement === button")
        no_local_credentials(dialog)
        record("Keyboard activation switches SSH back to Local while preserving focus and announcing the selected environment")

        page.evaluate("() => {window.localUITest.holdBeforeConnect();window.localUITest.holdConnect()}")
        dialog.get_by_role("button", name="Use Local", exact=True).evaluate("button => {button.click();button.click();button.click()}")
        opening = dialog.get_by_role("button", name="Opening Local…", exact=True)
        assert opening.is_disabled()
        assert page.evaluate("() => window.localUITest.calls.connect.length") == 0
        assert page.evaluate("() => window.localUITest.calls.beforeConnect") == 1
        page.evaluate("() => window.localUITest.finishBeforeConnect()")
        page.wait_for_function("() => window.localUITest.calls.connect.length === 1")
        record("Pending previous-context barrier prevents native Local connection until released and coalesces repeated clicks")
        # A synthetic click against the disabled button cannot dispatch a second native request.
        opening.evaluate("button => button.click()")
        assert page.evaluate("() => window.localUITest.calls.connect.length") == 1
        page.evaluate("() => window.localUITest.finishConnect()")
        project = page.get_by_role("dialog", name="Select a project", exact=True)
        project.wait_for()
        dialog.wait_for(state="hidden")
        settle()
        state = page.evaluate("() => ({calls:window.localUITest.calls,state:window.localUITest.state(),localId:window.localUITest.local.id})")
        assert state["calls"]["connect"][0]["id"] == state["localId"]
        assert state["calls"]["connect"][0]["transport"] == "local"
        assert len(state["calls"]["connectedCallbacks"]) == 1
        assert state["calls"]["connectedCallbacks"][0]["profile"]["id"] == state["localId"]
        assert state["calls"]["saved"] == [] and state["calls"]["removed"] == []
        assert all(row["profileId"] == state["localId"] for row in state["calls"]["directories"])
        record("Use Local dispatches one canonical native connection and opens the actual project picker from the returned state")

        local_path = "/tmp/local-ui/project with spaces  "
        proof["localProjectPath"] = local_path
        project.get_by_label("Project directory", exact=True).fill(local_path)
        project.get_by_role("button", name="Browse project directory", exact=True).click()
        page.wait_for_function("path => window.localUITest.calls.directories.some(row => row.profileId === window.localUITest.local.id && row.path === path)", arg=local_path)
        settle()
        assert project.get_by_label("Project directory", exact=True).input_value() == local_path
        project.get_by_role("button", name="Open project", exact=True).click()
        project.wait_for(state="hidden")
        settle()
        state = page.evaluate("() => ({calls:window.localUITest.calls,state:window.localUITest.state(),localId:window.localUITest.local.id})")
        assert state["calls"]["directories"][-1] == {"profileId":state["localId"],"path":local_path}
        assert state["calls"]["selected"] == [{"profileId":state["localId"],"path":local_path}]
        assert len(state["calls"]["selectedCallbacks"]) == 1
        assert state["calls"]["selectedCallbacks"][0]["workspace"] == local_path
        assert state["state"]["profile"]["id"] == state["localId"]
        assert state["state"]["workspace"] == local_path
        record("Actual Local project picker preserves two meaningful trailing spaces in browse/select arguments and the returned owned workspace")

        page.get_by_role("button", name="Current Active Environment", exact=True).click()
        environment = page.get_by_role("dialog", name="Current Active Environment", exact=True)
        environment.wait_for()
        assert "Runs on the computer running Life" in environment.inner_text()
        assert environment.locator(".environment-detail-path").text_content() == local_path
        assert "Authentication" not in environment.inner_text()
        assert "SSH config" not in environment.inner_text()
        codex = environment.locator(".environment-provider").filter(has=page.get_by_text("Codex", exact=True))
        claude = environment.locator(".environment-provider").filter(has=page.get_by_text("Claude Code", exact=True))
        assert codex.get_attribute("data-availability") == "available"
        assert "codex-cli 0.162.1" in codex.inner_text()
        assert claude.get_attribute("data-availability") == "missing"
        assert "Not installed" in claude.inner_text()
        page.screenshot(path=str(output / "active-local.png"), full_page=True)
        record("Active Environment identifies the computer running Life and its installed/missing native CLIs without SSH authentication")

        page.evaluate("() => {const test=window.localUITest;test.verifiedState=test.state();test.emit({...test.verifiedState,providerVersionsStatus:'checking',codex:undefined,claude:undefined})}")
        settle()
        assert codex.get_attribute("data-availability") == "unknown"
        assert claude.get_attribute("data-availability") == "unknown"
        assert environment.get_by_text("Not checked", exact=True).count() == 2
        assert environment.get_by_text("Checking installed providers…", exact=True).count() == 2
        assert environment.get_by_text("Available", exact=True).count() == 0
        assert environment.get_by_text("Not installed", exact=True).count() == 0
        page.evaluate("() => {const test=window.localUITest;test.emit({...test.verifiedState,providerVersionsStatus:'failed',codex:undefined,claude:undefined})}")
        settle()
        assert environment.get_by_text("Availability check failed", exact=True).count() == 2
        assert environment.get_by_text("Not checked", exact=True).count() == 2
        assert environment.get_by_text("Available", exact=True).count() == 0
        assert environment.get_by_text("Not installed", exact=True).count() == 0
        page.evaluate("() => window.localUITest.emit(window.localUITest.verifiedState)")
        settle()
        assert codex.get_attribute("data-availability") == "available"
        assert claude.get_attribute("data-availability") == "missing"
        record("Pending or failed native provider discovery stays unknown until verified CLI availability returns")

        dialog = navigate()
        page.evaluate("() => window.localUITest.setFailure({error:'Local process service unavailable'})")
        dialog.get_by_role("button", name="Use Local", exact=True).click()
        assert dialog.get_by_role("alert").inner_text() == "Local process service unavailable"
        no_local_credentials(dialog)
        assert page.get_by_role("dialog", name="Select a project", exact=True).count() == 0
        assert page.evaluate("() => window.localUITest.calls.connectedCallbacks.length") == 0
        record("A rejected Local connection surfaces its exact native error and leaves credential-free Local selected")

        page.evaluate("() => window.localUITest.setFailure({error:'Local initialization failed',returnState:true})")
        dialog.get_by_role("button", name="Use Local", exact=True).click()
        assert dialog.get_by_role("alert").inner_text() == "Local initialization failed"
        no_local_credentials(dialog)
        assert page.evaluate("() => window.localUITest.calls.connectedCallbacks.length") == 0
        record("A returned disconnected Local state cannot be accepted as connected or trigger the project picker")

        dialog = navigate("ssh")
        assert dialog.locator(".saved-profile.selected strong").inner_text() == "SSH research"
        assert dialog.get_by_label("Hostname or IP", exact=True).input_value() == "research.example"
        assert dialog.get_by_label("Username", exact=True).input_value() == "researcher"
        assert dialog.get_by_label("Authentication").input_value() == "key"
        assert dialog.get_by_label("Private key on this computer", exact=True).input_value() == "/fixture/key"
        assert dialog.get_by_role("button", name="Save profile", exact=True).count() == 1
        assert page.evaluate("() => window.localUITest.calls.configList.length") > 0
        page.evaluate("() => window.localUITest.deliverProfiles([{...window.localUITest.local,name:'Local updated'},window.localUITest.ssh])")
        settle()
        assert dialog.locator(".saved-profile.selected strong").inner_text() == "SSH research"
        dialog.get_by_label("Authentication").select_option("password")
        assert dialog.get_by_label("SSH password", exact=True).is_visible()
        assert dialog.get_by_role("button", name="Use Local", exact=True).count() == 0
        record("An explicitly requested SSH environment retains its host/key/password fields and is not replaced by Local profile updates")

        dialog.get_by_label("SSH password", exact=True).fill("fixture-only-password")
        dialog.get_by_role("button", name="Connect machine", exact=True).click()
        project = page.get_by_role("dialog", name="Select a project", exact=True)
        project.wait_for()
        project.get_by_label("Project directory", exact=True).fill("/srv/project  ")
        project.get_by_role("button", name="Browse project directory", exact=True).click()
        page.wait_for_function("() => window.localUITest.calls.directories.some(row => row.profileId === window.localUITest.ssh.id && row.path === '/srv/project')")
        settle()
        assert project.get_by_label("Project directory", exact=True).input_value() == "/srv/project"
        assert page.evaluate("() => window.localUITest.calls.directories.at(-1)") == {"profileId":"ssh-fixture","path":"/srv/project"}
        record("SSH project browsing retains its existing trimmed-path behavior under its own machine owner")

        dialog = navigate("late")
        assert dialog.get_by_role("button", name="Use Local", exact=True).count() == 0
        assert page.evaluate("() => window.localUITest.calls.configList.length") == 0
        page.evaluate("() => window.localUITest.deliverProfiles([window.localUITest.local,window.localUITest.ssh])")
        dialog.get_by_role("button", name="Use Local", exact=True).wait_for()
        settle()
        no_local_credentials(dialog)
        assert dialog.locator(".saved-profile.selected strong").inner_text() == "Local"
        assert page.evaluate("() => window.localUITest.calls.configList.length") == 0
        record("A Local profile arriving after the environment picker opens becomes its credential-free default")

        assert errors == [], errors
        proof["ok"] = True
    except Exception as error:
        proof.update(ok=False,error=str(error),traceback=traceback.format_exc(),renderedText=page.locator("body").inner_text()[:6000])
        page.screenshot(path=str(output / "failure.png"), full_page=True)
        (output / "failure-dom.html").write_text(page.content())
    finally:
        (output / "browser-proof.json").write_text(json.dumps(proof, indent=2))
        browser.close()
if not proof.get("ok"):
    print(json.dumps(proof, indent=2), file=sys.stderr)
    sys.exit(1)
`

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
async function sourceInputs(directory) {
  const result = {}
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await visit(file)
      else result[relative(directory, file)] = hash(await readFile(file))
    }
  }
  await visit(join(directory, 'src'))
  result['tests/local-environment-ui-smoke.cjs'] = hash(await readFile(__filename))
  return result
}

async function run() {
  const root = resolve(__dirname, '..')
  const directory = await mkdtemp(join(tmpdir(), 'life-local-environment-ui-'))
  const evidence = resolve(root, 'output/playwright/local-environment-ui')
  const runDirectory = join(evidence, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(runDirectory, { recursive: true })
  let server
  let proof = {
    ok: false,
    fixture: 'Actual React components with a mock native API',
    upstreamInference: false,
  }
  try {
    const before = await sourceInputs(root)
    const result = await build({
      stdin: {
        resolveDir: root,
        sourcefile: 'local-environment-fixture.tsx',
        loader: 'tsx',
        contents,
      },
      bundle: true,
      jsx: 'automatic',
      outfile: join(directory, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"development"' },
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
      .filter((file) => file.startsWith('src/'))
      .concat('tests/local-environment-ui-smoke.cjs')
      .sort()
    const sourceHashes = Object.fromEntries(inputs.map((file) => [file, before[file]]))
    proof.sourceInputHashes = sourceHashes
    for (const file of inputs)
      assert.equal(
        hash(await readFile(join(root, file))),
        before[file],
        `Source input changed while bundling: ${file}`,
      )
    await writeFile(join(directory, 'browser.py'), automation)
    server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname
        const file = ['fixture.js', 'fixture.css'].find((name) => pathname === '/' + name)
        response.setHeader(
          'Content-Type',
          file?.endsWith('.js')
            ? 'text/javascript'
            : file?.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        )
        response.end(
          file
            ? await readFile(join(directory, file))
            : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script>' +
                bootstrap +
                '</script><script src="/fixture.js"></script>',
        )
      } catch (error) {
        response.statusCode = 500
        response.end(String(error))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    proof.privateLoopbackUrl = url
    const exit = await new Promise((resolve, reject) => {
      const child = spawn('python3', [join(directory, 'browser.py'), url, runDirectory], {
        stdio: 'inherit',
      })
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
    const browserProof = JSON.parse(
      await readFile(join(runDirectory, 'browser-proof.json'), 'utf8'),
    )
    proof = { ...proof, ...browserProof }
    const changed = []
    for (const file of inputs)
      if (hash(await readFile(join(root, file))) !== before[file]) changed.push(file)
    proof.sourceInputsUnchanged = changed.length === 0
    proof.sourceInputsChanged = changed
    assert.deepEqual(changed, [], 'Production source changed during this browser observation')
    assert.equal(exit, 0, 'Local environment browser workflow failed')
    assert.equal(proof.ok, true)
    console.log(JSON.stringify(proof, null, 2))
  } catch (error) {
    proof = { ...proof, ok: false, error: String(error), stack: error.stack }
    throw error
  } finally {
    await writeFile(join(runDirectory, 'proof.json'), JSON.stringify(proof, null, 2))
    await writeFile(
      join(evidence, 'proof.json'),
      JSON.stringify({ ...proof, runDirectory }, null, 2),
    )
    if (server) await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
