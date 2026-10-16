#!/usr/bin/env node
// Exercise the actual production sidebar with large immutable histories.
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, mkdir, readFile, writeFile, rm } = require("node:fs/promises");
const { join, relative, resolve, sep } = require("node:path");
const { tmpdir } = require("node:os");
const { build } = require("./helpers/browser-build.cjs");
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");

async function run() {
  const label = process.argv[2] || "current";
  assert.match(label, /^[a-z0-9-]+$/);
  const optimized = !label.includes("baseline");
  const baselineRevision = optimized
    ? undefined
    : "a1b3facb8bc3c07b1521ed21965f4f8b88acd268";
  const directory = await mkdtemp(join(tmpdir(), "life-sidebar-history-"));
  const output = resolve(
    __dirname,
    "../output/playwright/sidebar-history-performance",
  );
  await mkdir(output, { recursive: true });
  const errors = [];
  let server;
  let browser;
  try {
    await build({
      stdin: {
        resolveDir: resolve(__dirname, ".."),
        sourcefile: "sidebar-history-fixture.tsx",
        loader: "tsx",
        contents: `
          import React, { useEffect, useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { flushSync } from 'react-dom'
          import { SidebarProjects } from './src/renderer/components/SidebarProjects'
          import './src/renderer/styles.css'
          const probes = {roleReads:0,textReads:0,turnReads:0}
          const history = (id, count) => Array.from({length:count}, (_, index) => {
            const role = index % 3 === 0 ? 'user' : index % 3 === 1 ? 'assistant' : 'tool'
            const text = 'Exact history body '+id+' '+index+' '+('Provider output. '.repeat(100))
            return {id:id+':'+index,get turn(){probes.turnReads++;return Math.floor(index/3)+1},
              get role(){probes.roleReads++;return role},get text(){probes.textReads++;return text}}
          })
          const initial = Array.from({length:200}, (_, index) => ({
            id:'thread-'+index,title:'Conversation '+index,profileId:'machine',workspace:'/project',
            provider:index%2?'claude':'codex',messages:history('thread-'+index,1000+((index*127)%500)),
            pending:[],busy:false,turn:1,updatedAt:index+1,mode:'review'
          }))
          const frames=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
          localStorage.setItem('life.sidebar.arrangement.v1',JSON.stringify({provider:'all',status:'all',sort:'messages',group:'none'}))
          function Fixture(){
            const [threads,setThreads]=useState(initial)
            const [activeId,setActiveId]=useState('thread-0')
            const [filtersOpen,setFiltersOpen]=useState(false)
            useEffect(()=>{window.fixture={
              ready:true,probes,reset(){probes.roleReads=0;probes.textReads=0;probes.turnReads=0},
              async stream(count=12){const samples=[];for(let index=0;index<count;index++){
                const started=performance.now();flushSync(()=>setThreads(current=>current.map(thread=>
                  thread.id==='thread-0'?{...thread,messages:[...thread.messages,{id:'stream:'+index,role:'assistant',text:'Live update '+index,turn:1}]}:thread)));
                samples.push(performance.now()-started);await frames()
              }return samples},
              addPrompt(){flushSync(()=>setThreads(current=>current.map(thread=>thread.id==='thread-0'?{...thread,messages:[...thread.messages,{id:'new-user',role:'user',text:'new prompt',turn:2}]}:thread)))},
              appendMatch(){flushSync(()=>setThreads(current=>current.map(thread=>thread.id==='thread-0'?{...thread,messages:[...thread.messages,{id:'new-match',role:'assistant',text:'new-native-search-result',turn:2}]}:thread)))},
              rename(){flushSync(()=>setThreads(current=>current.map(thread=>thread.id==='thread-1'?{...thread,title:'new-native-search-result'}:thread)))},
              async startRun(){flushSync(()=>setThreads(current=>current.map(thread=>thread.id==='thread-0'?{...thread,busy:true,turn:1000,messages:[...thread.messages,{id:'active-user',role:'user',text:'New active turn',turn:1000,createdAt:Date.now()}]}:thread)));await frames()},
              expected(){return [...threads].sort((a,b)=>b.messages.filter(m=>m.role==='user').length-a.messages.filter(m=>m.role==='user').length||b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)).map(thread=>thread.id)},
              select:id=>setActiveId(id)
            }},[threads])
            return <aside className="sidebar" style={{height:'100vh',width:330}}>
              <SidebarProjects threads={threads} profiles={[]} connection={{status:'disconnected'}} activeId={activeId}
                onSelect={thread=>setActiveId(thread.id)} onNewThread={()=>{}} onAddProject={()=>{}} onOpenProfile={()=>{}}
                shortcutModifier="Ctrl" filtersOpen={filtersOpen} onFiltersOpenChange={setFiltersOpen}/>
            </aside>
          }
          createRoot(document.getElementById('root')).render(<Fixture/>);
        `,
      },
      bundle: true,
      jsx: "automatic",
      outfile: join(directory, "fixture.js"),
      loader: { ".woff2": "dataurl", ".woff": "dataurl", ".svg": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
      minify: true,
      logLevel: "silent",
      plugins: baselineRevision
        ? [
            {
              name: "sidebar-history-before-cache",
              setup(plugin) {
                plugin.onLoad(
                  {
                    filter:
                      /[\\/]src[\\/]renderer[\\/](sidebar-ordering\.ts|components[\\/](SidebarProjects|SidebarThread|ThreadRunStatus)\.tsx)$/,
                  },
                  ({ path }) => ({
                    contents: execFileSync(
                      "git",
                      [
                        "show",
                        baselineRevision +
                          ":" +
                          relative(resolve(__dirname, ".."), path)
                            .split(sep)
                            .join("/"),
                      ],
                      { cwd: resolve(__dirname, ".."), encoding: "utf8" },
                    ),
                    loader: path.endsWith(".tsx") ? "tsx" : "ts",
                  }),
                );
              },
            },
          ]
        : [],
    });
    server = createServer(async (request, response) => {
      const name = ["fixture.js", "fixture.css"].find(
        (name) => request.url === "/" + name,
      );
      response.setHeader(
        "Content-Type",
        name?.endsWith(".js")
          ? "text/javascript"
          : name
            ? "text/css"
            : "text/html",
      );
      response.end(
        name
          ? await readFile(join(directory, name))
          : '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      );
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 2 });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.waitForFunction(() => window.fixture?.ready);
    const rows = () =>
      page
        .locator("[data-thread-row]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.threadRow));
    assert.deepEqual(
      await rows(),
      await page.evaluate(() => window.fixture.expected()),
    );
    await page.evaluate(() => window.fixture.reset());
    const samples = await page.evaluate(() => window.fixture.stream());
    const sortReads = await page.evaluate(() => ({ ...window.fixture.probes }));
    if (optimized)
      assert.ok(
        sortReads.roleReads < 16000,
        "Unchanged histories were rescanned during streamed sort",
      );
    assert.deepEqual(
      await rows(),
      await page.evaluate(() => window.fixture.expected()),
    );
    await page.evaluate(() => window.fixture.addPrompt());
    assert.deepEqual(
      await rows(),
      await page.evaluate(() => window.fixture.expected()),
    );
    const search = page.getByRole("searchbox", {
      name: "Search projects and threads",
    });
    await search.fill("Exact history body");
    await page.waitForFunction(
      () =>
        document.querySelector(".project-list").getAttribute("aria-busy") ===
        "false",
    );
    assert.equal(await page.locator("[data-thread-row]").count(), 200);
    await page.evaluate(() => window.fixture.reset());
    const searchSamples = await page.evaluate(() => window.fixture.stream());
    const searchReads = await page.evaluate(() => ({
      ...window.fixture.probes,
    }));
    if (optimized)
      assert.ok(
        searchReads.textReads < 250,
        "Unchanged histories were searched again during streaming",
      );
    await search.fill("new-native-search-result");
    await page.getByText("No matching projects or threads.").waitFor();
    await page.evaluate(() => window.fixture.appendMatch());
    await page.locator('[data-thread-row="thread-0"]').waitFor();
    await page.evaluate(() => window.fixture.rename());
    await page.locator('[data-thread-row="thread-1"]').waitFor();
    assert.equal(await page.locator("[data-thread-row]").count(), 2);
    await search.fill("");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-thread-row]").length === 200,
    );
    await page.evaluate(() => window.fixture.startRun());
    const runStatus = page.locator(
      '.thread-card-shell:has([data-thread-row="thread-0"]) .thread-card-run-status',
    );
    await runStatus.waitFor();
    await page.evaluate(() => window.fixture.reset());
    await page.waitForFunction(() =>
      document
        .querySelector(
          '.thread-card-shell:has([data-thread-row="thread-0"]) .thread-card-run-status',
        )
        .textContent.includes("2s"),
    );
    const clockReads = await page.evaluate(() => ({
      ...window.fixture.probes,
    }));
    if (optimized)
      assert.equal(
        clockReads.turnReads,
        0,
        "Elapsed time tick rescanned the complete transcript",
      );
    assert.deepEqual(errors, []);
    const stats = (samples) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
        p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      };
    };
    const proof = {
      label,
      baselineRevision,
      fixture: {
        threads: 200,
        messages: 248800,
        messagesPerThread: "1000–1495",
        productionReact: true,
        cpuThrottle: 2,
      },
      sort: { ...stats(samples), ...sortReads },
      search: { ...stats(searchSamples), ...searchReads },
      clock: clockReads,
      checks: [
        "Exact conversation-turn ordering",
        "New prompt updates count and ordering",
        "Streamed message invalidates search",
        "Native title invalidates search",
        "Search clears without hiding history",
        optimized
          ? "Elapsed run time advances without rescanning unchanged history"
          : "Elapsed run time advances; baseline history scans recorded",
      ],
      errors,
    };
    await writeFile(
      join(output, label + ".json"),
      JSON.stringify(proof, null, 2) + "\n",
    );
    console.log(JSON.stringify(proof, null, 2));
  } finally {
    await browser?.close();
    if (server) await new Promise((ready) => server.close(ready));
    await rm(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
