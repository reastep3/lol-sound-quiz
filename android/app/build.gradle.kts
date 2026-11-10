plugins {
    id("com.android.application")
}

// One version number for the site and the app: the one in package.json.
// 2.1.0 becomes version code 20100, so a newer build always installs over an older one.
val siteVersion = Regex(""""version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"""")
    .find(rootProject.file("../package.json").readText())!!
    .destructured.let { (major, minor, patch) -> Triple(major.toInt(), minor.toInt(), patch.toInt()) }

// The app is the website plus an offline copy of Riot's data and sounds. That bundle is
// generated (it is not in git), so say how to make it instead of building an empty app.
val bundle = layout.projectDirectory.dir("src/main/assets/www")
val checkBundle = tasks.register("checkBundle") {
    val index = bundle.file("index.html").asFile
    val manifest = bundle.file("offline/manifest.json").asFile
    doLast {
        if (!index.exists() || !manifest.exists()) {
            throw GradleException(
                "The offline bundle is missing. From the repository root run:\n" +
                    "    cd tools/offline && npm install && cd ../.. && npm run bundle",
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(checkBundle) }

android {
    namespace = "io.github.reastep3.lolsoundquiz"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.reastep3.lolsoundquiz"
        // Android 13. Old enough for any recent phone, new enough that the back gesture,
        // edge-to-edge insets and adaptive icons need no version checks in the code.
        minSdk = 33
        targetSdk = 37
        versionCode = siteVersion.first * 10000 + siteVersion.second * 100 + siteVersion.third
        versionName = "${siteVersion.first}.${siteVersion.second}.${siteVersion.third}"
    }

    buildTypes {
        release {
            // This app is installed by hand, not through a store, so the debug key that the
            // Android tools keep on this computer is enough. An update only installs over an
            // older copy if it is signed with the same key (~/.android/debug.keystore).
            signingConfig = signingConfigs.getByName("debug")
            // The only code is MainActivity. Shrinking drops the 2 MB Kotlin runtime that the
            // Android Gradle plugin adds by default and this app never calls.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // Sounds, icons and fonts are already compressed. Stored as they are, Android can
        // hand them to the page straight from the APK.
        noCompress += listOf("ogg", "png", "woff2")
    }

    lint {
        // Deliberate: phones only, portrait only (the quiz is typed with the on-screen keyboard).
        disable += listOf("LockedOrientationActivity", "DiscouragedApi")
    }
}

base {
    archivesName = "LoLSoundQuiz-${android.defaultConfig.versionName}"
}
