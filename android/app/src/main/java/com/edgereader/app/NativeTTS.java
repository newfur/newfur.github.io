package com.edgereader.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
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

    private final ConcurrentHashMap<String, NativeTtsRequest> ttsRequests = new ConcurrentHashMap<>();
    private NativeExportController exportController;
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
            JSObject result = notificationStatus(true);
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
    public void getNotificationStatus(PluginCall call) { call.resolve(notificationStatus(false)); }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve(notificationStatus(false));
        } else {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) { call.resolve(notificationStatus(false)); }

    private JSObject notificationStatus(boolean serviceStarted) {
        PermissionState state = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                ? PermissionState.GRANTED : getPermissionState("notifications");
        NativeNotificationStatus status = NativeNotificationStatus.forPermission(state.toString(), serviceStarted);
        JSObject result = new JSObject();
        result.put("notificationPermission", status.permission);
        result.put("controlsAvailable", status.controlsAvailable);
        result.put("serviceStarted", status.serviceStarted);
        return result;
    }

    @PluginMethod
    public void downloadTTS(PluginCall call) {
        final TtsRequestValidator.Request validated;
        try {
            validated = TtsRequestValidator.validate(
                    call.getString("text"), call.getString("voice"), call.getString("connectionId"),
                    call.getString("secMsGec"), call.getString("dateStr"),
                    call.getString("rate", "+0%"), call.getString("volume", "+0%"));
        } catch (NativeBoundaryException error) {
            reject(call, error);
            return;
        }
        String url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
                + "?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=" + validated.connectionId
                + "&Sec-MS-GEC=" + validated.token + "&Sec-MS-GEC-Version=1-143.0.3650.75";
        Request request = new Request.Builder().url(url)
                .addHeader("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .addHeader("User-Agent", "Mozilla/5.0 Edg/143.0.0.0").build();
        ByteArrayOutputStream audio = new ByteArrayOutputStream();
        NativeTtsRequest operation = new NativeTtsRequest(new NativeTtsRequest.Sink() {
            @Override public void resolve(String encodedAudio) {
                JSObject result = new JSObject();
                result.put("audioBase64", encodedAudio);
                call.resolve(result);
            }
            @Override public void reject(String code, String message) { call.reject(message, code); }
        });
        if (ttsRequests.putIfAbsent(validated.connectionId, operation) != null) {
            call.reject("TTS connection ID is already active", NativeError.INVALID_CONNECTION_ID.name());
            return;
        }
        AtomicReference<WebSocket> socketReference = new AtomicReference<>();
        operation.setCancelAction(() -> {
            WebSocket active = socketReference.get();
            if (active != null) active.cancel();
            ttsRequests.remove(validated.connectionId, operation);
        });
        WebSocket socket;
        try {
            socket = HTTP_CLIENT.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                ws.send("X-Timestamp:" + validated.date + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
                        + "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}");
                ws.send("X-RequestId:" + validated.connectionId + "\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:"
                        + validated.date + "Z\r\nPath:ssml\r\n\r\n" + validated.ssml);
            }
            @Override public void onMessage(WebSocket ws, String message) {
                try {
                    EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseText(message, validated.connectionId);
                    if (frame.kind == EdgeTtsFrameParser.Kind.TURN_END) ws.close(1000, "Finished");
                } catch (EdgeTtsFrameParser.ProtocolException error) {
                    ttsRequests.remove(validated.connectionId, operation);
                    operation.fail(error.getCode(), error.getMessage());
                    ws.cancel();
                }
            }
            @Override public void onMessage(WebSocket ws, ByteString bytes) {
                try {
                    EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseBinary(bytes.toByteArray(), validated.connectionId);
                    int length = frame.payload.length;
                    if (audio.size() > MAX_AUDIO_BYTES - length) {
                        ttsRequests.remove(validated.connectionId, operation);
                        operation.fail("AUDIO_TOO_LARGE", "Audio response is too large");
                        ws.cancel();
                        return;
                    }
                    audio.write(frame.payload, 0, length);
                } catch (EdgeTtsFrameParser.ProtocolException error) {
                    ttsRequests.remove(validated.connectionId, operation);
                    operation.fail(error.getCode(), error.getMessage());
                    ws.cancel();
                }
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                ttsRequests.remove(validated.connectionId, operation);
                if (audio.size() == 0) operation.fail("EMPTY_AUDIO", "No audio data received");
                else operation.succeed(Base64.encodeToString(audio.toByteArray(), Base64.NO_WRAP));
            }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                ttsRequests.remove(validated.connectionId, operation);
                operation.fail("NETWORK_FAILURE", "TTS connection failed");
            }
            });
            socketReference.set(socket);
            if (operation.isCancelled()) socket.cancel();
        } catch (RuntimeException error) {
            ttsRequests.remove(validated.connectionId, operation);
            operation.fail("NETWORK_FAILURE", "TTS connection failed");
        }
    }

    @PluginMethod
    public void cancelTTS(PluginCall call) {
        String connectionId = call.getString("connectionId");
        NativeTtsRequest operation = connectionId == null ? null : ttsRequests.remove(connectionId);
        if (operation != null) operation.cancel();
        call.resolve();
    }

    @PluginMethod
    public void copyFileToDownloads(PluginCall call) {
        NativeExportController controller = exportController();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            launchSavePicker(call);
            return;
        }
        try {
            String path = controller.copyToDownloads(call.getString("fileUri"), call.getString("filename"));
            JSObject result = new JSObject();
            result.put("path", path);
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
            Intent intent = exportController().beginSaf(call.getString("fileUri"), call.getString("filename"));
            startActivityForResult(call, intent, "saveFileToSystemResult");
        } catch (NativeBoundaryException error) {
            reject(call, error);
        }
    }

    @ActivityCallback
    private void saveFileToSystemResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) {
            exportController().clear();
            return;
        }
        try {
            String path = exportController().completeSaf(activityResult);
            JSObject result = new JSObject();
            result.put("path", path);
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
            if (!NativeFileBoundary.isSafeFilename(outputName)) throw new NativeBoundaryException(NativeError.INVALID_FILENAME);
            String filename = outputName;
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
        if (exportController != null) exportController.clear();
        for (NativeTtsRequest request : ttsRequests.values()) request.cancel();
        ttsRequests.clear();
        super.handleOnDestroy();
    }

    private NativeExportController exportController() {
        if (exportController == null) exportController = new NativeExportController(getContext());
        return exportController;
    }
}
