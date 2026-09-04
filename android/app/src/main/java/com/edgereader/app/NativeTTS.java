package com.edgereader.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.InputStream;
import java.io.FileInputStream;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import android.app.Activity;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
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
    private final ConcurrentHashMap<String, WebSocket> activeTasks = new ConcurrentHashMap<>();

    @Override
    public void load() {
        super.load();
        instance = this;
    }

    private static OkHttpClient okHttpClient;
    private static synchronized OkHttpClient getOkHttpClient() {
        if (okHttpClient == null) {
            okHttpClient = new OkHttpClient.Builder()
                    .connectTimeout(12, TimeUnit.SECONDS)
                    .readTimeout(12, TimeUnit.SECONDS)
                    .build();
        }
        return okHttpClient;
    }

    public void sendMediaAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("mediaAction", data);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (instance == this) {
            instance = null;
        }
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        try {
            Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
                    Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(android.net.Uri.parse("package:" + context.getPackageName()));
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

        WebSocket ws = client.newWebSocket(request, new WebSocketListener() {
            private boolean hasRejected = false;

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
                    webSocket.close(1000, "Finished");
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
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                activeTasks.remove(connectionId);
                if (hasRejected) return;
                byte[] audioData = audioStream.toByteArray();
                if (audioData.length > 0) {
                    String base64Audio = Base64.encodeToString(audioData, Base64.NO_WRAP);
                    JSObject ret = new JSObject();
                    ret.put("audioBase64", base64Audio);
                    call.resolve(ret);
                } else {
                    // 若伺服器正常結束但未返回音訊幀（例如僅含標點符號的句子），返回極短靜音 MP3 避免前端崩潰
                    JSObject ret = new JSObject();
                    ret.put("audioBase64", "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV");
                    call.resolve(ret);
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                activeTasks.remove(connectionId);
                if (hasRejected) return;
                hasRejected = true;
                call.reject("WebSocket failure: " + t.getMessage());
            }
        });
        activeTasks.put(connectionId, ws);
    }

    @PluginMethod
    public void cancelTTS(PluginCall call) {
        String connectionId = call.getString("connectionId");
        if (connectionId != null) {
            WebSocket ws = activeTasks.remove(connectionId);
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
        for (WebSocket ws : activeTasks.values()) {
            try {
                ws.cancel();
            } catch (Exception ignored) {}
        }
        activeTasks.clear();
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
                // Use STORED-equivalent: DEFLATED with no compression (avoids needing CRC pre-computation)
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
