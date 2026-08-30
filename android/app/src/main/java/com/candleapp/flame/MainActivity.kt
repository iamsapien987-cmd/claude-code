package com.candleapp.flame

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader

/**
 * Native shell around the candle simulation.
 *
 * The simulation itself is one self-contained HTML file in assets, built by
 * tools/build.mjs. Everything this class adds is something the web layer
 * cannot do for itself: keep the screen awake, drive the backlight, and hand
 * the microphone over when the user asks to blow the candle out.
 *
 * The page is served over https://appassets.androidplatform.net/ rather than
 * loaded from a file:// URL. That matters: getUserMedia only runs in a secure
 * context, and a real HTTPS origin also avoids the assorted restrictions
 * Chromium places on file:// pages. WebViewAssetLoader maps that origin onto
 * the assets folder without any network access.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var pendingMic: PermissionRequest? = null
    private var failed = false

    private companion object {
        /** The virtual host WebViewAssetLoader serves the assets from. */
        const val ASSET_HOST = "appassets.androidplatform.net"
    }

    private val micPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        pendingMic?.let { req ->
            if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            else req.deny()
        }
        pendingMic = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // A candle you have to keep tapping to stop the screen dimming is not
        // a candle. This flag needs no permission.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY

        // Remote debugging follows the build type, so it is on for the
        // sideload build and off in anything shipped.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The crackle is synthesised on the fly, so it must be allowed to
            // start without a separate gesture of its own.
            settings.mediaPlaybackRequiresUserGesture = false
            // No remote content is ever loaded, so everything that could
            // reach outside the app is shut off explicitly rather than left
            // to whatever the platform default happens to be on a given API
            // level. None of it is needed: the page is a single local file.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            settings.setGeolocationEnabled(false)
            settings.databaseEnabled = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                /**
                 * Block navigation away from the app, but not the app itself.
                 * Returning true unconditionally would risk swallowing our own
                 * page load; only foreign hosts are refused.
                 */
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean = request.url.host != ASSET_HOST

                /**
                 * If the page ever fails to load, say so.
                 *
                 * The app draws on a black background, so a failure here
                 * would otherwise present as a black screen with no
                 * explanation and no way to tell it apart from a candle that
                 * has been blown out. The asset loader is served over an
                 * https origin so that getUserMedia works, and that origin is
                 * intercepted locally rather than fetched - but if that ever
                 * stops being true on some device, this is what makes it
                 * visible instead of silent.
                 */
                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: android.webkit.WebResourceError
                ) {
                    if (!request.isForMainFrame || failed) return
                    failed = true
                    view.loadDataWithBaseURL(
                        null,
                        """<html><body style="margin:0;background:#000;color:#c8c0b4;
                           font:14px/1.6 sans-serif;display:flex;align-items:center;
                           justify-content:center;height:100vh;text-align:center">
                           <div style="padding:32px">The candle could not be loaded.<br>
                           <span style="color:#6b645c;font-size:12px">
                           ${error.description}</span></div></body></html>""",
                        "text/html", "utf-8", null
                    )
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val wantsMic = request.resources.contains(
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE
                    )
                    if (!wantsMic) { request.deny(); return }
                    runOnUiThread {
                        val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                            PackageManager.PERMISSION_GRANTED
                        if (granted) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        } else {
                            // Only ask at the moment the user taps the mic
                            // button, never on launch.
                            pendingMic = request
                            micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }
                }
            }

            addJavascriptInterface(HostBridge(), "CandleHost")
        }

        setContentView(web)
        web.loadUrl("https://$ASSET_HOST/assets/candle.html")
    }

    /**
     * The small amount of hardware the web layer cannot reach on its own.
     *
     * Brightness is set on this window's own attributes, not through the
     * system setting, so it needs no permission and Android restores the
     * user's own brightness automatically when they leave.
     */
    inner class HostBridge {
        // JavaScript has only doubles, so take one rather than relying on the
        // bridge to narrow it for us.
        @android.webkit.JavascriptInterface
        fun setBrightness(value: Double) {
            if (value.isNaN()) return
            runOnUiThread {
                window.attributes = window.attributes.apply {
                    screenBrightness = value.toFloat().coerceIn(0.02f, 1.0f)
                }
            }
        }
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
        // Stops the simulation entirely while backgrounded. The focus session
        // is paused on the web side by the Page Visibility API, so the two
        // agree about what "away" means.
        web.pauseTimers()
    }

    override fun onResume() {
        super.onResume()
        web.resumeTimers()
        web.onResume()
    }

    override fun onDestroy() {
        // Detach before destroying. A WebView that is destroyed while still
        // attached to the view tree is a documented way to get a crash on
        // some devices.
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }
}
