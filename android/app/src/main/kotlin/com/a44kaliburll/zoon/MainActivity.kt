package com.a44kaliburll.zoon

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.animation.AccelerateInterpolator
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.animation.doOnEnd
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.a44kaliburll.zoon.ui.Nav
import com.a44kaliburll.zoon.ui.Screen
import com.a44kaliburll.zoon.ui.ZoonRoot

class MainActivity : ComponentActivity() {
    private val nav = Nav()

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        // The logo swells and fades as the menu turnstiles in.
        splash.setOnExitAnimationListener { provider ->
            val icon: View = provider.iconView
            val grow = AnimatorSet().apply {
                playTogether(
                    ObjectAnimator.ofFloat(icon, View.SCALE_X, 1f, 2.6f),
                    ObjectAnimator.ofFloat(icon, View.SCALE_Y, 1f, 2.6f),
                    ObjectAnimator.ofFloat(icon, View.ALPHA, 1f, 0f),
                    ObjectAnimator.ofFloat(provider.view, View.ALPHA, 1f, 0f),
                )
                duration = 420
                interpolator = AccelerateInterpolator()
            }
            grow.doOnEnd { provider.remove() }
            grow.start()
        }
        val graph = ZoonApp.graph
        graph.player.connect()
        handle(intent)
        setContent { ZoonRoot(graph, nav) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        when (intent?.action) {
            ACTION_NOW_PLAYING -> nav.nowPlaying = true
            ACTION_SYNC -> nav.go(Screen.Sync)
        }
    }

    override fun onResume() {
        super.onResume()
        // Permissions can change in system settings while we're away.
        ZoonApp.graph.library.permissionChanged()
    }

    override fun onStop() {
        super.onStop()
        ZoonApp.graph.store.flush()
    }

    companion object {
        const val ACTION_NOW_PLAYING = "com.a44kaliburll.zoon.NOW_PLAYING"
        const val ACTION_SYNC = "com.a44kaliburll.zoon.SYNC"
    }
}
