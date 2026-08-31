package com.edgereader.app;

import java.util.concurrent.atomic.AtomicReference;

final class NativeTtsRequest {
    interface Sink {
        void resolve(String audio);
        void reject(String errorCode, String message);
    }

    private final Sink sink;
    private enum State { PENDING, SUCCEEDED, FAILED, CANCELLED }
    private final AtomicReference<State> state = new AtomicReference<>(State.PENDING);
    private Runnable cancelAction;

    NativeTtsRequest(Sink sink) { this.sink = sink; }

    synchronized void setCancelAction(Runnable action) {
        cancelAction = action;
        if (state.get() == State.CANCELLED) action.run();
    }

    boolean succeed(String audio) {
        if (!state.compareAndSet(State.PENDING, State.SUCCEEDED)) return false;
        sink.resolve(audio);
        return true;
    }

    boolean fail(String code, String message) {
        if (!state.compareAndSet(State.PENDING, State.FAILED)) return false;
        sink.reject(code, message);
        return true;
    }

    boolean cancel() {
        if (!state.compareAndSet(State.PENDING, State.CANCELLED)) return false;
        Runnable action;
        synchronized (this) { action = cancelAction; }
        if (action != null) action.run();
        sink.reject(NativeError.CANCELLED.name(), NativeError.CANCELLED.message());
        return true;
    }

    boolean isCancelled() { return state.get() == State.CANCELLED; }
}
