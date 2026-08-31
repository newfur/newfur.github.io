package com.edgereader.app;

import java.io.ByteArrayOutputStream;

final class EdgeTtsProtocolState {
    private final String requestId;
    private final ByteArrayOutputStream audio = new ByteArrayOutputStream();
    private boolean turnEnded;

    EdgeTtsProtocolState(String requestId) { this.requestId = requestId; }

    EdgeTtsFrameParser.Frame acceptText(String message) throws EdgeTtsFrameParser.ProtocolException {
        if (turnEnded) throw new EdgeTtsFrameParser.ProtocolException();
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseText(message, requestId);
        if (frame.kind == EdgeTtsFrameParser.Kind.TURN_END) turnEnded = true;
        return frame;
    }

    int acceptBinary(byte[] data) throws EdgeTtsFrameParser.ProtocolException {
        if (turnEnded) throw new EdgeTtsFrameParser.ProtocolException();
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseBinary(data, requestId);
        audio.write(frame.payload, 0, frame.payload.length);
        return frame.payload.length;
    }

    byte[] complete() throws NativeBoundaryException {
        if (!turnEnded) {
            throw new NativeBoundaryException(audio.size() == 0 ? NativeError.PROTOCOL_ERROR : NativeError.INCOMPLETE_AUDIO);
        }
        if (audio.size() == 0) throw new NativeBoundaryException(NativeError.EMPTY_AUDIO);
        return audio.toByteArray();
    }

    int audioSize() { return audio.size(); }
}
