package sh.omp.remote.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeMessageValidatorTest {
    @Test fun acceptsClosedSharedRendererMessages() {
        assertEquals("ui.ready", BridgeMessageValidator.validate("""{"t":"ready"}""").type)
        assertEquals("ui.prompt", BridgeMessageValidator.validate("""{"t":"prompt","text":"hello","attachments":[]}""").type)
        assertEquals("ui.setModel", BridgeMessageValidator.validate("""{"t":"setModel","provider":"openai","modelId":"gpt-5"}""").type)
        assertEquals("ui.openDiff", BridgeMessageValidator.validate("""{"t":"openDiff","toolCallId":"tool-1"}""").type)
        assertEquals("ui.rejectEdit", BridgeMessageValidator.validate("""{"t":"rejectEdit","toolCallId":"tool-1"}""").type)
        assertEquals("ui.attachPaths", BridgeMessageValidator.validate("""{"t":"attachPaths","paths":["/tmp/file.txt"]}""").type)
    }

    @Test fun rejectsUnknownFieldsCommandsAndDangerousUrls() {
        listOf(
            """{"t":"ready","secret":"x"}""",
            """{"t":"rawRpc","frame":{}}""",
            """{"t":"openExternal","url":"javascript:alert(1)"}""",
            """{"type":"local.openUrl","protocolVersion":1,"url":"data:text/html,x"}""",
        ).forEach { assertTrue("Expected rejection: $it", runCatching { BridgeMessageValidator.validate(it) }.isFailure) }
    }

    @Test fun hostileTextRemainsData() {
        val raw = """{"t":"prompt","text":"<script>ompHost.postMessage('steal')</script>","attachments":[]}"""
        assertEquals("ui.prompt", BridgeMessageValidator.validate(raw).type)
    }
}
