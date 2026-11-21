pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "Perspicacity"
include(":core")
// The Android app needs the Android SDK; set -PcoreOnly=true to build just the pure-Java core.
if (!providers.gradleProperty("coreOnly").isPresent) include(":app")
