package sh.omp.remote.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import sh.omp.remote.R

private val dark = darkColorScheme(
    primary = Color(0xFFB9AAFF),
    secondary = Color(0xFFCBC2F2),
    background = Color(0xFF111218),
    surface = Color(0xFF1B1C24),
    surfaceVariant = Color(0xFF252630),
)

private val light = lightColorScheme(
    primary = Color(0xFF5A43C5),
    secondary = Color(0xFF66558B),
    background = Color(0xFFFCF8FF),
    surface = Color(0xFFFFFBFF),
)

// The same face the embedded renderer loads from assets, so the native chrome and
// the WebView do not read as two different apps stacked on top of each other.
//
// Golos Text ships as a single variable font with one wght axis spanning 400-900.
// The per-weight downloads are byte-identical copies of it that all report
// usWeightClass 400, so registering them as three static faces produced three
// identical Regulars -- bold text that was not bold. One file, three instances.
@OptIn(ExperimentalTextApi::class)
private fun golos(weight: Int, fontWeight: FontWeight) =
    Font(
        resId = R.font.golos_text,
        weight = fontWeight,
        variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
    )

private val golosText = FontFamily(
    golos(400, FontWeight.Normal),
    golos(500, FontWeight.Medium),
    golos(700, FontWeight.Bold),
)

private val typography = Typography().let { base ->
    Typography(
        displayLarge = base.displayLarge.copy(fontFamily = golosText),
        displayMedium = base.displayMedium.copy(fontFamily = golosText),
        displaySmall = base.displaySmall.copy(fontFamily = golosText),
        headlineLarge = base.headlineLarge.copy(fontFamily = golosText),
        headlineMedium = base.headlineMedium.copy(fontFamily = golosText),
        headlineSmall = base.headlineSmall.copy(fontFamily = golosText),
        titleLarge = base.titleLarge.copy(fontFamily = golosText),
        titleMedium = base.titleMedium.copy(fontFamily = golosText),
        titleSmall = base.titleSmall.copy(fontFamily = golosText),
        bodyLarge = base.bodyLarge.copy(fontFamily = golosText),
        bodyMedium = base.bodyMedium.copy(fontFamily = golosText),
        bodySmall = base.bodySmall.copy(fontFamily = golosText),
        labelLarge = base.labelLarge.copy(fontFamily = golosText),
        labelMedium = base.labelMedium.copy(fontFamily = golosText),
        labelSmall = base.labelSmall.copy(fontFamily = golosText),
    )
}

@Composable
fun OmpTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) dark else light,
        typography = typography,
        content = content,
    )
}
