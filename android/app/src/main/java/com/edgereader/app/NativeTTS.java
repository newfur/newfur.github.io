package com.edgereader.app;

import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(name = "NativeTTS")
public class NativeTTS extends Plugin {

    private static final String TAG = "NativeTTS";

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

        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build();

        Request request = new Request.Builder()
                .url(url)
                .addHeader("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold")
                .addHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0")
                .build();

        ByteArrayOutputStream audioStream = new ByteArrayOutputStream();

        client.newWebSocket(request, new WebSocketListener() {
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

                byte[] headerBytes = new byte[headerLength - 2];
                System.arraycopy(array, 2, headerBytes, 0, headerLength - 2);
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
                if (hasRejected) return;
                byte[] audioData = audioStream.toByteArray();
                if (audioData.length > 0) {
                    String base64Audio = Base64.encodeToString(audioData, Base64.NO_WRAP);
                    JSObject ret = new JSObject();
                    ret.put("audioBase64", base64Audio);
                    call.resolve(ret);
                } else {
                    call.reject("No audio data received from Edge TTS");
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (hasRejected) return;
                hasRejected = true;
                call.reject("WebSocket failure: " + t.getMessage());
            }
        });
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
