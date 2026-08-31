package com.edgereader.app;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class EdgeTtsFrameParser {
    enum Kind { AUDIO, NONTERMINAL, TURN_END }

    static final class Frame {
        final Kind kind;
        final byte[] payload;
        Frame(Kind kind, byte[] payload) { this.kind = kind; this.payload = payload; }
    }

    static final class ProtocolException extends Exception {
        ProtocolException() { super(NativeError.PROTOCOL_ERROR.message()); }
        String getCode() { return NativeError.PROTOCOL_ERROR.name(); }
    }

    private EdgeTtsFrameParser() {}

    static Frame parseBinary(byte[] data, String expectedRequestId) throws ProtocolException {
        if (data == null || data.length < 3) throw new ProtocolException();
        int headerLength = ((data[0] & 0xff) << 8) | (data[1] & 0xff);
        if (headerLength <= 0 || headerLength > data.length - 3 || headerLength == data.length - 2) {
            throw new ProtocolException();
        }
        String headerBlock = decodeUtf8(data, 2, headerLength);
        Map<String, String> headers = parseHeaders(headerBlock);
        require(headers, "path", "audio");
        require(headers, "x-requestid", expectedRequestId);
        require(headers, "content-type", "audio/mpeg");
        byte[] payload = new byte[data.length - headerLength - 2];
        System.arraycopy(data, headerLength + 2, payload, 0, payload.length);
        return new Frame(Kind.AUDIO, payload);
    }

    static Frame parseText(String message, String expectedRequestId) throws ProtocolException {
        if (message == null) throw new ProtocolException();
        int separator = message.indexOf("\r\n\r\n");
        if (separator <= 0 || message.indexOf("\r\n\r\n", separator + 4) >= 0) throw new ProtocolException();
        Map<String, String> headers = parseHeaders(message.substring(0, separator + 2));
        require(headers, "x-requestid", expectedRequestId);
        String contentType = headers.get("content-type");
        if (!"application/json; charset=utf-8".equals(contentType)) throw new ProtocolException();
        String path = headers.get("path");
        Kind kind;
        if ("turn.end".equals(path)) kind = Kind.TURN_END;
        else if ("turn.start".equals(path) || "response".equals(path)) kind = Kind.NONTERMINAL;
        else throw new ProtocolException();
        String body = message.substring(separator + 4);
        if (!"{}".equals(body)) throw new ProtocolException();
        return new Frame(kind, new byte[0]);
    }

    private static Map<String, String> parseHeaders(String block) throws ProtocolException {
        if (block.isEmpty() || !block.endsWith("\r\n") || block.indexOf('\0') >= 0
                || block.contains("\n") && !block.contains("\r\n")) {
            throw new ProtocolException();
        }
        Map<String, String> headers = new LinkedHashMap<>();
        String[] lines = block.split("\\r\\n", -1);
        for (String line : lines) {
            if (line.isEmpty()) continue;
            int colon = line.indexOf(':');
            if (colon <= 0 || colon == line.length() - 1 || line.indexOf(':', colon + 1) >= 0) throw new ProtocolException();
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            if (!name.matches("[a-z0-9-]+") || value.isEmpty() || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0
                    || containsControlCharacter(name) || containsControlCharacter(value)) {
                throw new ProtocolException();
            }
            if (headers.put(name, value) != null) throw new ProtocolException();
        }
        return headers;
    }

    private static void require(Map<String, String> headers, String name, String expected) throws ProtocolException {
        if (!expected.equals(headers.get(name))) throw new ProtocolException();
    }

    private static String decodeUtf8(byte[] data, int offset, int length) throws ProtocolException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data, offset, length)).toString();
        } catch (CharacterCodingException error) {
            throw new ProtocolException();
        }
    }

    private static boolean containsControlCharacter(String value) {
        for (int i = 0; i < value.length(); i++) {
            if (Character.isISOControl(value.charAt(i))) return true;
        }
        return false;
    }
}
