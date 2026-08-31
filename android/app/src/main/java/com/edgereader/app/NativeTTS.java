package com.edgereader.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(
        name = "NativeTTS",
        permissions = @Permission(alias = "notifications", strings = Manifest.permission.POST_NOTIFICATIONS))
public class NativeTTS extends Plugin implements PlaybackSessionRegistry.Receiver {
    private static final long MAX_AUDIO_BYTES = 32L * 1024 * 1024;
    private static final PlaybackSessionRegistry PLAYBACK_REGISTRY = new PlaybackSessionRegistry();
    private static final OkHttpClient HTTP_CLIENT = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build();

    private final ConcurrentHashMap<String, WebSocket> webSockets = new ConcurrentHashMap<>();
    private final AtomicBoolean pickerBusy = new AtomicBoolean();
    private volatile String playbackSessionId;

    @Override
    public void onMediaAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("sessionId", playbackSessionId);
        notifyListeners("mediaAction", data);
    }

    static boolean deliverMediaAction(String sessionId, String action) {
        return PLAYBACK_REGISTRY.deliver(sessionId, action);
    }

    @PluginMethod
    public void startForegroundService(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            call.reject("Playback session is invalid", "INVALID_SESSION");
            return;
        }
        playbackSessionId = sessionId;
        PLAYBACK_REGISTRY.register(sessionId, this);
        Intent intent = serviceIntent(AudioPlayerService.ACTION_START, sessionId);
        intent.putExtra(AudioPlayerService.EXTRA_TITLE, bounded(call.getString("title", ""), 512));
        intent.putExtra(AudioPlayerService.EXTRA_ARTIST, bounded(call.getString("artist", ""), 512));
        intent.putExtra(AudioPlayerService.EXTRA_TEXT, bounded(call.getString("text", ""), 4096));
        intent.putExtra(AudioPlayerService.EXTRA_COVER, bounded(call.getString("cover", ""), AudioPlayerService.MAX_COVER_EXTRA_CHARS));
        intent.putExtra(AudioPlayerService.EXTRA_IS_PLAYING, call.getBoolean("isPlaying", false));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            JSObject result = notificationStatus();
            call.resolve(result);
        } catch (RuntimeException error) {
            PLAYBACK_REGISTRY.unregister(sessionId);
            if (sessionId.equals(playbackSessionId)) playbackSessionId = null;
            call.reject("Playback controls are unavailable", "SERVICE_UNAVAILABLE");
        }
    }

    @PluginMethod
    public void updatePlaybackState(PluginCall call) {
        sendServiceUpdate(call, AudioPlayerService.ACTION_UPDATE_STATE);
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        sendServiceUpdate(call, AudioPlayerService.ACTION_UPDATE_METADATA);
    }

    private void sendServiceUpdate(PluginCall call, String action) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || !sessionId.equals(playbackSessionId)) {
            call.reject("Playback session is stale", "STALE_SESSION");
            return;
        }
        Intent intent = serviceIntent(action, sessionId);
        intent.putExtra(AudioPlayerService.EXTRA_IS_PLAYING, call.getBoolean("isPlaying", false));
        intent.putExtra(AudioPlayerService.EXTRA_TITLE, bounded(call.getString("title", ""), 512));
        intent.putExtra(AudioPlayerService.EXTRA_ARTIST, bounded(call.getString("artist", ""), 512));
        intent.putExtra(AudioPlayerService.EXTRA_TEXT, bounded(call.getString("text", ""), 4096));
        try {
            getContext().startService(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Playback controls are unavailable", "SERVICE_UNAVAILABLE");
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || !sessionId.equals(playbackSessionId)) {
            call.resolve();
            return;
        }
        getContext().startService(serviceIntent(AudioPlayerService.ACTION_STOP_SESSION, sessionId));
        PLAYBACK_REGISTRY.unregister(sessionId);
        playbackSessionId = null;
        call.resolve();
    }

    private Intent serviceIntent(String action, String sessionId) {
        return new Intent(getContext(), AudioPlayerService.class).setAction(action)
                .putExtra(AudioPlayerService.EXTRA_SESSION_ID, sessionId);
    }

    @PluginMethod
    public void getNotificationStatus(PluginCall call) { call.resolve(notificationStatus()); }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(notificationStatus());
        } else {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) { call.resolve(notificationStatus()); }

    private JSObject notificationStatus() {
        PermissionState state = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                ? PermissionState.GRANTED : getPermissionState("notifications");
        boolean granted = state == PermissionState.GRANTED;
        JSObject result = new JSObject();
        result.put("display", state.toString());
        result.put("controlsAvailable", granted);
        return result;
    }

    @PluginMethod
    public void downloadTTS(PluginCall call) {
        String text = call.getString("text");
        String voice = call.getString("voice");
        String connectionId = call.getString("connectionId");
        String secMsGec = call.getString("secMsGec");
        String dateStr = call.getString("dateStr");
        if (text == null || voice == null || connectionId == null || secMsGec == null || dateStr == null) {
            call.reject("Missing required parameters", "INVALID_ARGUMENT");
            return;
        }
        String url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
                + "?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=" + connectionId
                + "&Sec-MS-GEC=" + secMsGec + "&Sec-MS-GEC-Version=1-143.0.3650.75";
        Request request = new Request.Builder().url(url)
                .addHeader("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .addHeader("User-Agent", "Mozilla/5.0 Edg/143.0.0.0").build();
        ByteArrayOutputStream audio = new ByteArrayOutputStream();
        AtomicBoolean settled = new AtomicBoolean();
        WebSocket socket = HTTP_CLIENT.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                webSockets.put(connectionId, ws);
                ws.send("X-Timestamp:" + dateStr + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
                        + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}");
                ws.send("X-RequestId:" + connectionId + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:"
                        + dateStr + "Z\r\nPath:ssml\r\n\r\n" + SsmlBuilder.build(text, voice, call.getString("rate", "+0%"), call.getString("volume", "+0%")));
            }
            @Override public void onMessage(WebSocket ws, String message) {
                if (message.contains("Path:turn.end")) ws.close(1000, "Finished");
            }
            @Override public void onMessage(WebSocket ws, ByteString bytes) {
                byte[] data = bytes.toByteArray();
                if (data.length < 2) return;
                int headerLength = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
                if (headerLength + 2 > data.length) return;
                String headers = new String(data, 2, headerLength, StandardCharsets.UTF_8);
                int length = data.length - headerLength - 2;
                if (!headers.contains("Path:audio")) return;
                if (audio.size() > MAX_AUDIO_BYTES - length) {
                    if (settled.compareAndSet(false, true)) call.reject("Audio response is too large", "AUDIO_TOO_LARGE");
                    ws.cancel();
                    return;
                }
                audio.write(data, headerLength + 2, length);
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                webSockets.remove(connectionId, ws);
                if (!settled.compareAndSet(false, true)) return;
                if (audio.size() == 0) call.reject("No audio data received", "EMPTY_AUDIO");
                else {
                    JSObject result = new JSObject();
                    result.put("audioBase64", Base64.encodeToString(audio.toByteArray(), Base64.NO_WRAP));
                    call.resolve(result);
                }
            }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                webSockets.remove(connectionId, ws);
                if (settled.compareAndSet(false, true)) call.reject("TTS connection failed", "NETWORK_FAILURE");
            }
        });
        webSockets.put(connectionId, socket);
    }

    @PluginMethod
    public void cancelTTS(PluginCall call) {
        String connectionId = call.getString("connectionId");
        WebSocket socket = connectionId == null ? null : webSockets.remove(connectionId);
        if (socket != null) socket.cancel();
        call.resolve();
    }

    @PluginMethod
    public void copyFileToDownloads(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            launchSavePicker(call);
            return;
        }
        try (InputStream input = openApprovedSource(call.getString("fileUri"))) {
            String filename = requireFilename(call.getString("filename"));
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri destination = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
            try (OutputStream output = getContext().getContentResolver().openOutputStream(destination)) {
                if (output == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
                copy(input, output);
            } catch (Exception error) {
                getContext().getContentResolver().delete(destination, null, null);
                throw error;
            }
            ContentValues published = new ContentValues();
            published.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContext().getContentResolver().update(destination, published, null, null);
            JSObject result = new JSObject();
            result.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + filename);
            call.resolve(result);
        } catch (NativeBoundaryException error) {
            reject(call, error);
        } catch (Exception error) {
            reject(call, new NativeBoundaryException(NativeError.COPY_FAILED, error));
        }
    }

    @PluginMethod
    public void saveFileToSystem(PluginCall call) { launchSavePicker(call); }

    private void launchSavePicker(PluginCall call) {
        try {
            requireFilename(call.getString("filename"));
            validateSource(call.getString("fileUri"));
            if (!pickerBusy.compareAndSet(false, true)) {
                call.reject("Another save operation is active", "DESTINATION_UNAVAILABLE");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip");
            intent.putExtra(Intent.EXTRA_TITLE, call.getString("filename"));
            startActivityForResult(call, intent, "saveFileToSystemResult");
        } catch (NativeBoundaryException error) {
            reject(call, error);
        }
    }

    @ActivityCallback
    private void saveFileToSystemResult(PluginCall call, ActivityResult activityResult) {
        pickerBusy.set(false);
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK) {
            call.reject(NativeError.USER_CANCELLED.message(), NativeError.USER_CANCELLED.name());
            return;
        }
        Uri destination = activityResult.getData() == null ? null : activityResult.getData().getData();
        if (destination == null) {
            call.reject(NativeError.DESTINATION_UNAVAILABLE.message(), NativeError.DESTINATION_UNAVAILABLE.name());
            return;
        }
        try (InputStream input = openApprovedSource(call.getString("fileUri"));
             OutputStream output = getContext().getContentResolver().openOutputStream(destination)) {
            if (output == null) throw new NativeBoundaryException(NativeError.DESTINATION_UNAVAILABLE);
            copy(input, output);
            JSObject result = new JSObject();
            result.put("path", destination.toString());
            call.resolve(result);
        } catch (NativeBoundaryException error) {
            reject(call, error);
        } catch (Exception error) {
            reject(call, new NativeBoundaryException(NativeError.COPY_FAILED, error));
        }
    }

    @PluginMethod
    public void createZipFromDirectory(PluginCall call) {
        String sourceId = call.getString("sourcePath");
        String outputName = call.getString("outputFilename");
        if (!"backup_temp".equals(sourceId)) {
            call.reject(NativeError.SOURCE_NOT_ALLOWED.message(), NativeError.SOURCE_NOT_ALLOWED.name());
            return;
        }
        try {
            String filename = requireFilename(outputName);
            File source = new File(getContext().getCacheDir(), "backup_temp");
            File output = new File(getContext().getCacheDir(), filename);
            if (!source.isDirectory()) throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND);
            if (!NativeFileBoundary.isWithin(getContext().getCacheDir(), source)
                    || !NativeFileBoundary.isWithin(getContext().getCacheDir(), output)) {
                throw new NativeBoundaryException(NativeError.SOURCE_NOT_ALLOWED);
            }
            SafeZipWriter.write(source, output, SafeZipWriter.DEFAULT_LIMITS);
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", output);
            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            call.resolve(result);
        } catch (NativeBoundaryException error) {
            reject(call, error);
        } catch (FileNotFoundException error) {
            reject(call, new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND, error));
        } catch (Exception error) {
            reject(call, new NativeBoundaryException(NativeError.COPY_FAILED, error));
        }
    }

    @PluginMethod
    public void getSafeAreaInsets(PluginCall call) {
        JSObject result = new JSObject();
        result.put("top", 0); result.put("bottom", 0); result.put("left", 0); result.put("right", 0);
        call.resolve(result);
    }

    private void validateSource(String rawUri) throws NativeBoundaryException {
        try (InputStream ignored = openApprovedSource(rawUri)) {
            // Opening verifies both canonical file ownership and content grant access.
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (IOException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND, error);
        }
    }

    private InputStream openApprovedSource(String rawUri) throws NativeBoundaryException {
        if (rawUri == null || rawUri.isEmpty()) throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI);
        try {
            URI uri = new URI(rawUri);
            NativeFileBoundary.SourceKind kind = NativeFileBoundary.classifySource(
                    getContext().getCacheDir(), getContext().getFilesDir(), uri);
            InputStream input;
            if (kind == NativeFileBoundary.SourceKind.CONTENT) input = getContext().getContentResolver().openInputStream(Uri.parse(rawUri));
            else if (kind == NativeFileBoundary.SourceKind.APP_FILE) input = new FileInputStream(new File(uri));
            else throw new NativeBoundaryException(NativeError.SOURCE_NOT_ALLOWED);
            if (input == null) throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND);
            return input;
        } catch (NativeBoundaryException error) {
            throw error;
        } catch (URISyntaxException error) {
            throw new NativeBoundaryException(NativeError.INVALID_SOURCE_URI, error);
        } catch (FileNotFoundException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_FOUND, error);
        } catch (IOException | SecurityException error) {
            throw new NativeBoundaryException(NativeError.SOURCE_NOT_ALLOWED, error);
        }
    }

    private static String requireFilename(String filename) throws NativeBoundaryException {
        if (!NativeFileBoundary.isSafeFilename(filename)) throw new NativeBoundaryException(NativeError.INVALID_FILENAME);
        return filename;
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }

    private static String bounded(String value, int maxLength) {
        if (value == null) return "";
        return value.length() <= maxLength ? value : value.substring(0, maxLength);
    }

    private static void reject(PluginCall call, NativeBoundaryException error) {
        call.reject(error.getMessage(), error.getCode());
    }

    @Override
    protected void handleOnDestroy() {
        String sessionId = playbackSessionId;
        playbackSessionId = null;
        PLAYBACK_REGISTRY.unregister(sessionId);
        pickerBusy.set(false);
        for (WebSocket socket : webSockets.values()) socket.cancel();
        webSockets.clear();
        super.handleOnDestroy();
    }
}
