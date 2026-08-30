plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.candleapp.flame"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.candleapp.flame"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug {
            // Sideloading build. Debuggable, which also turns on WebView
            // remote debugging - fine on your own phone, never for release.
            applicationIdSuffix = ".debug"
            isDebuggable = true
        }
        release {
            isDebuggable = false
            // The app is one HTML file and one Activity; there is nothing to
            // shrink, and leaving this off keeps release builds identical to
            // debug ones so a bug can never be a minification artefact.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signing is deliberately not configured here. An upload key must
            // never live in a repository; see docs/BUILD.md for wiring one in
            // from Android Studio or from CI secrets.
        }
    }

    // AGP 8 stopped generating BuildConfig unless asked; MainActivity uses
    // BuildConfig.DEBUG to decide whether WebView remote debugging is on.
    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    // WebViewAssetLoader: serves the assets over a real https:// origin, which
    // is what makes getUserMedia work for the blow-out.
    implementation("androidx.webkit:webkit:1.11.0")
}
