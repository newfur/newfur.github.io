package com.edgereader.app;

import java.lang.ref.WeakReference;

final class PlaybackSessionRegistry {
    interface Receiver { void onMediaAction(String action); }

    private String sessionId;
    private WeakReference<Receiver> receiver = new WeakReference<>(null);

    synchronized void register(String newSessionId, Receiver newReceiver) {
        sessionId = newSessionId;
        receiver = new WeakReference<>(newReceiver);
    }

    synchronized void unregister(String expectedSessionId) {
        if (expectedSessionId != null && expectedSessionId.equals(sessionId)) {
            sessionId = null;
            receiver.clear();
        }
    }

    synchronized boolean deliver(String expectedSessionId, String action) {
        Receiver current = receiver.get();
        if (current == null || expectedSessionId == null || !expectedSessionId.equals(sessionId)) return false;
        current.onMediaAction(action);
        return true;
    }
}
