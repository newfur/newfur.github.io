package com.edgereader.app;

final class ForegroundStartSequence {
    private ForegroundStartSequence() {}

    static void run(Runnable promoteForeground, Runnable decodeCover, Runnable updateMetadata) {
        promoteForeground.run();
        decodeCover.run();
        updateMetadata.run();
    }
}
