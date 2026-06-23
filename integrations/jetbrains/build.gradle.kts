// IntelliJ Platform plugin for RustRover / IDEA-with-Rust.
//
// NOTE: this scaffold has NOT been built in CI (the dev environment had no JVM).
// Build with JDK 17+ and `./gradlew buildPlugin`. The platform type/version
// below may need adjusting to a RustRover build you have installed.
plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.24"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.eden"
version = "0.2.0"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        // Target RustRover. The plugin only uses generic platform APIs (a tool
        // window + JCEF browser + running a process), so it also loads in IDEA
        // Ultimate with the Rust plugin.
        rustRover("2024.2")
        instrumentationTools()
        pluginVerifier()
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null }
        }
    }
    // Static runtime-API compatibility check (`./gradlew verifyPlugin`).
    pluginVerification {
        ides {
            recommended()
        }
    }
}

kotlin {
    // Matches RustRover's bundled JBR (21). Lower to 17 for older IDE targets.
    jvmToolchain(21)
}
