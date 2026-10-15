#!/usr/bin/env python3
"""Actual Chromium checks against the production React Studio hook.

The native bridge is a deterministic ledger stand-in; no upstream inference occurs.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


URL, INITIALIZE, OUTPUT = sys.argv[1:]
output = Path(OUTPUT)
checks = []
errors = []


def wait(page, expression):
    page.wait_for_function(expression, timeout=20000)


def snapshot(page):
    return page.evaluate("() => JSON.parse(JSON.stringify(window.studio.active))")


def state(page):
    return page.evaluate("""() => {
      const {owners,starts,reservations,checkpoints,...metadata} = window.studioNativeFixture.state;
      return {
        ...metadata,
        starts:starts.map(input=>({sessionId:input.sessionId,localTurn:input.localTurn,
          remoteId:input.remoteId,...(Object.hasOwn(input,'workspace') ? {workspace:input.workspace} : {}),promptLength:input.prompt.length,
          prompt:input.prompt.length < 4000 ? input.prompt : undefined})),
        reservations:reservations.map(owner=>({transportId:owner.transportId,
          ownerGeneration:owner.ownerGeneration,clientRecovery:{nativeIteration:owner.clientRecovery.nativeIteration},
          originalInput:{workspace:owner.originalInput.workspace,
            prompt:owner.originalInput.prompt.length < 4000 ? owner.originalInput.prompt : undefined}})),
        checkpoints:checkpoints.map(checkpoint=>({sessionId:checkpoint.sessionId,
          projectionAdmissions:checkpoint.projectionAdmissions,
          planner:{phase:checkpoint.planner.phase,nativeIteration:checkpoint.planner.nativeIteration,
            action:checkpoint.planner.action && {kind:checkpoint.planner.action.kind,status:checkpoint.planner.action.status},
            terminal:checkpoint.planner.terminal,applied:checkpoint.planner.applied,
            preparedCache:checkpoint.planner.preparedCache}})),
      };
    }""")


def check(name, evidence):
    checks.append({"name": name, "evidence": evidence})


def close_context(context, page, name):
    if sys.exc_info()[0] is not None:
        try:
            diagnostic = page.evaluate("""() => ({
              stage:window.studio?.active?.stage, feedback:window.studio?.feedback,
              thread:window.studio?.active?.thread && {
                id:window.studio.active.id, busy:window.studio.active.thread.busy,
                recoveryStatus:window.studio.active.thread.nativeRecoveryStatus,
                owner:window.studio.active.thread.nativeRecoveryOwner,
                cursor:window.studio.active.thread.nativeRecovery,
                messages:window.studio.active.thread.messages.map(message => ({
                  id:message.id,role:message.role,length:message.text?.length,
                  finishStatus:message.finishStatus,finishedAt:message.finishedAt,
                })),
              },
              native:window.studioNativeFixture && {
                starts:window.studioNativeFixture.state.starts.length,
                actions:window.studioNativeFixture.state.actions.map(action => ({
                  kind:action.request.kind,status:action.result.status,
                })),
                acknowledgments:window.studioNativeFixture.state.acknowledgments,
                attempts:window.studioNativeFixture.state.acknowledgmentAttempts,
                promotions:window.studioNativeFixture.state.preparedPromotions,
                owners:Object.values(window.studioNativeFixture.state.owners).map(owner => ({
                  transportId:owner.transportId,generation:owner.ownerGeneration,
                  throughEventRevision:owner.throughEventRevision,
                  planner:{phase:owner.clientRecovery.phase,iteration:owner.clientRecovery.nativeIteration,
                    action:owner.clientRecovery.action?.kind,status:owner.clientRecovery.action?.status,
                    parts:owner.clientRecovery.parts?.map(part=>({itemId:part.itemId,length:part.text.length})),
                    applied:owner.clientRecovery.applied,preparedCache:owner.clientRecovery.preparedCache},
                })),
              },
            })""")
            (output / ("failure-" + name + ".json")).write_text(json.dumps(diagnostic, indent=2, ensure_ascii=False))
            page.screenshot(path=str(output / ("failure-" + name + ".png")))
        except Exception:
            pass
    context.close()


def new_page(browser):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_init_script(path=INITIALIZE)
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    wait(page, "() => Boolean(window.studio?.active)")
    # The initial native reconciliation is asynchronous, and the UI submit gate is real.
    wait(page, "() => window.studio.active.thread.nativeRecoveryStatus !== 'recovering'")
    return context, page


def submit(page, request):
    page.get_by_role("textbox", name="Customization request").fill(request)
    page.get_by_role("button", name="Send customization").click()
    wait(page, "() => window.studioNativeFixture.state.starts.length > 0")
    wait(page, "() => window.studio.active.thread.nativeRecoveryOwner?.transportId.startsWith('native-transport:')")
    emit(page, {"type": "session", "remoteId": page.evaluate("() => window.studioNativeFixture.owner().remoteId")})
    wait(page, "() => window.studio.active.thread.remoteId === window.studioNativeFixture.owner().remoteId")


def emit(page, event, overrides=None):
    return page.evaluate("([event, overrides]) => window.studioNativeFixture.emit(event, overrides)",
                         [event, overrides or {}])


def source_proposal(summary="Exact source feature"):
    return "<life-source>" + json.dumps({
        "baseRevision": 7,
        "summary": summary,
        "files": [{"path": "src/renderer/fixture-feature.tsx",
                   "content": 'export const feature = "after Ω 😀"\r\n'}],
    }, ensure_ascii=False) + "</life-source>"


def reservation_generation(browser):
    context, page = new_page(browser)
    try:
        submit(page, "  Implement a precise source feature. Ω 😀\r\n  ")
        native = state(page)
        owner = page.evaluate("() => window.studioNativeFixture.owner()")
        assert len(native["reservations"]) == 1
        reservation = native["reservations"][0]
        assert reservation["transportId"] != owner["transportId"]
        assert reservation["ownerGeneration"] < owner["ownerGeneration"]
        assert reservation["clientRecovery"]["nativeIteration"] == 0
        assert owner["clientRecovery"]["nativeIteration"] == 1
        native_workspace = owner["originalInput"]["workspace"]
        assert native_workspace.startswith("/home/fixture/.life/customization/")
        assert native_workspace != "/srv/selected-project"
        assert "workspace" not in owner["clientRecovery"]["input"]
        assert "workspace" not in native["starts"][0]
        assert reservation["originalInput"]["workspace"] == native_workspace
        assert snapshot(page)["thread"]["workspace"] == native_workspace
        recover_consumers = [consumer for recovery in native["recoveries"] for consumer in recovery["consumers"] if consumer["sessionId"] == owner["sessionId"]]
        assert any(consumer.get("workspace") == native_workspace for consumer in recover_consumers)
        assert all(consumer.get("workspace") in (None, native_workspace) for consumer in recover_consumers)
        assert native["actions"][0]["request"]["ownerGeneration"] == reservation["ownerGeneration"]
        assert native["actions"][0]["request"]["transportId"] == reservation["transportId"]
        assert native["actions"][0]["request"]["kind"] == "source-read"
        assert native["actions"][0]["result"]["receipt"]["source"]["revision"] == 7
        emit(page, {"type": "text", "itemId": "new-root", "text": "The new native generation owns this answer."})
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studio.active.stage === 'complete'")
        wait(page, "() => window.studioNativeFixture.owner().clientRecovery.phase === 'finished'")
        final = page.evaluate("() => window.studioNativeFixture.owner().clientRecovery")
        assert final["parts"] == [{"itemId": "new-root", "text": "The new native generation owns this answer."}]
        assert final["applied"]["transportId"] == owner["transportId"]
        assert final["terminal"]["stage"] == "complete"
        assert native["starts"][0]["prompt"] == native["reservations"][0]["originalInput"]["prompt"]
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        assert page.evaluate("() => window.studioNativeFixture.stored().find(row=>row.id === window.studio.active.id).thread.workspace") == native_workspace
        assert "workspace" not in page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.input")
        page.screenshot(path=str(output / "reservation-generation.png"))
        check("preparing reservation is rebound to the actual native start generation", {
            "reservationGeneration": reservation["ownerGeneration"],
            "startGeneration": owner["ownerGeneration"],
            "sourceReadReceipt": True,
            "exactOriginalPrompt": native["starts"][0]["prompt"] == native["reservations"][0]["originalInput"]["prompt"],
            "selectedProjectIgnored": True, "nativeStagingWorkspace": native_workspace,
            "originalPlannerWorkspaceOmissionPreserved": True,
        })
    finally:
        close_context(context, page, "reservation-generation")


def delayed_generation_and_children(browser):
    context, page = new_page(browser)
    try:
        submit(page, "Implement the next exact source feature.")
        old = page.evaluate("() => window.studioNativeFixture.owner()")
        page.evaluate("() => { window.studioNativeFixture.state.holdStarts = true; window.studioNativeFixture.save() }")
        emit(page, {"type": "text", "itemId": "read-request", "text": '<life-source-read>{"paths":["src/renderer/fixture-feature.tsx"]}</life-source-read>'})
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studioNativeFixture.state.starts.length === 2")
        assert state(page)["starts"][0]["localTurn"] == state(page)["starts"][1]["localTurn"]
        assert state(page)["starts"][1]["remoteId"] == old["remoteId"]
        forged_current_parts = source_proposal("This old response must never apply")
        emit(page, {"type": "text", "itemId": "old-proposal", "text": forged_current_parts})
        emit(page, {"type": "complete", "status": "completed"})
        emit(page, {"type": "text", "agentId": "old-child", "itemId": "child-proposal", "text": forged_current_parts})
        emit(page, {"type": "complete", "agentId": "old-child", "status": "completed"})
        before_release = state(page)
        assert len(before_release["starts"]) == 2
        assert not any(action["request"]["kind"] == "source-apply" for action in before_release["actions"])
        assert snapshot(page)["stage"] == "planning"
        page.evaluate("() => window.studioNativeFixture.releaseStarts()")
        wait(page, "() => window.studioNativeFixture.owner().ownerGeneration > window.studioNativeFixture.state.reservations[0].ownerGeneration + 1")
        wait(page, "() => window.studio.active.thread.nativeRecoveryOwner.ownerGeneration === window.studioNativeFixture.owner().ownerGeneration")
        new = page.evaluate("() => window.studioNativeFixture.owner()")
        assert new["ownerGeneration"] > old["ownerGeneration"]
        assert snapshot(page)["stage"] == "planning"
        assert snapshot(page)["thread"]["busy"] is True
        emit(page, {"type": "text", "agentId": "current-child", "itemId": "current-child-proposal", "text": forged_current_parts})
        emit(page, {"type": "complete", "agentId": "current-child", "status": "completed"})
        assert snapshot(page)["stage"] == "planning"
        assert not any(action["request"]["kind"] == "source-apply" for action in state(page)["actions"])
        emit(page, {"type": "text", "itemId": "current-result", "text": "Current root answer only."})
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studioNativeFixture.owner().clientRecovery.phase === 'finished'")
        final = page.evaluate("() => window.studioNativeFixture.owner().clientRecovery")
        assert final["parts"] == [{"itemId": "current-result", "text": "Current root answer only."}]
        assert final["repairs"] == 0
        assert len(state(page)["starts"]) == 2
        assert not any(action["request"]["kind"] == "source-apply" for action in state(page)["actions"])
        page.screenshot(path=str(output / "held-native-generation.png"))
        check("delayed old root completion and child events cannot own a held new iteration", {
            "sameLocalTurn": True, "oldGeneration": old["ownerGeneration"],
            "newGeneration": new["ownerGeneration"], "providerStarts": 2,
            "currentParts": final["parts"], "sourceApplies": 0, "repairs": 0,
        })
    finally:
        close_context(context, page, "delayed-generation")


def committed_source_quota(browser):
    context, page = new_page(browser)
    try:
        page.evaluate(r"""() => {
          const request = '  Implement the exact Unicode source feature.\r\n' + '界😀\r\n'.repeat(190000) + '\tEND  ';
          window.expectedLargePrompt = request;
          window.studioNativeFixture.state.failAfterApply = true;
          window.studioNativeFixture.save();
          void window.studio.submit(request);
        }""")
        wait(page, "() => window.studioNativeFixture.state.starts.length === 1")
        wait(page, "() => window.studio.active.thread.nativeRecoveryOwner?.transportId.startsWith('native-transport:')")
        emit(page, {"type": "session", "remoteId": page.evaluate("() => window.studioNativeFixture.owner().remoteId")})
        prompt_proof = page.evaluate("""() => ({
          characters: window.expectedLargePrompt.length,
          nativeExact: window.studioNativeFixture.state.starts[0].prompt === window.expectedLargePrompt,
          userExact: window.studio.active.thread.messages.find(message => message.role === 'user').text === window.expectedLargePrompt,
        })""")
        assert 900000 < prompt_proof["characters"] <= 1000000
        assert prompt_proof["nativeExact"] and prompt_proof["userExact"]
        emit(page, {"type": "text", "itemId": "source", "text": source_proposal()})
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studio.feedback.includes('The source build passed. Life is reconciling')")
        native = state(page)
        owner = page.evaluate("() => { const owner=window.studioNativeFixture.owner(); return { clientRecovery:{action:owner.clientRecovery.action,repairs:owner.clientRecovery.repairs} } }")
        applied = [action for action in native["actions"] if action["request"]["kind"] == "source-apply"]
        assert len(applied) == 1
        assert applied[0]["result"]["status"] == "succeeded"
        assert owner["clientRecovery"]["action"]["kind"] == "apply-source"
        assert owner["clientRecovery"]["action"]["status"] == "succeeded"
        assert owner["clientRecovery"]["action"]["receipt"]["snapshot"]["revision"] == 8
        assert page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.request === window.studioNativeFixture.state.starts[0].prompt")
        assert owner["clientRecovery"]["repairs"] == 0
        assert len(native["starts"]) == 1
        assert native["legacyPendingWrites"] == 0
        assert native["legacyApply"] == 0
        assert native["legacyReload"] == 0
        assert len(native["historyFailures"]) > 0
        assert all(failure["committedSourceApplies"] == 1 for failure in native["historyFailures"])
        assert not any(action["request"]["kind"] == "reload" for action in native["actions"])
        assert page.evaluate("() => window.studio.active.thread.nativeRecoveryStatus") == "unknown"
        page.screenshot(path=str(output / "committed-source-quota.png"))
        page.reload()
        page.wait_for_load_state("networkidle")
        wait(page, "() => window.studio.feedback.includes('source build passed') && window.studio.active.thread.nativeRecoveryStatus === 'unknown'")
        recovered = page.evaluate("() => { const owner=window.studioNativeFixture.owner(); return { clientRecovery:{action:owner.clientRecovery.action} } }")
        assert recovered["clientRecovery"]["action"]["kind"] == "apply-source"
        assert recovered["clientRecovery"]["action"]["status"] == "succeeded"
        assert page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.request === window.studioNativeFixture.state.starts[0].prompt")
        restored_native = state(page)
        assert len(restored_native["starts"]) == 1
        assert len([action for action in restored_native["actions"] if action["request"]["kind"] == "source-apply"]) == 1
        assert restored_native["legacyPendingWrites"] == 0
        assert not any(action["request"]["kind"] == "reload" for action in restored_native["actions"])
        assert page.evaluate("() => window.studio.active.thread.messages.find(message => message.role === 'user')?.text === window.studioNativeFixture.state.starts[0].prompt")
        check("large exact Unicode prompt survives a committed source build and subsequent history quota failure", {
            **prompt_proof, "providerStarts": 1, "nativeApplyReceipts": 1,
            "legacyPendingWrites": 0, "repairStarts": 0, "committedRevision": 8,
            "pausedForRecovery": True, "committedReceiptSurvivedRendererReload": True,
        })
    finally:
        close_context(context, page, "committed-source-quota")


def repeated_terminal_restore(browser):
    for label, stage, error, discarded in [
        ("failed", "failed", "Exact native terminal failure Ω\r\n", False),
        ("interrupted", "interrupted", "Exact interrupted diagnostic 😀\r\n", False),
        ("discarded", "complete", None, True),
    ]:
        context, page = new_page(browser)
        try:
            if discarded:
                page.evaluate("() => window.studio.setAutoApply(false)")
                wait(page, "() => window.studio.autoApply === false")
            submit(page, "Keep the owned original terminal turn.")
            if discarded:
                emit(page, {"type": "text", "itemId": "terminal-response", "text": source_proposal("Discard this genuine review proposal")})
                emit(page, {"type": "complete", "status": "completed"})
                wait(page, "() => window.studio.active.stage === 'review' && Boolean(window.studio.active.proposal) && window.studioNativeFixture.owner().clientRecovery.phase === 'review'")
            else:
                emit(page, {"type": "text", "itemId": "terminal-response", "text": "Partial original output Ω."})
            through_revision = page.evaluate("() => window.studioNativeFixture.owner().throughEventRevision")
            page.evaluate("() => window.__lifeFlushStudioHistory()")
            page.wait_for_function("revision => window.studioNativeFixture.state.acknowledgments.some(receipt => receipt.throughEventRevision === revision)", arg=through_revision, timeout=20000)
            terminal = {"stage": stage, "finishedAt": 1700000000500}
            if error is not None:
                terminal.update({"error": error, "errorMessageId": "native-terminal:" + label})
            if discarded:
                terminal["discarded"] = True
                terminal["finishedAt"] = next(message for message in snapshot(page)["thread"]["messages"] if message["role"] == "user")["finishedAt"]
                assert page.evaluate("() => window.studioNativeFixture.stored().some(session => Boolean(session.proposal))")
            page.evaluate("""terminal => {
              const owner = window.studioNativeFixture.owner();
              owner.status = 'idle';
              owner.clientRecovery = {
                ...owner.clientRecovery, phase:'finished', finishing:true, action:undefined,
                terminal,
                applied:{transportId:owner.transportId,throughEventRevision:owner.throughEventRevision},
              };
              window.studioNativeFixture.replaceOwner(owner);
            }""", terminal)
            results = []
            for _ in range(2):
                page.reload()
                page.wait_for_load_state("networkidle")
                page.wait_for_function("""terminal => window.studio.active?.stage === terminal.stage &&
                  !window.studio.active.thread.busy &&
                  window.studio.active.thread.messages.find(message => message.role === 'user')?.finishedAt === terminal.finishedAt
                """, arg=terminal, timeout=20000)
                current = snapshot(page)
                assert current["stage"] == stage
                user = next(message for message in current["thread"]["messages"] if message["role"] == "user")
                assert user["finishedAt"] == terminal["finishedAt"]
                assert user["finishStatus"] == (stage if stage != "complete" else "completed")
                diagnostic = [message for message in current["thread"]["messages"] if message["role"] == "error"]
                if error:
                    assert len(diagnostic) == 1
                    assert diagnostic[0]["text"] == error
                    assert diagnostic[0]["id"] == terminal["errorMessageId"]
                    assert diagnostic[0]["createdAt"] == terminal["finishedAt"]
                else:
                    assert diagnostic == []
                if discarded:
                    assert current.get("proposal") is None
                assert len(state(page)["starts"]) == 1
                assert page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.terminal") == terminal
                results.append({"stage": current["stage"], "errors": len(diagnostic), "finishedAt": user["finishedAt"]})
            check("native terminal " + label + " survives two renderer restores without relabeling or duplicate diagnostics", results)
        finally:
            close_context(context, page, "terminal-" + label)


def reconnect_partial_cursor(browser):
    context, page = new_page(browser)
    try:
        submit(page, "Implement a source feature through a reconnect.")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        page.evaluate("() => { window.studioNativeFixture.state.holdAcknowledgments = true; window.studioNativeFixture.state.failHistory = true; window.studioNativeFixture.save() }")
        response = source_proposal("Reconnect exact partial output")
        midpoint = len(response) // 2
        first = emit(page, {"type": "text", "itemId": "partial", "text": response[:midpoint]})
        owner = page.evaluate("() => window.studioNativeFixture.owner()")
        assert owner["acceptedAppliedRevision"] < first["nativeRecovery"]["revision"]
        last_accepted = owner["acceptedAppliedRevision"]
        page.evaluate("event => { window.studioNativeFixture.state.recoveryReplay.push(event); window.studioNativeFixture.save() }", first)
        recoveries = len(state(page)["recoveries"])
        page.evaluate("() => window.fixtureConnection('disconnected')")
        page.wait_for_function("count => window.studioNativeFixture.state.recoveries.length > count", arg=recoveries)
        recoveries = len(state(page)["recoveries"])
        page.evaluate("() => window.fixtureConnection('connected')")
        page.wait_for_function("count => window.studioNativeFixture.state.recoveries.length > count", arg=recoveries)
        wait(page, "() => window.studio.active.thread.nativeRecoveryStatus === 'running'")
        assert page.evaluate("() => window.studioNativeFixture.owner().acceptedAppliedRevision") < first["nativeRecovery"]["revision"]
        assert state(page)["preparedPromotions"] == []
        emit(page, {"type": "text", "itemId": "partial", "text": response[:midpoint]}, first["nativeRecovery"])
        page.evaluate("() => { window.studioNativeFixture.state.failHistory = false; window.studioNativeFixture.save() }")
        emit(page, {"type": "text", "itemId": "partial", "text": response[midpoint:]})
        page.evaluate("() => window.studioNativeFixture.releaseAcknowledgments()")
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studioNativeFixture.state.actions.some(action => action.request.kind === 'reload')")
        native = state(page)
        applies = [action for action in native["actions"] if action["request"]["kind"] == "source-apply"]
        assert len(applies) == 1
        assert applies[0]["request"]["intent"]["patch"]["summary"] == "Reconnect exact partial output"
        assert len(native["starts"]) == 1
        owner = page.evaluate("() => window.studioNativeFixture.owner()")
        assert owner["clientRecovery"]["parts"] == [{"itemId": "partial", "text": response}]
        assert owner["clientRecovery"]["repairs"] == 0
        assert native["replayedDuringRecovery"] == 1
        check("same renderer retains its private parts cursor beyond the last history ACK across reconnect", {
            "firstRevision": first["nativeRecovery"]["revision"],
            "lastAcceptedBeforeReconnect": last_accepted, "nativeApplyCount": 1,
            "providerStarts": 1, "exactResponse": True, "repairs": 0,
            "replayDeliveredBeforeOwnerReturn": True,
        })
    finally:
        close_context(context, page, "reconnect-cursor")


def cache_write_before_ack(browser, corrupt=False):
    context, page = new_page(browser)
    try:
        submit(page, "Preserve this exact native turn through the cache commit crash. Ω 😀\r\n")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        page.evaluate("() => { window.studioNativeFixture.state.holdAcknowledgments = true; window.studioNativeFixture.save() }")
        original = emit(page, {"type": "text", "itemId": "cache-tail", "text": "Exact partial cache tail Ω 😀\r\n"})
        revision = original["nativeRecovery"]["revision"]
        page.evaluate("() => { void window.__lifeFlushStudioHistory().catch(() => {}) }")
        page.wait_for_function("revision => window.studioNativeFixture.state.acknowledgmentAttempts.some(receipt => receipt.throughEventRevision === revision)", arg=revision, timeout=20000)
        native = state(page)
        owner = page.evaluate("() => window.studioNativeFixture.owner()")
        proof = owner["clientRecovery"]["preparedCache"]
        assert proof["throughEventRevision"] == revision
        assert proof["transportId"] == owner["transportId"]
        assert proof["snapshotToken"] == owner["snapshotToken"]
        assert proof["ownerGeneration"] == owner["ownerGeneration"]
        assert not any(receipt["throughEventRevision"] == revision for receipt in native["acknowledgments"])
        assert any(proof["snapshotId"] in write["preparedSnapshotIds"] for write in native["cacheWrites"])
        hash_matches = page.evaluate("""async () => {
          const owner = window.studioNativeFixture.owner();
          const row = window.studioNativeFixture.stored().find(row => row.id === owner.sessionId);
          const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(row)));
          const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
          return hash === owner.clientRecovery.preparedCache.hash;
        }""")
        assert hash_matches
        if corrupt:
            page.evaluate("""() => {
              const rows = window.studioNativeFixture.stored();
              const row = rows.find(row => row.id === window.studio.active.id);
              row.thread.messages.find(message => message.role === 'user').text += ' altered cache row';
              localStorage.setItem('life.studio.sessions.v1',JSON.stringify(rows));
            }""")
        # The old document has a pending ACK RPC. Its actual cache write and native
        # prepare are durable, while acknowledgment remains absent when it disappears.
        page.evaluate("() => { window.studioNativeFixture.state.holdAcknowledgments = false; window.studioNativeFixture.save() }")
        page.reload()
        page.wait_for_load_state("networkidle")
        if corrupt:
            wait(page, "() => window.studio.active.thread.nativeRecoveryStatus === 'unknown'")
            assert state(page)["preparedPromotions"] == []
            assert not any(receipt["throughEventRevision"] == revision for receipt in state(page)["acknowledgments"])
            assert page.evaluate("() => window.studio.active.thread.messages.find(message => message.role === 'user').text.endsWith(' altered cache row')")
            assert page.evaluate("() => window.studio.submit('Do not automatically resend this request.')") is False
            counts = {"starts": len(state(page)["starts"]), "actions": len(state(page)["actions"])}
            emit(page, {"type": "text", "itemId": "unverified-proposal", "text": source_proposal("Do not apply while recovery is unverified")})
            emit(page, {"type": "complete", "status": "completed"})
            assert len(state(page)["starts"]) == counts["starts"]
            assert len(state(page)["actions"]) == counts["actions"]
            assert snapshot(page)["thread"]["nativeRecoveryStatus"] == "unknown"
            check("changed raw cache row cannot promote the private pre-write claim after a crash", {
                "exactInitialHash": True, "preparedRevision": revision,
                "promotions": 0, "providerStarts": len(state(page)["starts"]),
                "mutationPaused": True,
            })
        else:
            wait(page, "() => window.studioNativeFixture.state.preparedPromotions.length === 1 && window.studio.active.thread.nativeRecoveryStatus === 'running'")
            promoted = state(page)["preparedPromotions"][0]
            assert promoted["snapshotId"] == proof["snapshotId"]
            assert promoted["hash"] == proof["hash"]
            assert promoted["snapshotToken"] == proof["snapshotToken"]
            assert promoted["ownerGeneration"] == proof["ownerGeneration"]
            assert promoted["throughEventRevision"] == revision
            assert page.evaluate("() => window.studio.active.thread.messages.find(message => message.role === 'user').text === window.studioNativeFixture.state.starts[0].prompt")
            assert page.evaluate("() => window.studio.active.thread.messages.filter(message => message.role === 'assistant' && message.text === 'Exact partial cache tail Ω 😀\\r\\n').length") == 1
            emit(page, {"type": "text", "itemId": "cache-tail", "text": original["text"]}, original["nativeRecovery"])
            assert page.evaluate("() => window.studio.active.thread.messages.filter(message => message.role === 'assistant' && message.text === 'Exact partial cache tail Ω 😀\\r\\n').length") == 1
            check("actual cache commit followed by a crash before ACK restores only the exact prepared raw row", {
                "exactInitialHash": True, "preparedRevision": revision,
                "promotions": 1, "historicalTuplePreserved": True,
                "providerStarts": len(state(page)["starts"]), "partialOutputCopies": 1,
            })
        assert len(state(page)["starts"]) == 1
        assert not any(action["request"]["kind"] == "source-apply" for action in state(page)["actions"])
    finally:
        close_context(context, page, "cache-commit-" + ("corrupt" if corrupt else "exact"))


def offline_settings_after_native(browser):
    context, page = new_page(browser)
    try:
        submit(page, "Finish this original native customization turn.")
        emit(page, {"type": "text", "itemId": "native-done", "text": "The native turn is complete."})
        emit(page, {"type": "complete", "status": "completed"})
        wait(page, "() => window.studio.active.stage === 'complete' && window.studioNativeFixture.owner().clientRecovery.phase === 'finished'")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        previous = state(page)
        original_owner = page.evaluate("() => window.studioNativeFixture.owner()")
        page.evaluate("() => window.fixtureConnection('disconnected')")
        wait(page, "() => window.studio.active.thread.nativeRecoveryStatus === 'idle'")
        local_request = "  use light theme\r\n\t  "
        assert page.evaluate("request => window.studio.submit(request)", local_request) is True
        wait(page, "() => window.studio.active.thread.turn === 2 && window.studio.active.stage === 'complete'")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        local = snapshot(page)
        local_users = [message for message in local["thread"]["messages"] if message["role"] == "user" and message["turn"] == 2]
        assert len(local_users) == 1
        local_user = local_users[0]
        assert local_user["text"] == local_request
        assert local_user["finishStatus"] == "completed"
        assert local_user["finishedAt"] >= local_user["createdAt"]
        assert state(page)["localSettings"] == [{"theme": "light"}]
        assert len(state(page)["starts"]) == len(previous["starts"]) == 1
        assert len(state(page)["actions"]) == len(previous["actions"])
        local_proof = page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.preparedCache")
        assert local_proof["hash"] != original_owner["clientRecovery"]["preparedCache"]["hash"]
        assert local_proof["throughEventRevision"] == original_owner["throughEventRevision"]
        assert page.evaluate("() => !JSON.stringify(window.studioNativeFixture.stored()).includes('deliveryToken')")
        page.reload()
        page.wait_for_load_state("networkidle")
        wait(page, "() => window.studio.active.thread.turn === 2 && window.studio.active.thread.nativeRecoveryStatus === 'idle'")
        restored = snapshot(page)
        restored_users = [message for message in restored["thread"]["messages"] if message["role"] == "user" and message["turn"] == 2]
        assert len(restored_users) == 1
        restored_user = restored_users[0]
        assert restored_user == local_user
        assert restored["request"] == local_request
        assert restored["stage"] == "complete"
        assert len(state(page)["starts"]) == 1
        assert len(state(page)["actions"]) == len(previous["actions"])
        assert state(page)["localSettings"] == [{"theme": "light"}]
        assert page.evaluate("() => window.studioNativeFixture.owner().clientRecovery.terminal.finishedAt") == original_owner["clientRecovery"]["terminal"]["finishedAt"]
        check("offline local settings after a completed native turn retains its exact new user and timestamps across reload", {
            "providerStarts": 1, "localSettingsApplies": 1, "newNativeActions": 0,
            "newTurn": 2, "userIdentityAndTimesPreserved": True,
            "privatePreparedHashRenewed": True, "priorTerminalDidNotRelabelLocalTurn": True,
        })
    finally:
        close_context(context, page, "offline-settings-after-native")


def cache_hash_during_native_completion(browser):
    context, page = new_page(browser)
    try:
        submit(page, "Finish exactly while the Studio cache hash is pending.")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        checkpoint_count = len(state(page)["checkpoints"])
        page.evaluate("""() => {
          const original = crypto.subtle.digest.bind(crypto.subtle);
          let armed = true;
          crypto.subtle.digest = async (...args) => {
            if (armed) {
              armed = false;
              window.cacheHashBlocked = true;
              await new Promise(resolve => window.releaseCacheHash = resolve);
            }
            return original(...args);
          };
        }""")
        emit(page, {"type": "text", "itemId": "hash-tail", "text": "Exact completion while hashing Ω 😀."})
        page.evaluate("() => { void window.__lifeFlushStudioHistory().catch(() => {}) }")
        wait(page, "() => window.cacheHashBlocked === true")
        completed = emit(page, {"type": "complete", "status": "completed"})
        page.evaluate("() => window.releaseCacheHash()")
        wait(page, "() => window.studio.active.stage === 'complete' && window.studioNativeFixture.owner().clientRecovery.phase === 'finished'")
        page.evaluate("() => window.__lifeFlushStudioHistory()")
        final = page.evaluate("() => window.studioNativeFixture.owner().clientRecovery")
        assert final["parts"] == [{"itemId": "hash-tail", "text": "Exact completion while hashing Ω 😀."}]
        assert final["applied"]["throughEventRevision"] == completed["nativeRecovery"]["revision"]
        assert final["terminal"]["stage"] == "complete"
        phases = [checkpoint["planner"]["phase"] for checkpoint in state(page)["checkpoints"][checkpoint_count:]]
        assert "completing" in phases and "finished" in phases
        assert all(phase == "finished" for phase in phases[phases.index("finished"):])
        assert len(state(page)["starts"]) == 1
        assert not any(action["request"]["kind"] == "source-apply" for action in state(page)["actions"])
        check("pending cache hashing cannot rewind the ordered native planner after completion", {
            "heldSha256": True, "providerStarts": 1, "finalPhase": "finished",
            "exactParts": True, "completeRevision": completed["nativeRecovery"]["revision"],
            "checkpointPhases": phases,
        })
    finally:
        close_context(context, page, "cache-hash-completion")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            reservation_generation(browser)
            delayed_generation_and_children(browser)
            committed_source_quota(browser)
            repeated_terminal_restore(browser)
            reconnect_partial_cursor(browser)
            cache_write_before_ack(browser)
            cache_write_before_ack(browser, corrupt=True)
            offline_settings_after_native(browser)
            cache_hash_during_native_completion(browser)
            assert errors == [], errors
            proof = {"checks": checks, "browserErrors": errors,
                     "scope": "production React Studio hook with deterministic native ledger stand-in",
                     "authenticatedProviderUse": False}
            (output / "proof.json").write_text(json.dumps(proof, indent=2, ensure_ascii=False))
            print(json.dumps({"ok": True, "checkGroups": len(checks), "browserErrors": errors}))
        except Exception as error:
            (output / "failure.json").write_text(json.dumps({"checks": checks, "browserErrors": errors,
                                                            "failure": str(error)}, indent=2, ensure_ascii=False))
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
