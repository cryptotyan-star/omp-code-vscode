package sh.omp.remote

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sh.omp.remote.ui.OmpTheme

@RunWith(AndroidJUnit4::class)
class BuildIdentityLineInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private fun renderedFooter(): String {
        compose.setContent { OmpTheme { BuildIdentityLine() } }
        return compose.onNodeWithText(BuildConfig.VERSION_NAME, substring = true)
            .fetchSemanticsNode()
            .config[SemanticsProperties.Text]
            .joinToString("") { it.text }
    }

    /**
     * The footer exists so a build can be identified from the phone alone. That only
     * works if it names the real build, so this reads BuildConfig rather than a literal
     * that would keep passing after a version bump.
     */
    @Test fun theFooterNamesThisBuild() {
        compose.setContent { OmpTheme { BuildIdentityLine() } }
        compose.onNodeWithText(BuildConfig.VERSION_NAME, substring = true).assertIsDisplayed()
        compose.onNodeWithText("(${BuildConfig.VERSION_CODE})", substring = true).assertIsDisplayed()
    }

    /** A real timestamp, not the "—" the lookup falls back to when it fails. */
    @Test fun theFooterCarriesAnActualInstallTimestamp() {
        val text = renderedFooter()
        assertTrue(
            "footer must carry a dd.MM.yyyy HH:mm stamp, got: $text",
            Regex("""\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}""").containsMatchIn(text),
        )
        assertTrue("footer must not fall back to a dash, got: $text", !text.contains("—"))
    }
}
