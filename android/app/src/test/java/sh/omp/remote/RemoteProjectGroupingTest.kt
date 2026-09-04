package sh.omp.remote

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId
import sh.omp.remote.protocol.RemoteSessionSummary

class RemoteProjectGroupingTest {
    private fun session(id: String, cwd: String, title: String = id) = RemoteSessionSummary(
        id = id,
        title = title,
        cwd = cwd,
        model = "k3",
        provider = "kimi-code",
        status = "idle",
        cost = 0.0,
        closable = true,
    )

    @Test fun sessionsAreGroupedByTheFolderTheirAgentRunsIn() {
        val groups = groupSessionsByProject(
            listOf(
                session("a", "/Users/me/Desktop/Ohmypi"),
                session("b", "/Users/me/work/api"),
                session("c", "/Users/me/Desktop/Ohmypi"),
            ),
        )
        assertEquals(listOf("api", "Ohmypi"), groups.map { it.name })
        assertEquals(listOf("b"), groups[0].sessions.map { it.id })
        assertEquals(listOf("a", "c"), groups[1].sessions.map { it.id })
    }

    @Test fun theDesktopTabOrderInsideAProjectIsPreserved() {
        // The drawer and the desktop have to agree on which chat is the second one.
        val groups = groupSessionsByProject(
            listOf(
                session("third", "/p", title = "third"),
                session("first", "/p", title = "first"),
                session("second", "/p", title = "second"),
            ),
        )
        assertEquals(listOf("third", "first", "second"), groups.single().sessions.map { it.id })
    }

    @Test fun projectsSortByNameIgnoringCase() {
        val groups = groupSessionsByProject(
            listOf(session("a", "/x/Zebra"), session("b", "/x/apple"), session("c", "/x/Mango")),
        )
        assertEquals(listOf("apple", "Mango", "Zebra"), groups.map { it.name })
    }

    @Test fun twoCheckoutsSharingAFolderNameStayApart() {
        // Same display name, different projects: collapsing them would silently hide
        // one project's sessions inside another's.
        val groups = groupSessionsByProject(
            listOf(session("a", "/work/b/api"), session("b", "/work/a/api")),
        )
        assertEquals(listOf("api", "api"), groups.map { it.name })
        assertEquals(listOf("/work/a/api", "/work/b/api"), groups.map { it.path })
    }

    @Test fun trailingSeparatorsDoNotProduceAnEmptyName() {
        assertEquals("Ohmypi", projectName("/Users/me/Desktop/Ohmypi/"))
        assertEquals("Ohmypi", projectName("/Users/me/Desktop/Ohmypi//"))
    }

    @Test fun windowsPathsNameTheirLastSegmentToo() {
        assertEquals("api", projectName("""C:\work\api"""))
        assertEquals("api", projectName("""C:\work\api\"""))
    }

    @Test fun aRootOrBlankPathStillRendersSomething() {
        assertEquals("/", projectName("/"))
        assertEquals("—", projectName(""))
    }

    @Test fun noSessionsMeansNoGroups() {
        assertEquals(emptyList<RemoteProjectGroup>(), groupSessionsByProject(emptyList()))
    }
}

class BuildIdentityTest {
    @Test fun theInstallTimestampRendersInLocalTime() {
        val moscow = formatInstalledAt(1_756_200_000_000L, ZoneId.of("Europe/Moscow"))
        val utc = formatInstalledAt(1_756_200_000_000L, ZoneId.of("UTC"))
        assertEquals("26.08.2025 12:20", moscow)
        assertEquals("26.08.2025 09:20", utc)
    }

    @Test fun theFormatIsFixedWidthSoTheFooterDoesNotReflow() {
        val rendered = formatInstalledAt(1_000_000_000L, ZoneId.of("UTC"))
        assertEquals(16, rendered.length)
        assertEquals("12.01.1970 13:46", rendered)
    }
}
