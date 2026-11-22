plugins {
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // Android ships org.json in the platform; on the JVM (tests) it comes from Maven.
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    // Tests read the shared filter list from the repository.
    systemProperty("perspicacity.shared", rootProject.projectDir.resolve("../shared").absolutePath)
}
