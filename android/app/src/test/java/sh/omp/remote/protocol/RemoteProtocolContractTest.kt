package sh.omp.remote.protocol

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.omp.remote.shouldResumeStoredSession

class RemoteProtocolContractTest {
    @Test fun exactDesktopCommandFixtureRoundTrips() {
        val fixture = """{"protocolVersion":1,"type":"command","commandId":"123e4567-e89b-12d3-a456-426614174000","commandCounter":"42","hostGeneration":"host-1","sessionId":"session-1","command":"model.set","payload":{"provider":"anthropic","modelId":"claude-opus"}}"""
        val command = StrictProtocolJson.decodeFromString<RemoteCommand>(fixture)
        RemoteCommandValidator.validate(command, fixture.toByteArray().size)
        assertEquals("42", command.commandCounter)
        assertEquals("model.set", command.command)
        assertTrue(StrictProtocolJson.encodeToString(command).contains("\"type\":\"command\""))
    }

    @Test fun promptMayBeAttachmentOnlyButNotEmpty() {
        val attachment = "123e4567-e89b-12d3-a456-426614174000"
        validates("prompt.send", buildJsonObject { put("text", ""); put("attachmentIds", JsonArray(listOf(JsonPrimitive(attachment)))) })
        rejects("prompt.send", buildJsonObject { put("text", ""); put("attachmentIds", JsonArray(emptyList())) })
        validates("prompt.send", buildJsonObject {
            put("text", "route once"); put("attachmentIds", JsonArray(emptyList()))
            put("forModel", buildJsonObject { put("provider", "anthropic"); put("modelId", "claude-opus") })
        })
        rejects("prompt.send", buildJsonObject {
            put("text", "bad route"); put("attachmentIds", JsonArray(emptyList()))
            put("forModel", buildJsonObject { put("modelId", "missing-provider") })
        })
    }

    @Test fun modelRequiresProviderAndCounterIsCanonicalUint64() {
        rejects("model.set", buildJsonObject { put("modelId", "x") })
        validates("model.set", buildJsonObject { put("provider", "openai"); put("modelId", "gpt-5") }, "18446744073709551615")
        assertTrue(runCatching { parseUint64Decimal("18446744073709551616") }.isFailure)
        assertTrue(runCatching { parseUint64Decimal("01") }.isFailure)
        assertTrue(runCatching { parseUint64Decimal("+1") }.isFailure)
    }

    @Test fun historyOpenMatchesDesktopContract() {
        validates("history.open", buildJsonObject { put("sessionPath", "/allowed/history/session.jsonl") })
        rejects("history.open", JsonObject(emptyMap()))
    }

    @Test fun reducerDetectsReplayGapAndGenerationReset() {
        val reducer = ProtocolReducer()
        reducer.beginFullSync("host-1", "10")
        val base = HostEvent(1, "event", "host-1", "11", "session-1", "event-1", "frame")
        assertEquals(ApplyResult.APPLIED, reducer.apply(base))
        assertEquals(ApplyResult.DUPLICATE, reducer.apply(base))
        assertEquals(ApplyResult.GAP_REQUIRES_FULL_SYNC, reducer.apply(base.copy(sequence = "13", eventId = "event-2")))
        assertEquals(ApplyResult.GENERATION_REQUIRES_FULL_SYNC, reducer.apply(base.copy(hostGeneration = "host-2", sequence = "12")))
    }

    @Test fun capabilityWindowRejectsExpiredAndFutureIssuedManifests() {
        val now = 2_000_000L
        fun manifest(issuedAt: Long, expiresAt: Long) = CapabilityManifest(
            protocolVersion = 1,
            manifestId = "manifest-1",
            deviceId = "device-1",
            keyEpoch = 1,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            verbs = emptyList(),
            sessionIds = emptyList(),
            workspaceRoots = emptyList(),
            allSessions = false,
        )
        validateCapabilityWindow(manifest(now - 1_000, now + 1_000), now, 100)
        assertTrue(runCatching { validateCapabilityWindow(manifest(now - 1_000, now - 101), now, 100) }.isFailure)
        assertTrue(runCatching { validateCapabilityWindow(manifest(now + 101, now + 1_000), now, 100) }.isFailure)
    }

    @Test fun handshakeCounterKnownAnswerMatchesDesktop() {
        val nonce = ByteArray(16) { it.toByte() }
        assertEquals("1a317d6908e68dc2", HandshakeCounters.pairCounter(nonce).toString(16))
        assertEquals("1887427608919313858", HandshakeCounters.pairCounter(nonce).toString())
        assertEquals("8000000000000007", HandshakeCounters.enrolCounter(7).toString(16))
        assertEquals("9223372036854775815", HandshakeCounters.enrolCounter(7).toString())
    }

    @Test fun approvalOptionNormalizationMatchesDesktopAndRenderer() {
        assertEquals(JsonPrimitive("scalar"), normalizeApprovalOption(JsonPrimitive("scalar")))
        assertEquals(JsonPrimitive("v"), normalizeApprovalOption(buildJsonObject {
            put("value", "v"); put("label", "l"); put("name", "n"); put("title", "t")
        }))
        assertEquals(JsonPrimitive("l"), normalizeApprovalOption(buildJsonObject { put("label", "l") }))
        assertEquals(JsonPrimitive("n"), normalizeApprovalOption(buildJsonObject { put("name", "n") }))
        assertEquals(JsonPrimitive("t"), normalizeApprovalOption(buildJsonObject { put("title", "t") }))
        assertEquals(JsonPrimitive(""), normalizeApprovalOption(JsonObject(emptyMap())))
    }

