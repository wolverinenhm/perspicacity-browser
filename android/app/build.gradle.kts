plugins {
    id("com.android.application") version "8.5.2"
}

android {
    namespace = "org.perspicacity.browser"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.perspicacity.browser"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
    }

    // One fixed key for every build, so a new APK installs over the previous one. CI uses the
    // release keystore from repository secrets when they exist; otherwise this committed key.
    signingConfigs {
        create("fixed") {
            val ks = System.getenv("PERSPICACITY_KEYSTORE")
            if (ks != null && file(ks).exists()) {
                storeFile = file(ks)
                storePassword = System.getenv("PERSPICACITY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PERSPICACITY_KEY_ALIAS")
                keyPassword = System.getenv("PERSPICACITY_KEY_PASSWORD")
            } else {
                storeFile = file("perspicacity-dev.keystore")
                storePassword = "perspicacity"
                keyAlias = "perspicacity"
                keyPassword = "perspicacity"
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("fixed")
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("fixed")
        }
    }

    // Ship one APK per CPU family plus a universal one (Tor's native library is ~7 MB per ABI).
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The fingerprint shim and the tracker list are shared with the desktop build.
    sourceSets["main"].assets.srcDirs("../../shared")

    packaging {
        jniLibs { useLegacyPackaging = true } // tor runs as an executable-like native library
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(project(":core"))
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("info.guardianproject:tor-android:0.4.8.22")
    implementation("info.guardianproject:jtorctl:0.4.5.7")
    implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
}
