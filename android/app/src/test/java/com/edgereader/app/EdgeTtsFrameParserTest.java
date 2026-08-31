package com.edgereader.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class EdgeTtsFrameParserTest {
    private static final String REQUEST_ID = "0123456789abcdef0123456789abcdef";

    @Test public void parsesValidAudioFrame() throws Exception {
        byte[] audio = { 1, 2, 3 };
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", audio), REQUEST_ID);
        assertEquals(EdgeTtsFrameParser.Kind.AUDIO, frame.kind);
        assertArrayEquals(audio, frame.payload);
    }

    @Test public void parsesExactTurnEnd() throws Exception {
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\n\r\n{\"offset\":42}",
                REQUEST_ID);
        assertEquals(EdgeTtsFrameParser.Kind.TURN_END, frame.kind);
    }

    @Test public void acceptsValidatedNonterminalTextFrames() throws Exception {
        EdgeTtsFrameParser.Frame start = EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.start\r\n\r\n{\"context\":{\"serviceTag\":\"edge\"}}",
                REQUEST_ID);
        EdgeTtsFrameParser.Frame response = EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:response\r\n\r\n{\"status\":200,\"ok\":true}",
                REQUEST_ID);
        assertEquals(EdgeTtsFrameParser.Kind.TURN_START, start.kind);
        assertEquals(EdgeTtsFrameParser.Kind.RESPONSE, response.kind);
    }

    @Test public void validSessionRequiresStartAudioAndTurnEnd() throws Exception {
        EdgeTtsProtocolState state = new EdgeTtsProtocolState(REQUEST_ID);
        state.acceptText(control("turn.start", "{\"request\":{\"locale\":\"en-US\"}}"));
        state.acceptText(control("response", "{\"status\":200}"));
        state.acceptBinary(binary("X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[] { 4, 5 }));
        state.acceptText(control("turn.end", "{\"offset\":2}"));
        assertArrayEquals(new byte[] { 4, 5 }, state.complete());
    }

    @Test public void closeWithPartialAudioRejectsIncompleteAudio() throws Exception {
        EdgeTtsProtocolState state = new EdgeTtsProtocolState(REQUEST_ID);
        state.acceptText(control("turn.start", "{\"request\":1}"));
        state.acceptText(control("response", "{\"status\":200}"));
        state.acceptBinary(binary("X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[] { 4, 5 }));
        try {
            state.complete();
            fail("Expected incomplete audio");
        } catch (NativeBoundaryException error) {
            assertEquals("INCOMPLETE_AUDIO", error.getCode());
        }
    }

    @Test public void rejectsEveryOutOfOrderOrDuplicateControlSequence() throws Exception {
        assertStateProtocol(state -> state.acceptText(control("response", "{\"status\":200}")));
        assertStateProtocol(state -> state.acceptText(control("turn.end", "{\"done\":true}")));
        assertStateProtocol(state -> state.acceptBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[] { 1 })));

        assertStateProtocol(state -> {
            state.acceptText(control("turn.start", "{\"request\":1}"));
            state.acceptText(control("turn.start", "{\"request\":2}"));
        });
        assertStateProtocol(state -> {
            state.acceptText(control("turn.start", "{\"request\":1}"));
            state.acceptBinary(binary("X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[] { 1 }));
        });
        assertStateProtocol(state -> {
            state.acceptText(control("turn.start", "{\"request\":1}"));
            state.acceptText(control("response", "{\"status\":200}"));
            state.acceptText(control("response", "{\"status\":201}"));
        });
        assertStateProtocol(state -> {
            state.acceptText(control("turn.start", "{\"request\":1}"));
            state.acceptText(control("response", "{\"status\":200}"));
            state.acceptText(control("turn.end", "{\"done\":true}"));
            state.acceptText(control("turn.end", "{\"done\":true}"));
        });
    }

    @Test public void validatesBoundedJsonObjectControlBodies() throws Exception {
        EdgeTtsFrameParser.parseText(control("turn.start", " { \"nested\" : [1, true, null, {\"x\":\"y\"}] } "), REQUEST_ID);
        assertProtocol(() -> EdgeTtsFrameParser.parseText(control("turn.start", "{}"), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(control("turn.start", "[]"), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(control("turn.start", "{\"broken\":}"), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(control("turn.start", "{\"x\":1} trailing"), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(control("turn.start", "{\"x\":\"" +
                "a".repeat(EdgeTtsFrameParser.MAX_CONTROL_BODY_BYTES) + "\"}"), REQUEST_ID));
    }

    @Test public void rejectsMalformedBinarySizes() {
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(new byte[] { 0 }, REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(new byte[] { 0, 20, 1, 2 }, REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(new byte[] { 0, 0 }, REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary("Path:audio", new byte[0]), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[0]), REQUEST_ID));
    }

    @Test public void rejectsMissingDuplicateAndUnexpectedPaths() {
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\nPath:audio\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:turn.end\r\n", new byte[] { 1 }), REQUEST_ID));
    }

    @Test public void rejectsInvalidHeadersAndAudioMetadata() {
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary("bad-header\r\nPath:audio\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary("Path:audio\rContent-Type:audio/mpeg\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:audio/mpeg\r\nPath:audio\r\nX-Bad:\u0001\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:ffffffffffffffffffffffffffffffff\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(binary(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:text/plain\r\nPath:audio\r\n", new byte[] { 1 }), REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseBinary(new byte[] { 0, 2, (byte) 0xc3, 0x28, 1 }, REQUEST_ID));
    }

    @Test public void rejectsMalformedTerminalMessages() {
        assertProtocol(() -> EdgeTtsFrameParser.parseText("Path:turn.end", REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\nPath:turn.end\r\n\r\n{}", REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:unknown\r\n\r\n{}", REQUEST_ID));
        assertProtocol(() -> EdgeTtsFrameParser.parseText(
                "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\n\r\n", REQUEST_ID));
    }

    private static byte[] binary(String headers, byte[] payload) {
        byte[] header = headers.getBytes(StandardCharsets.UTF_8);
        byte[] frame = new byte[2 + header.length + payload.length];
        frame[0] = (byte) (header.length >>> 8);
        frame[1] = (byte) header.length;
        System.arraycopy(header, 0, frame, 2, header.length);
        System.arraycopy(payload, 0, frame, 2 + header.length, payload.length);
        return frame;
    }

    private static String control(String path, String body) {
        return "X-RequestId:" + REQUEST_ID + "\r\nContent-Type:application/json; charset=utf-8\r\nPath:"
                + path + "\r\n\r\n" + body;
    }

    private static void assertStateProtocol(StateAction action) {
        try { action.run(new EdgeTtsProtocolState(REQUEST_ID)); fail("Expected protocol error"); }
        catch (EdgeTtsFrameParser.ProtocolException expected) { assertEquals("PROTOCOL_ERROR", expected.getCode()); }
        catch (Exception wrong) { throw new AssertionError(wrong); }
    }

    private static void assertProtocol(ThrowingRunnable action) {
        try { action.run(); fail("Expected protocol error"); }
        catch (EdgeTtsFrameParser.ProtocolException expected) {
            assertEquals("PROTOCOL_ERROR", expected.getCode());
            assertEquals("TTS protocol error", expected.getMessage());
        }
        catch (Exception wrong) { throw new AssertionError(wrong); }
    }

    private interface ThrowingRunnable { void run() throws Exception; }
    private interface StateAction { void run(EdgeTtsProtocolState state) throws Exception; }
}