    @Test fun onlyActionableApprovalMethodsNotifyAndRequireCanonicalId() {
        fun frame(method: String, id: String = "req-1") = buildJsonObject {
            put("type", "extension_ui_request"); put("method", method); put("id", id)
        }
        for (method in listOf("confirm", "select", "input", "editor")) {
            assertEquals("req-1", actionableApprovalRequestId(frame(method)))
        }
        for (method in listOf("notify", "status", "title", "open_url", "cancel")) {
            assertEquals(null, actionableApprovalRequestId(frame(method)))
        }
        assertEquals(null, actionableApprovalRequestId(frame("confirm", "bad id")))
    }

    @Test fun approvalIsRemovedOnlyAfterCompletedAck() {
        assertTrue(!shouldRetainApprovalAfter("completed"))
        for (status in listOf("accepted", "rejected", "indeterminate", "timeout")) {
            assertTrue(shouldRetainApprovalAfter(status))
        }
        assertTrue(!shouldRetainApprovalAfter("rejected", "host-not-pending"))
        assertTrue(!shouldRetainApprovalAfter("indeterminate", "answer-won"))
    }

    @Test fun rendererApprovalCorrelationComesFromNestedFrame() {
        val body = buildJsonObject {
            put("t", "uiResponse")
            put("frame", buildJsonObject { put("id", "req-42"); put("confirmed", true) })
        }
        assertEquals("req-42", approvalResponseRequestId(body))
        assertTrue(runCatching {
            approvalResponseRequestId(buildJsonObject { put("t", "uiResponse"); put("id", "wrong-level") })
        }.isFailure)
    }

    @Test fun authenticatedApprovalResolutionClosesDesktopAndAgentWonRequests() {
        for ((outcome, winner) in listOf("answered" to "desktop", "cancelled" to "agent", "answered" to "remote")) {
            assertEquals("req-42", approvalResolutionRequestId(buildJsonObject {
                put("t", "approvalResolved"); put("requestId", "req-42")
                put("outcome", outcome); put("winner", winner)
            }))
        }
        assertTrue(runCatching {
            approvalResolutionRequestId(buildJsonObject {
                put("t", "approvalResolved"); put("requestId", "req-42")
                put("outcome", "maybe"); put("winner", "desktop")
            })
        }.isFailure)
    }

    @Test fun tappingSelectedSessionIsAnAuthenticatedNoOp() {
        assertTrue(!shouldSendSessionSwitch("session-1", "session-1"))
        assertTrue(shouldSendSessionSwitch("session-1", "session-2"))
    }

    @Test fun allSessionsNeverExpandsConcreteSignedSessionIds() {
        val manifest = CapabilityManifest(
            protocolVersion = 1,
            manifestId = "manifest-1",
            deviceId = "device-1",
            keyEpoch = 1,
            issuedAt = 1,
            expiresAt = 2,
            verbs = listOf("session.manage"),
            sessionIds = listOf("signed-session"),
            workspaceRoots = emptyList(),
            allSessions = true,
        )
        assertTrue(isSessionInsideSignedGrant(manifest, "signed-session"))
        assertTrue(!isSessionInsideSignedGrant(manifest, "not-signed"))
        assertTrue(!isSessionInsideSignedGrant(manifest, null))
    }

    @Test fun restoredTypedCommandTreatsMissingPrivateResultAsUnavailable() {
        for (kind in listOf("history", "files", "export", "diagnostics", "models-probe")) {
            assertTrue(!hasDurableUiResult(kind, null))
            assertTrue(!hasDurableUiResult(kind, JsonObject(emptyMap())))
        }
        assertTrue(hasDurableUiResult("history", buildJsonObject { put("sessions", JsonArray(emptyList())) }))
        assertTrue(hasDurableUiResult("files", buildJsonObject { put("files", JsonArray(emptyList())) }))
        assertTrue(hasDurableUiResult("export", buildJsonObject { put("format", "markdown"); put("content", "# done") }))
        assertTrue(hasDurableUiResult("diagnostics", buildJsonObject { put("markdown", "ok") }))
        assertTrue(hasDurableUiResult("models-probe", buildJsonObject { put("results", JsonObject(emptyMap())) }))
        assertTrue(hasDurableUiResult("diff", buildJsonObject {
            put("changeId", "tool-1"); put("afterSha256", "a".repeat(64))
        }))
        assertTrue(!hasDurableUiResult("diff", buildJsonObject { put("changeId", "tool-1") }))
    }

    @Test fun coldLauncherResumesButFreshPairingLinkWins() {
        assertTrue(shouldResumeStoredSession(null))
        assertTrue(shouldResumeStoredSession(""))
        assertTrue(!shouldResumeStoredSession("omp-code://pair?v=1"))
    }

    private fun validates(name: String, payload: JsonObject, counter: String = "1") {
        val command = RemoteCommand(
            commandId = "123e4567-e89b-12d3-a456-426614174000",
            commandCounter = counter,
            hostGeneration = "host-1",
            sessionId = "session-1",
            command = name,
            payload = payload,
        )
        RemoteCommandValidator.validate(command, StrictProtocolJson.encodeToString(command).toByteArray().size)
    }

    private fun rejects(name: String, payload: JsonObject) {
        assertTrue(runCatching { validates(name, payload) }.isFailure)
    }
}
