package com.a44kaliburll.zoon.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.a44kaliburll.zoon.MainActivity
import com.a44kaliburll.zoon.R
import com.a44kaliburll.zoon.ZoonApp
import com.a44kaliburll.zoon.util.plural
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Runs a sync the user asked for as a foreground service, so it finishes if they leave the app. */
class SyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            job?.cancel()
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel(this)
        ServiceCompat.startForeground(this, NOTIFICATION_ID, progressNotification(SyncState.Running("connecting")), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (job?.isActive != true) {
            job = scope.launch {
                val graph = ZoonApp.graph
                val watcher = launch {
                    graph.sync.state.collect { s -> if (s is SyncState.Running) notify(progressNotification(s)) }
                }
                val result = runCatching { graph.sync.run() }.getOrNull()
                watcher.cancel()
                ServiceCompat.stopForeground(this@SyncService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                if (result != null) resultNotification(result)?.let { notify(it, RESULT_ID) }
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        job?.cancel()
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun notify(n: Notification, id: Int = NOTIFICATION_ID) {
        runCatching { getSystemService(NotificationManager::class.java).notify(id, n) }
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 1, Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_SYNC).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun progressNotification(s: SyncState.Running): Notification {
        val pc = ZoonApp.graph.pc.pc.value?.name ?: "your PC"
        val cancel = PendingIntent.getService(this, 2, Intent(this, SyncService::class.java).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE)
        val text = when (s.phase) {
            "copying" -> "${s.done + 1} of ${s.total}${s.title?.let { " · $it" } ?: ""}"
            "art" -> "Getting album art"
            "reading" -> "Reading your collection"
            else -> "Connecting"
        }
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_zoon)
            .setContentTitle("Syncing with $pc")
            .setContentText(text)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp())
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Stop", cancel)
        if (s.phase == "copying" && s.totalBytes > 0) b.setProgress(1000, ((s.bytes * 1000) / s.totalBytes).toInt(), false)
        else if (s.phase == "copying" && s.total > 0) b.setProgress(s.total, s.done, false)
        else b.setProgress(0, 0, true)
        return b.build()
    }

    private fun resultNotification(s: SyncState): Notification? {
        val text = when (s) {
            is SyncState.Done -> when {
                s.failed.isNotEmpty() -> "Added ${plural(s.added, "song")}; ${s.failed.size} couldn't be copied"
                s.added > 0 || s.removed > 0 -> listOfNotNull(
                    if (s.added > 0) "added ${plural(s.added, "song")}" else null,
                    if (s.removed > 0) "removed ${s.removed}" else null,
                ).joinToString(", ").replaceFirstChar { it.uppercase() }
                else -> return null // nothing new: no need to bother anyone
            }
            is SyncState.Failed -> s.message
            else -> return null
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_zoon)
            .setContentTitle(if (s is SyncState.Failed) "Sync didn't finish" else "Sync complete")
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
    }

    companion object {
        const val CHANNEL = "sync"
        private const val NOTIFICATION_ID = 41
        private const val RESULT_ID = 42
        private const val ACTION_CANCEL = "com.a44kaliburll.zoon.CANCEL_SYNC"

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, SyncService::class.java))

        fun ensureChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.sync_channel), NotificationManager.IMPORTANCE_LOW))
            }
        }
    }
}

/**
 * Zune HD-style wireless sync: while the phone charges on Wi-Fi, check in with the PC about
 * once an hour and pick up anything new.
 */
class AutoSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = ZoonApp.graph
        if (graph.pc.pc.value == null || !graph.store.data.settings.autoSync) return Result.success()
        if (!graph.pc.hasNetworkPermission() || graph.sync.running) return Result.success()
        graph.sync.run(auto = true)
        return Result.success()
    }

    companion object {
        private const val NAME = "wireless-sync"

        fun schedule(context: Context, enabled: Boolean) {
            val wm = WorkManager.getInstance(context)
            if (!enabled) {
                wm.cancelUniqueWork(NAME)
                return
            }
            val request = PeriodicWorkRequestBuilder<AutoSyncWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiresCharging(true).setRequiredNetworkType(NetworkType.UNMETERED).build())
                .build()
            wm.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}
