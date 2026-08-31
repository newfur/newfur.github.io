package com.edgereader.app;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class EdgeTtsFrameParser {
    static final int MAX_CONTROL_BODY_BYTES = 16 * 1024;
    enum Kind { AUDIO, TURN_START, RESPONSE, TURN_END }

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
        else if ("turn.start".equals(path)) kind = Kind.TURN_START;
        else if ("response".equals(path)) kind = Kind.RESPONSE;
        else throw new ProtocolException();
        String body = message.substring(separator + 4);
        validateJsonObject(body);
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

    private static void validateJsonObject(String body) throws ProtocolException {
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_CONTROL_BODY_BYTES) throw new ProtocolException();
        JsonCursor cursor = new JsonCursor(body);
        cursor.skipWhitespace();
        if (!cursor.consume('{')) throw new ProtocolException();
        cursor.skipWhitespace();
        if (cursor.consume('}')) throw new ProtocolException();
        cursor.parseObjectContents();
        cursor.skipWhitespace();
        if (!cursor.atEnd()) throw new ProtocolException();
    }

    private static final class JsonCursor {
        private final String value;
        private int offset;

        JsonCursor(String value) { this.value = value; }

        boolean atEnd() { return offset == value.length(); }

        void skipWhitespace() {
            while (!atEnd()) {
                char c = value.charAt(offset);
                if (c != ' ' && c != '\t' && c != '\r' && c != '\n') return;
                offset++;
            }
        }

        boolean consume(char expected) {
            if (atEnd() || value.charAt(offset) != expected) return false;
            offset++;
            return true;
        }

        void require(char expected) throws ProtocolException {
            if (!consume(expected)) throw new ProtocolException();
        }

        void parseObjectContents() throws ProtocolException {
            skipWhitespace();
            if (consume('}')) return;
            while (true) {
                parseString();
                skipWhitespace();
                require(':');
                parseValue();
                skipWhitespace();
                if (consume('}')) return;
                require(',');
                skipWhitespace();
            }
        }

        void parseArrayContents() throws ProtocolException {
            skipWhitespace();
            if (consume(']')) return;
            while (true) {
                parseValue();
                skipWhitespace();
                if (consume(']')) return;
                require(',');
                skipWhitespace();
            }
        }

        void parseValue() throws ProtocolException {
            skipWhitespace();
            if (atEnd()) throw new ProtocolException();
            char c = value.charAt(offset);
            if (c == '"') parseString();
            else if (consume('{')) parseObjectContents();
            else if (consume('[')) parseArrayContents();
            else if (c == 't') parseLiteral("true");
            else if (c == 'f') parseLiteral("false");
            else if (c == 'n') parseLiteral("null");
            else parseNumber();
        }

        void parseString() throws ProtocolException {
            require('"');
            while (!atEnd()) {
                char c = value.charAt(offset++);
                if (c == '"') return;
                if (c < 0x20) throw new ProtocolException();
                if (c != '\\') continue;
                if (atEnd()) throw new ProtocolException();
                char escaped = value.charAt(offset++);
                if (escaped == 'u') {
                    if (offset + 4 > value.length()) throw new ProtocolException();
                    for (int i = 0; i < 4; i++) if (Character.digit(value.charAt(offset++), 16) < 0) throw new ProtocolException();
                } else if ("\"\\/bfnrt".indexOf(escaped) < 0) {
                    throw new ProtocolException();
                }
            }
            throw new ProtocolException();
        }

        void parseLiteral(String literal) throws ProtocolException {
            if (!value.regionMatches(offset, literal, 0, literal.length())) throw new ProtocolException();
            offset += literal.length();
        }

        void parseNumber() throws ProtocolException {
            int start = offset;
            consume('-');
            if (consume('0')) {
                if (!atEnd() && Character.isDigit(value.charAt(offset))) throw new ProtocolException();
            } else {
                if (atEnd() || value.charAt(offset) < '1' || value.charAt(offset) > '9') throw new ProtocolException();
                while (!atEnd() && Character.isDigit(value.charAt(offset))) offset++;
            }
            if (consume('.')) {
                int fraction = offset;
                while (!atEnd() && Character.isDigit(value.charAt(offset))) offset++;
                if (fraction == offset) throw new ProtocolException();
            }
            if (!atEnd() && (value.charAt(offset) == 'e' || value.charAt(offset) == 'E')) {
                offset++;
                if (!atEnd() && (value.charAt(offset) == '+' || value.charAt(offset) == '-')) offset++;
                int exponent = offset;
                while (!atEnd() && Character.isDigit(value.charAt(offset))) offset++;
                if (exponent == offset) throw new ProtocolException();
            }
            if (start == offset) throw new ProtocolException();
        }
    }
}
