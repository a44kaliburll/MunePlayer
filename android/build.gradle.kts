plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}

// Build output goes to build/ as usual. Set mune.buildRoot (for example in
// ~/.gradle/gradle.properties) to put it somewhere else, which helps when the sources
// live in a synced folder such as OneDrive.
providers.gradleProperty("mune.buildRoot").orNull?.let { root ->
    allprojects {
        layout.buildDirectory.set(File(root).resolve(name))
    }
}
