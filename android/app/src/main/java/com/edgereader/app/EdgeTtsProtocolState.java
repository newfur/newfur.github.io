package com.edgereader.app;

import java.io.ByteArrayOutputStream;

final class EdgeTtsProtocolState {
    private final String requestId;
    private final ByteArrayOutputStream audio = new ByteArrayOutputStream();
    private enum State { WAITING_FOR_START, WAITING_FOR_RESPONSE, RECEIVING_AUDIO, ENDED }
    private State state = State.WAITING_FOR_START;

    EdgeTtsProtocolState(String requestId) { this.requestId = requestId; }

    EdgeTtsFrameParser.Frame acceptText(String message) throws EdgeTtsFrameParser.ProtocolException {
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseText(message, requestId);
        if (frame.kind == EdgeTtsFrameParser.Kind.TURN_START && state == State.WAITING_FOR_START) {
            state = State.WAITING_FOR_RESPONSE;
        } else if (frame.kind == EdgeTtsFrameParser.Kind.RESPONSE && state == State.WAITING_FOR_RESPONSE) {
            state = State.RECEIVING_AUDIO;
        } else if (frame.kind == EdgeTtsFrameParser.Kind.TURN_END && state == State.RECEIVING_AUDIO) {
            state = State.ENDED;
        } else {
            throw new EdgeTtsFrameParser.ProtocolException();
        }
        return frame;
    }

    int acceptBinary(byte[] data) throws EdgeTtsFrameParser.ProtocolException {
        if (state != State.RECEIVING_AUDIO) throw new EdgeTtsFrameParser.ProtocolException();
        EdgeTtsFrameParser.Frame frame = EdgeTtsFrameParser.parseBinary(data, requestId);
        audio.write(frame.payload, 0, frame.payload.length);
        return frame.payload.length;
    }

    byte[] complete() throws NativeBoundaryException {
        if (state != State.ENDED) {
            throw new NativeBoundaryException(audio.size() == 0 ? NativeError.PROTOCOL_ERROR : NativeError.INCOMPLETE_AUDIO);
        }
        if (audio.size() == 0) throw new NativeBoundaryException(NativeError.EMPTY_AUDIO);
        return audio.toByteArray();
    }

    int audioSize() { return audio.size(); }
}
