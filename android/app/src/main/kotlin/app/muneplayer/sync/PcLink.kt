package app.muneplayer.sync

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.os.Build
import android.provider.Settings
import android.util.AtomicFile
import androidx.core.content.ContextCompat
import androidx.media3.datasource.DataSpec
import java.io.File
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject

const val PHONE_PORT = 18760
const val DISCOVERY_PORT = 18761

/** The PC this phone is paired with. */
data class PcInfo(
    val id: String,
    val name: String,
    val host: String,
    val port: Int,
    val token: String,
    val paired: Long,
    val lastSync: Long = 0,
)

data class PcHello(val id: String, val name: String, val host: String, val port: Int, val pairing: Boolean)

class PcError(message: String, val code: Int = 0) : IOException(message)

/** Pairing state (pc.json, kept out of backups) and helpers to talk to the paired PC. */
class PcLink(
    private val context: Context,
    private val http: OkHttpClient,
    private val file: File,
    private val chosenName: () -> String = { "" },
) {
    private val _pc = MutableStateFlow(load())
    val pc: StateFlow<PcInfo?> = _pc

    val phoneId: String by lazy {
        val f = File(context.filesDir, "phone-id")
        f.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }
            ?: UUID.randomUUID().toString().also { f.writeText(it) }
    }

    /** The phone's own name (Settings > About phone > Device name), or its make and model. */
    val deviceName: String
        get() = runCatching { Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            ?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"

    /** What the PC calls this phone: the name chosen in settings, or the device name. */
    val phoneName: String
        get() = chosenName().trim().ifEmpty { deviceName }

    fun client(pc: PcInfo? = _pc.value): PcClient {
        val p = pc ?: throw PcError("Pair with your PC first")
        return PcClient(http, p.host, p.port, p.token)
    }

    fun set(pc: PcInfo?) {
        _pc.value = pc
        val af = AtomicFile(file)
        if (pc == null) return af.delete()
        val out = af.startWrite()
        try {
            out.write(
                JSONObject().put("id", pc.id).put("name", pc.name).put("host", pc.host).put("port", pc.port)
                    .put("token", pc.token).put("paired", pc.paired).put("lastSync", pc.lastSync).toString().toByteArray(),
            )
            af.finishWrite(out)
        } catch (e: Exception) {
            af.failWrite(out)
        }
    }

    fun update(fn: (PcInfo) -> PcInfo) {
        _pc.value?.let { set(fn(it)) }
    }

    private fun load(): PcInfo? = try {
        if (!file.exists()) null else JSONObject(String(AtomicFile(file).readFully())).let { o ->
            PcInfo(o.getString("id"), o.optString("name"), o.getString("host"), o.optInt("port", PHONE_PORT), o.getString("token"), o.optLong("paired"), o.optLong("lastSync"))
        }
    } catch (e: Exception) {
        null
    }

    /** Adds the pairing token to requests that go to the paired PC (for streaming). */
    fun authorize(spec: DataSpec): DataSpec {
        val p = _pc.value ?: return spec
        val uri = spec.uri
        return if (uri.scheme == "http" && uri.host == p.host && uri.port == p.port) {
            spec.withAdditionalHeaders(mapOf("Authorization" to "Bearer ${p.token}"))
        } else {
            spec
        }
    }

    /** Android 17 asks before apps can reach other devices on the Wi-Fi ("Nearby devices"). */
    fun hasNetworkPermission(): Boolean =
        Build.VERSION.SDK_INT < 37 || ContextCompat.checkSelfPermission(context, LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED

    companion object {
        const val LOCAL_NETWORK = Manifest.permission.ACCESS_LOCAL_NETWORK
    }
}

/** Mune Player's phone API on the PC (see server/phone.js in the desktop app). */
class PcClient(http: OkHttpClient, val host: String, val port: Int, private val token: String?) {
    private val base = "http://$host:$port/mune/v1"
    private val quick = http.newBuilder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val files = http.newBuilder().connectTimeout(6, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build()

    fun fileUrl(id: String) = "$base/file/$id"
    fun albumArtUrl(id: String, size: String = "l") = "$base/art/album/$id?s=$size"

    private fun request(path: String) = Request.Builder().url(if (path.startsWith("http")) path else base + path).apply {
        if (token != null) header("Authorization", "Bearer $token")
    }

    private fun Response.check(): Response {
        if (isSuccessful) return this
        val msg = runCatching { JSONObject(body.string()).optString("error") }.getOrNull()?.takeIf { it.isNotEmpty() }
        val code = this.code
        close()
        throw PcError(msg ?: "Your PC answered with an error ($code)", code)
    }

    private suspend fun getJson(path: String): JSONObject = withContext(Dispatchers.IO) {
        quick.newCall(request(path).build()).execute().check().use { JSONObject(it.body.string()) }
    }

    private suspend fun postJson(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val req = request(path).post(body.toString().toRequestBody("application/json".toMediaType())).build()
        quick.newCall(req).execute().check().use { JSONObject(it.body.string()) }
    }

    suspend fun hello(): PcHello {
        val j = getJson("/hello")
        if (j.optString("app") != "mune-player") throw PcError("That isn't Mune Player")
        return PcHello(j.optString("id"), j.optString("name"), host, j.optInt("port", port), j.optBoolean("pairing"))
    }

    /** Returns the long-lived token for this phone. */
    suspend fun pair(code: String, phoneId: String, phoneName: String): Pair<String, PcHello> {
        val j = postJson("/pair", JSONObject().put("code", code).put("phoneId", phoneId).put("phoneName", phoneName))
        val pc = j.getJSONObject("pc")
        return j.getString("token") to PcHello(pc.optString("id"), pc.optString("name"), host, port, false)
    }

    suspend fun library(): JSONObject = getJson("/library")

    suspend fun report(body: JSONObject): JSONObject = postJson("/report", body)

    /** The Google OAuth client set up for YouTube Music in Mune Player on the PC, to sign in with here too. */
    suspend fun youtubeClient(): Pair<String, String> {
        val j = getJson("/youtube")
        return j.getString("clientId") to j.getString("clientSecret")
    }

    /** Opens a song (or art) download. The caller closes the response. Blocking; call on IO. */
    fun open(url: String): Response = files.newCall(request(url).build()).execute().check()
}

/** Finds PCs running Mune Player on the Wi-Fi with a UDP broadcast (the PC answers from port 18761). */
object Discovery {
    suspend fun find(context: Context, timeoutMs: Long = 2600, stopAtId: String? = null): List<PcHello> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, PcHello>()
        DatagramSocket().use { sock ->
            sock.broadcast = true
            sock.soTimeout = 200
            val msg = JSONObject().put("q", "mune-player").put("v", 1).toString().toByteArray()
            val targets = broadcastTargets(context)
            val end = System.currentTimeMillis() + timeoutMs
            var nextSend = 0L
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() < end) {
                if (System.currentTimeMillis() >= nextSend) {
                    for (t in targets) runCatching { sock.send(DatagramPacket(msg, msg.size, t, DISCOVERY_PORT)) }
                    nextSend = System.currentTimeMillis() + 800
                }
                val p = DatagramPacket(buf, buf.size)
                try {
                    sock.receive(p)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                val j = runCatching { JSONObject(String(p.data, 0, p.length)) }.getOrNull() ?: continue
                if (j.optString("app") != "mune-player") continue
                val host = p.address?.hostAddress ?: continue
                val hello = PcHello(j.optString("id"), j.optString("name").ifEmpty { host }, host, j.optInt("port", PHONE_PORT), j.optBoolean("pairing"))
                found[hello.id] = hello
                if (stopAtId != null && hello.id == stopAtId) break
            }
        }
        found.values.toList()
    }

    private fun broadcastTargets(context: Context): List<InetAddress> {
        val out = mutableListOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        runCatching {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val lp = cm.getLinkProperties(cm.activeNetwork)
            lp?.linkAddresses?.forEach { la ->
                val a = la.address
                if (a is Inet4Address && la.prefixLength in 8..30) {
                    val ip = a.address.fold(0) { acc, b -> (acc shl 8) or (b.toInt() and 0xff) }
                    val mask = -1 shl (32 - la.prefixLength)
                    val bc = ip or mask.inv()
                    out += InetAddress.getByAddress(byteArrayOf((bc ushr 24).toByte(), (bc ushr 16).toByte(), (bc ushr 8).toByte(), bc.toByte()))
                }
            }
        }
        return out.distinct()
    }

    /** "192.168.1.20" or "192.168.1.20:18760" -> host and port. */
    fun parseAddress(text: String): Pair<String, Int>? {
        val t = text.trim().removePrefix("http://").trimEnd('/')
        if (t.isEmpty()) return null
        val host = t.substringBefore(':')
        val port = t.substringAfter(':', "").toIntOrNull() ?: PHONE_PORT
        return if (host.isNotEmpty() && port in 1..65535) host to port else null
    }
}
