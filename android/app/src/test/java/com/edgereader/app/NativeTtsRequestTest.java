package com.edgereader.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeTtsRequestTest {
    @Test
    public void cancellationRejectsOriginalRequestOnceAndDropsLaterFailure() {
        RecordingSink sink = new RecordingSink();
        NativeTtsRequest request = new NativeTtsRequest(sink);

        assertTrue(request.cancel());
        assertFalse(request.fail("NETWORK_FAILURE", "TTS connection failed"));
        assertFalse(request.cancel());
        assertEquals(1, sink.calls);
        assertEquals("CANCELLED", sink.code);
    }

    @Test
    public void completionAndFailureAlsoSettleExactlyOnce() {
        RecordingSink success = new RecordingSink();
        NativeTtsRequest successful = new NativeTtsRequest(success);
        assertTrue(successful.succeed("audio"));
        assertFalse(successful.cancel());
        assertEquals(1, success.calls);

        RecordingSink failure = new RecordingSink();
        NativeTtsRequest failed = new NativeTtsRequest(failure);
        assertTrue(failed.fail("NETWORK_FAILURE", "TTS connection failed"));
        assertFalse(failed.succeed("audio"));
        assertEquals(1, failure.calls);
    }

    @Test
    public void protocolFailureRejectsExactlyOnceWithStableError() {
        RecordingSink sink = new RecordingSink();
        NativeTtsRequest request = new NativeTtsRequest(sink);

        assertTrue(request.fail(NativeError.PROTOCOL_ERROR.name(), NativeError.PROTOCOL_ERROR.message()));
        assertFalse(request.fail(NativeError.PROTOCOL_ERROR.name(), NativeError.PROTOCOL_ERROR.message()));
        assertFalse(request.succeed("audio"));
        assertEquals(1, sink.calls);
        assertEquals("PROTOCOL_ERROR", sink.code);
        assertEquals("TTS protocol error", sink.message);
    }

    @Test
    public void cancelActionAttachedAfterCancellationRunsImmediately() {
        RecordingSink sink = new RecordingSink();
        NativeTtsRequest request = new NativeTtsRequest(sink);
        int[] cancellations = { 0 };
        request.cancel();
        request.setCancelAction(() -> cancellations[0]++);
        assertEquals(1, cancellations[0]);
        assertTrue(request.isCancelled());
    }

    @Test
    public void cancelActionAttachedAfterSuccessDoesNotRun() {
        RecordingSink sink = new RecordingSink();
        NativeTtsRequest request = new NativeTtsRequest(sink);
        int[] cancellations = { 0 };
        request.succeed("audio");
        request.setCancelAction(() -> cancellations[0]++);
        assertEquals(0, cancellations[0]);
    }

    private static final class RecordingSink implements NativeTtsRequest.Sink {
        int calls;
        String code;
        String message;
        @Override public void resolve(String audio) { calls++; }
        @Override public void reject(String errorCode, String errorMessage) {
            calls++;
            code = errorCode;
            message = errorMessage;
        }
    }
}
