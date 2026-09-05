package com.edgereader.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(name = "NativeTTS")
public class NativeTTS extends Plugin {

    private static final String TAG = "NativeTTS";
    public static NativeTTS instance;
    private String pendingSaveFileUri;
    private final ConcurrentHashMap<String, WebSocket> activeSockets = new ConcurrentHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    private static OkHttpClient okHttpClient;
    private static synchronized OkHttpClient getOkHttpClient() {
        if (okHttpClient == null) {
            okHttpClient = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(15, TimeUnit.SECONDS)
                    .build();
        }
        return okHttpClient;
    }

    public void sendMediaAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("mediaAction", data);
    }

    public void sendSentenceStarted(int index, double duration) {
        JSObject data = new JSObject();
        data.put("index", index);
        data.put("duration", duration);
        notifyListeners("sentenceStarted", data);
    }

    public void sendSentenceEnded(int index) {
        JSObject data = new JSObject();
        data.put("index", index);
        notifyListeners("sentenceEnded", data);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        for (WebSocket ws : activeSockets.values()) {
            try {
                ws.cancel();
            } catch (Exception ignored) {}
        }
        activeSockets.clear();
        if (instance == this) {
            instance = null;
        }
    }

    private void ensureAudioServiceStarted(Context context) {
        if (AudioPlayerService.getInstance() == null) {
            Intent intent = new Intent(context, AudioPlayerService.class);
            intent.setAction("ACTION_INIT");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        }
    }

    @PluginMethod
    public void writeLog(PluginCall call) {
        String tag = call.getString("tag", "EdgeReader");
        String message = call.getString("message", "");
        Log.d(tag, message);
        call.resolve();
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
                    Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + context.getPackageName()));
                    if (getActivity() != null) {
                        getActivity().startActivity(intent);
                    }
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to request battery optimization whitelist: " + e.getMessage());
        }
    }

    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, AudioPlayerService.class);
            intent.setAction("ACTION_START");
            intent.putExtra("title", call.getString("title", ""));
            intent.putExtra("artist", call.getString("artist", ""));
            intent.putExtra("text", call.getString("text", ""));
            intent.putExtra("cover", call.getString("cover", ""));
            intent.putExtra("isPlaying", call.getBoolean("isPlaying", false));
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void updatePlaybackState(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, AudioPlayerService.class);
            intent.setAction("ACTION_UPDATE_STATE");
            intent.putExtra("isPlaying", call.getBoolean("isPlaying", false));
            context.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to update playback state: " + e.getMessage());
        }
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, AudioPlayerService.class);
            intent.setAction("ACTION_UPDATE_METADATA");
            intent.putExtra("title", call.getString("title", ""));
            intent.putExtra("artist", call.getString("artist", ""));
            intent.putExtra("text", call.getString("text", ""));
            intent.putExtra("isPlaying", call.getBoolean("isPlaying", true));
            String cover = call.getString("cover");
            if (cover != null && !cover.isEmpty()) {
                intent.putExtra("cover", cover);
            }
            context.startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to update metadata: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, AudioPlayerService.class);
            context.stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void downloadTTS(PluginCall call) {
        String text = call.getString("text");
        String voice = call.getString("voice");
        String rate = call.getString("rate", "+0%");
        String volume = call.getString("volume", "+0%");
        String connectionId = call.getString("connectionId");
        String secMsGec = call.getString("secMsGec");
        String dateStr = call.getString("dateStr");

        if (text == null || voice == null || connectionId == null || secMsGec == null || dateStr == null) {
            call.reject("Missing required parameters");
            return;
        }

        String url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
                "?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4" +
                "&ConnectionId=" + connectionId +
                "&Sec-MS-GEC=" + secMsGec +
                "&Sec-MS-GEC-Version=1-143.0.3650.75";

        OkHttpClient client = getOkHttpClient();

        Request request = new Request.Builder()
                .url(url)
                .addHeader("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .addHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
                .build();

        ByteArrayOutputStream audioStream = new ByteArrayOutputStream();
        AtomicBoolean isCompleted = new AtomicBoolean(false);

        Runnable timeoutRunnable = () -> {
            if (isCompleted.compareAndSet(false, true)) {
                Log.w(TAG, "TTS request timed out (10s): " + connectionId);
                WebSocket ws = activeSockets.remove(connectionId);
                if (ws != null) {
                    try {
                        ws.cancel();
                    } catch (Exception ignored) {}
                }
                call.reject("Edge TTS request timed out in native (10s)");
            }
        };
        mainHandler.postDelayed(timeoutRunnable, 10000);

        WebSocketListener listener = new WebSocketListener() {
            private void finishWithSuccess(WebSocket webSocket) {
                if (!isCompleted.compareAndSet(false, true)) return;
                mainHandler.removeCallbacks(timeoutRunnable);
                activeSockets.remove(connectionId);
                try {
                    webSocket.cancel();
                } catch (Exception ignored) {}

                byte[] audioData = audioStream.toByteArray();
                if (audioData.length > 0) {
                    String base64Audio = Base64.encodeToString(audioData, Base64.NO_WRAP);
                    JSObject ret = new JSObject();
                    ret.put("audioBase64", base64Audio);

                    // Cache audio bytes directly to local storage for Route B instant playback
                    try {
                        File cacheDir = getContext().getCacheDir();
                        File ttsFile = new File(cacheDir, "tts_" + connectionId + ".mp3");
                        try (FileOutputStream fos = new FileOutputStream(ttsFile)) {
                            fos.write(audioData);
                        }
                        ret.put("filePath", ttsFile.getAbsolutePath());
                    } catch (Exception e) {
                        Log.w(TAG, "Failed to cache TTS audio file: " + e.getMessage());
                    }

                    call.resolve(ret);
                } else {
                    // Return short silence MP3 fallback if turn.end occurred without audio
                    JSObject ret = new JSObject();
                    ret.put("audioBase64", "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV");
                    call.resolve(ret);
                }
            }

            private void finishWithError(WebSocket webSocket, String errorMsg) {
                if (!isCompleted.compareAndSet(false, true)) return;
                mainHandler.removeCallbacks(timeoutRunnable);
                activeSockets.remove(connectionId);
                try {
                    webSocket.cancel();
                } catch (Exception ignored) {}
                call.reject(errorMsg);
            }

            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                // Send config message
                String configMsg =
                        "X-Timestamp:" + dateStr + "\r\n" +
                        "Content-Type:application/json; charset=utf-8\r\n" +
                        "Path:speech.config\r\n\r\n" +
                        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
                webSocket.send(configMsg);

                // Send SSML message
                String escapedText = escapeXml(text);
                String ssml =
                        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
                        "<voice name='" + voice + "'>" +
                        "<prosody pitch='+0Hz' rate='" + rate + "' volume='" + volume + "'>" +
                        escapedText +
                        "</prosody>" +
                        "</voice>" +
                        "</speak>";

                String ssmlMsg =
                        "X-RequestId:" + connectionId + "\r\n" +
                        "Content-Type:application/ssml+xml\r\n" +
                        "X-Timestamp:" + dateStr + "Z\r\n" +
                        "Path:ssml\r\n\r\n" +
                        ssml;
                webSocket.send(ssmlMsg);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (text.contains("Path:turn.end")) {
                    finishWithSuccess(webSocket);
                }
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] array = bytes.toByteArray();
                if (array.length < 2) return;
                
                // Read header length (16-bit big endian)
                int headerLength = ((array[0] & 0xFF) << 8) | (array[1] & 0xFF);
                if (headerLength + 2 > array.length) return;

                byte[] headerBytes = new byte[headerLength];
                System.arraycopy(array, 2, headerBytes, 0, headerLength);
                String headers = new String(headerBytes, StandardCharsets.UTF_8);

                if (headers.contains("Path:audio")) {
                    int audioLength = array.length - (headerLength + 2);
                    audioStream.write(array, headerLength + 2, audioLength);
                }
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                finishWithSuccess(webSocket);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                finishWithSuccess(webSocket);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                finishWithError(webSocket, "WebSocket failure: " + t.getMessage());
            }
        };

        WebSocket ws = client.newWebSocket(request, listener);
        activeSockets.put(connectionId, ws);
    }

    @PluginMethod
    public void cancelTTS(PluginCall call) {
        String connectionId = call.getString("connectionId");
        if (connectionId != null) {
            WebSocket ws = activeSockets.remove(connectionId);
            if (ws != null) {
                try {
                    ws.cancel();
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void cancelAllTTS(PluginCall call) {
        for (WebSocket ws : activeSockets.values()) {
            try {
                ws.cancel();
            } catch (Exception ignored) {}
        }
        activeSockets.clear();
        call.resolve();
    }

    @PluginMethod
    public void syncClock(PluginCall call) {
        new Thread(() -> {
            try {
                String url = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
                Request request = new Request.Builder().url(url).head().build();
                Response response = getOkHttpClient().newCall(request).execute();
                String dateHeader = response.header("Date");
                double clockSkew = 0;
                if (dateHeader != null) {
                    java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US);
                    java.util.Date serverDate = sdf.parse(dateHeader);
                    if (serverDate != null) {
                        clockSkew = (double)(serverDate.getTime() - System.currentTimeMillis());
                    }
                }
                JSObject ret = new JSObject();
                ret.put("clockSkew", clockSkew);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("clockSkew", 0);
                call.resolve(ret);
            }
        }).start();
    }

    private float getFloat(PluginCall call, String key, float defaultValue) {
        Double d = call.getDouble(key);
        return (d != null) ? d.floatValue() : defaultValue;
    }

    private double getDouble(PluginCall call, String key, double defaultValue) {
        Double d = call.getDouble(key);
        return (d != null) ? d : defaultValue;
    }

    // Route B Native Audio Engine Methods
    @PluginMethod
    public void playNativeSentence(PluginCall call) {
        int index = call.getInt("index", -1);
        if (index < 0) {
            call.reject("Missing index");
            return;
        }

        String filePath = call.getString("filePath", "");
        String audioBase64 = call.getString("audioBase64", "");
        String text = call.getString("text", "");
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String cover = call.getString("cover", "");
        double duration = getDouble(call, "duration", 60.0);
        double currentTime = getDouble(call, "currentTime", 0.0);
        float rate = getFloat(call, "rate", 1.0f);
        float volume = getFloat(call, "volume", 1.0f);

        ensureAudioServiceStarted(getContext());

        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.playNativeSentence(filePath, audioBase64, index, text, title, artist, cover, duration, currentTime, rate, volume, new AudioPlayerService.PlayCallback() {
                @Override
                public void onSuccess(int durationMs) {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("index", index);
                    ret.put("duration", durationMs / 1000.0);
                    call.resolve(ret);
                }

                @Override
                public void onError(String error) {
                    call.reject(error);
                }
            });
        } else {
            // Service is booting, retry on main handler
            mainHandler.postDelayed(() -> {
                AudioPlayerService retryService = AudioPlayerService.getInstance();
                if (retryService != null) {
                    retryService.playNativeSentence(filePath, audioBase64, index, text, title, artist, cover, duration, currentTime, rate, volume, new AudioPlayerService.PlayCallback() {
                        @Override
                        public void onSuccess(int durationMs) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            ret.put("index", index);
                            ret.put("duration", durationMs / 1000.0);
                            call.resolve(ret);
                        }

                        @Override
                        public void onError(String error) {
                            call.reject(error);
                        }
                    });
                } else {
                    call.reject("AudioPlayerService not available");
                }
            }, 150);
        }
    }

    @PluginMethod
    public void prepareNextSentence(PluginCall call) {
        int index = call.getInt("index", -1);
        if (index < 0) {
            call.reject("Missing index");
            return;
        }

        String filePath = call.getString("filePath", "");
        String audioBase64 = call.getString("audioBase64", "");
        float rate = getFloat(call, "rate", 1.0f);
        float volume = getFloat(call, "volume", 1.0f);

        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.prepareNextSentence(filePath, audioBase64, index, rate, volume, new AudioPlayerService.PrepareCallback() {
                @Override
                public void onSuccess(boolean prepared) {
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("index", index);
                    ret.put("prepared", prepared);
                    call.resolve(ret);
                }

                @Override
                public void onError(String error) {
                    call.reject(error);
                }
            });
        } else {
            call.reject("AudioPlayerService not running");
        }
    }

    @PluginMethod
    public void pauseNative(PluginCall call) {
        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.pauseNative();
        }
        call.resolve();
    }

    @PluginMethod
    public void resumeNative(PluginCall call) {
        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            boolean resumed = service.resumeNative();
            JSObject ret = new JSObject();
            ret.put("resumed", resumed);
            ret.put("index", service.getCurrentPlayingSentenceIndex());
            call.resolve(ret);
        } else {
            JSObject ret = new JSObject();
            ret.put("resumed", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void stopNative(PluginCall call) {
        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.stopNative();
        }
        call.resolve();
    }

    @PluginMethod
    public void setRateNative(PluginCall call) {
        float rate = getFloat(call, "rate", 1.0f);
        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.setRateNative(rate);
        }
        call.resolve();
    }

    @PluginMethod
    public void setVolumeNative(PluginCall call) {
        float volume = getFloat(call, "volume", 1.0f);
        AudioPlayerService service = AudioPlayerService.getInstance();
        if (service != null) {
            service.setVolumeNative(volume);
        }
        call.resolve();
    }

    @PluginMethod
    public void deleteTTSFile(PluginCall call) {
        String filePath = call.getString("filePath");
        if (filePath != null && !filePath.isEmpty()) {
            AudioPlayerService service = AudioPlayerService.getInstance();
            boolean inUse = false;
            if (service != null) {
                inUse = filePath.equals(service.getActivePlayerFilePath()) || filePath.equals(service.getPreparedPlayerFilePath());
            }
            if (!inUse) {
                File f = new File(filePath);
                if (f.exists()) {
                    f.delete();
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void cleanupTTSFiles(PluginCall call) {
        try {
            File cacheDir = getContext().getCacheDir();
            File[] files = cacheDir.listFiles();
            if (files != null) {
                AudioPlayerService service = AudioPlayerService.getInstance();
                String activeFile = service != null ? service.getActivePlayerFilePath() : null;
                String prepFile = service != null ? service.getPreparedPlayerFilePath() : null;
                for (File f : files) {
                    if (f.isFile() && f.getName().startsWith("tts_") && f.getName().endsWith(".mp3")) {
                        String abs = f.getAbsolutePath();
                        if (!abs.equals(activeFile) && !abs.equals(prepFile)) {
                            f.delete();
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void getPlaybackSyncState(PluginCall call) {
        AudioPlayerService service = AudioPlayerService.getInstance();
        JSObject ret = new JSObject();
        if (service != null) {
            ret.put("isCurrentlyPlaying", service.isPlaying());
            ret.put("isNativeEngineActive", true);
            ret.put("currentPlayingSentenceIndex", service.getCurrentPlayingSentenceIndex());
            ret.put("preparedSentenceIndex", service.getPreparedSentenceIndex());
            ret.put("isPreparedReady", service.isPreparedReady());
            ret.put("activePlayerFilePath", service.getActivePlayerFilePath());
        } else {
            ret.put("isCurrentlyPlaying", false);
            ret.put("isNativeEngineActive", false);
            ret.put("currentPlayingSentenceIndex", -1);
            ret.put("preparedSentenceIndex", -1);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void simulateRemoteCommand(PluginCall call) {
        String action = call.getString("action");
        if (action == null) {
            call.reject("Missing action");
            return;
        }
        AudioPlayerService service = AudioPlayerService.getInstance();
        switch (action.toLowerCase()) {
            case "play":
                if (service != null) service.resumeNative();
                sendMediaAction("play");
                break;
            case "pause":
                if (service != null) service.pauseNative();
                sendMediaAction("pause");
                break;
            case "toggle":
                if (service != null) {
                    if (service.isPlaying()) {
                        service.pauseNative();
                        sendMediaAction("pause");
                    } else {
                        service.resumeNative();
                        sendMediaAction("play");
                    }
                }
                break;
            case "next":
                sendMediaAction("next");
                break;
            case "previous":
                sendMediaAction("previous");
                break;
            case "stop":
                if (service != null) service.stopNative();
                sendMediaAction("stop");
                break;
            case "call_incoming":
                if (service != null) {
                    service.simulateAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT);
                }
                break;
            case "call_ended":
                if (service != null) {
                    service.simulateAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN);
                }
                break;
            default:
                call.reject("Unknown action: " + action);
                return;
        }
        call.resolve();
    }

    @PluginMethod
    public void copyFileToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String fileUri = call.getString("fileUri");
        if (filename == null || fileUri == null) {
            call.reject("Missing filename or fileUri");
            return;
        }

        try {
            Context context = getContext();
            Uri srcUri = Uri.parse(fileUri);
            
            InputStream is = null;
            if (fileUri.startsWith("content://")) {
                is = context.getContentResolver().openInputStream(srcUri);
            } else {
                String filePath = srcUri.getPath();
                is = new FileInputStream(new File(filePath));
            }
            
            if (is == null) {
                call.reject("Cannot open source file: " + fileUri);
                return;
            }

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    Uri destUri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (destUri != null) {
                        try (OutputStream os = context.getContentResolver().openOutputStream(destUri)) {
                            byte[] buffer = new byte[262144];
                            int read;
                            while ((read = is.read(buffer)) != -1) {
                                os.write(buffer, 0, read);
                            }
                            
                            JSObject ret = new JSObject();
                            ret.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + filename);
                            call.resolve(ret);
                        }
                    } else {
                        call.reject("Failed to create MediaStore entry");
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) {
                        downloadsDir.mkdirs();
                    }
                    File file = new File(downloadsDir, filename);
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        byte[] buffer = new byte[262144];
                        int read;
                        while ((read = is.read(buffer)) != -1) {
                            fos.write(buffer, 0, read);
                        }
                        
                        JSObject ret = new JSObject();
                        ret.put("path", file.getAbsolutePath());
                        call.resolve(ret);
                    }
                }
            } finally {
                is.close();
            }
        } catch (Exception e) {
            call.reject("Copy failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveFileToSystem(PluginCall call) {
        String filename = call.getString("filename");
        String fileUri = call.getString("fileUri");
        if (filename == null || fileUri == null) {
            call.reject("Missing filename or fileUri");
            return;
        }

        this.pendingSaveFileUri = fileUri;

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/zip");
        intent.putExtra(Intent.EXTRA_TITLE, filename);

        startActivityForResult(call, intent, "saveFileToSystemResult");
    }

    @ActivityCallback
    private void saveFileToSystemResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() == Activity.RESULT_OK) {
            Intent data = result.getData();
            if (data != null && data.getData() != null) {
                Uri destUri = data.getData();
                String fileUri = this.pendingSaveFileUri;
                
                try {
                    Context context = getContext();
                    Uri srcUri = Uri.parse(fileUri);
                    
                    InputStream is = null;
                    if (fileUri.startsWith("content://")) {
                        is = context.getContentResolver().openInputStream(srcUri);
                    } else {
                        String filePath = srcUri.getPath();
                        is = new FileInputStream(new File(filePath));
                    }
                    
                    if (is == null) {
                        call.reject("Cannot open source file: " + fileUri);
                        return;
                    }

                    try (OutputStream os = context.getContentResolver().openOutputStream(destUri)) {
                        byte[] buffer = new byte[262144];
                        int read;
                        while ((read = is.read(buffer)) != -1) {
                            os.write(buffer, 0, read);
                        }
                        
                        JSObject ret = new JSObject();
                        ret.put("path", destUri.toString());
                        call.resolve(ret);
                    } finally {
                        is.close();
                    }
                } catch (Exception e) {
                    call.reject("Copy to chosen location failed: " + e.getMessage());
                }
            } else {
                call.reject("No destination file URI returned from file chooser");
            }
        } else {
            call.reject("User cancelled save dialog");
        }
    }

    @PluginMethod
    public void getSafeAreaInsets(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("top", 0);
        ret.put("bottom", 0);
        ret.put("left", 0);
        ret.put("right", 0);
        call.resolve(ret);
    }

    @PluginMethod
    public void createZipFromDirectory(PluginCall call) {
        String sourcePath = call.getString("sourcePath");
        String outputFilename = call.getString("outputFilename");
        if (sourcePath == null || outputFilename == null) {
            call.reject("Missing sourcePath or outputFilename");
            return;
        }

        try {
            File cacheDir = getContext().getCacheDir();
            File sourceDir = new File(cacheDir, sourcePath);
            File outputFile = new File(cacheDir, outputFilename);

            if (!sourceDir.exists() || !sourceDir.isDirectory()) {
                call.reject("Source directory does not exist: " + sourceDir.getAbsolutePath());
                return;
            }

            try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(outputFile))) {
                zos.setLevel(Deflater.NO_COMPRESSION);
                addDirectoryToZip(zos, sourceDir, "");
            }

            JSObject ret = new JSObject();
            ret.put("uri", Uri.fromFile(outputFile).toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("ZIP creation failed: " + e.getMessage());
        }
    }

    private void addDirectoryToZip(ZipOutputStream zos, File dir, String parentPath) throws IOException {
        File[] files = dir.listFiles();
        if (files == null) return;

        for (File file : files) {
            String entryName = parentPath.isEmpty() ? file.getName() : parentPath + "/" + file.getName();
            if (file.isDirectory()) {
                addDirectoryToZip(zos, file, entryName);
            } else {
                zos.putNextEntry(new ZipEntry(entryName));
                try (FileInputStream fis = new FileInputStream(file)) {
                    byte[] buffer = new byte[262144]; // 256KB buffer
                    int len;
                    while ((len = fis.read(buffer)) > 0) {
                        zos.write(buffer, 0, len);
                    }
                }
                zos.closeEntry();
            }
        }
    }

    private String escapeXml(String unsafe) {
        if (unsafe == null) return "";
        return unsafe.replace("&", "&amp;")
                     .replace("<", "&lt;")
                     .replace(">", "&gt;")
                     .replace("\"", "&quot;")
                     .replace("'", "&apos;");
    }
}
